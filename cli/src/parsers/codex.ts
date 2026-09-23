import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { findJsonlFiles, readFileSafe } from "../infrastructure/fs/utils";
import { logger } from "../utils/logger";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "codex";
const DEFAULT_DATA_DIR = join(homedir(), ".codex", "sessions");
const DEFAULT_ARCHIVE_DIR = join(homedir(), ".codex", "archived_sessions");

interface Usage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  reportedTotal: number | null;
}

interface CodexEvent {
  type: string;
  ordinal?: number;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    thread_id?: string;
    threadId?: string;
    forked_from_id?: string;
    forked_from_ordinal_exclusive?: number;
    source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } };
    model?: string;
    cwd?: string;
    git?: { repository_url?: string };
    rate_limits?: { limit_id?: string };
    info?: {
      model?: string;
      model_name?: string;
      last_token_usage?: unknown;
      total_token_usage?: unknown;
    };
  };
}

interface TokenEvent {
  line: number;
  timestamp: Date | null;
  timestampOrder: bigint | null;
  model: string;
  signature: string;
  snapshotSource: string;
  total: Usage | null;
  last: Usage | null;
}

interface Rollout {
  path: string;
  sessionId: string;
  threadId: string | null;
  project: string;
  parentId: string | null;
  parentConflict: boolean;
  forkOrdinalExclusive: number | null;
  maxOrdinal: number | null;
  rootTimestampOrder: bigint | null;
  latestTimestampOrder: bigint;
  minLineTimestampOrder: bigint | null;
  tokens: TokenEvent[];
  prompts: Array<{ line: number; timestamp: Date; timestampOrder: bigint }>;
}

interface Thread {
  files: Rollout[];
  timeline: TokenEvent[];
  latestTimestampOrder: bigint;
  minLineTimestampOrder: bigint | null;
  invalidTokenTimestamp: boolean;
  status: "new" | "visiting" | "done" | "deferred";
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function readUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const names = [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  // 空对象不能遮蔽有效累计值，也不能被当成全零快照参与去重。
  if (!names.some((name) => Object.hasOwn(fields, name))) return null;
  return {
    input: safeCount(fields.input_tokens),
    output: safeCount(fields.output_tokens),
    cached: safeCount(
      fields.cached_input_tokens ?? fields.cache_read_input_tokens,
    ),
    reasoning: safeCount(fields.reasoning_output_tokens),
    reportedTotal:
      typeof fields.total_tokens === "number"
        ? safeCount(fields.total_tokens)
        : null,
  };
}

function readTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestampOrder(value: unknown, timestamp: Date | null): bigint | null {
  if (!timestamp) return null;
  // Date 截断到毫秒；fork 截止点必须保留 Codex 日志中的纳秒精度。
  const fraction =
    typeof value === "string"
      ? (value.match(/\.(\d+)(?:z|[+-]\d{2}:?\d{2})?$/i)?.[1] ?? "")
      : "";
  const remainder = fraction.slice(3, 9).padEnd(6, "0");
  return BigInt(timestamp.getTime()) * 1_000_000n + BigInt(remainder);
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function filenameThreadId(path: string): string | null {
  return (
    basename(path).match(
      /([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/i,
    )?.[1] ?? null
  );
}

export function resolveCodexProject(payload?: CodexEvent["payload"]): string {
  const repositoryUrl = payload?.git?.repository_url;
  if (typeof repositoryUrl === "string" && repositoryUrl) {
    const match = repositoryUrl.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  const normalized =
    typeof payload?.cwd === "string"
      ? payload.cwd.replace(/\\/g, "/").replace(/\/+$/, "")
      : "";
  return normalized?.split("/").filter(Boolean).pop() || "unknown";
}

function readRollout(path: string): Rollout | null {
  const content = readFileSafe(path);
  if (!content) return null;
  const tokens: TokenEvent[] = [];
  const prompts: Rollout["prompts"] = [];
  let rootMeta: CodexEvent | null = null;
  let model = "unknown";
  let latestTimestampOrder = 0n;
  let minLineTimestampOrder: bigint | null = null;
  let line = 0;
  let maxOrdinal: number | null = null;
  for (const text of content.split("\n")) {
    line++;
    if (!text.trim()) continue;
    try {
      const event = JSON.parse(text) as CodexEvent;
      if (
        typeof event.ordinal === "number" &&
        Number.isSafeInteger(event.ordinal) &&
        event.ordinal >= 0 &&
        (maxOrdinal === null || event.ordinal > maxOrdinal)
      ) {
        maxOrdinal = event.ordinal;
      }
      const timestamp = readTimestamp(event.timestamp);
      const order = timestampOrder(event.timestamp, timestamp);
      if (order !== null) {
        if (order > latestTimestampOrder) latestTimestampOrder = order;
        if (minLineTimestampOrder === null || order < minLineTimestampOrder)
          minLineTimestampOrder = order;
      }
      if (event.type === "session_meta" && !rootMeta) rootMeta = event;
      if (event.type === "turn_context") {
        model =
          readId(event.payload?.model) ||
          readId(event.payload?.info?.model) ||
          model;
        if (timestamp && order !== null)
          prompts.push({ line, timestamp, timestampOrder: order });
      }
      if (event.type !== "event_msg" || event.payload?.type !== "token_count")
        continue;
      const info = event.payload.info;
      if (!info) continue;
      const total = readUsage(info.total_token_usage);
      const last = readUsage(info.last_token_usage);
      if (!total && !last) continue;
      model =
        readId(info.model) ||
        readId(info.model_name) ||
        readId(event.payload.model) ||
        model;
      tokens.push({
        line,
        timestamp,
        timestampOrder: order,
        model,
        total,
        last,
        signature: JSON.stringify([total, last]),
        snapshotSource: readId(event.payload.rate_limits?.limit_id) || "",
      });
    } catch {
      // 活跃日志的末行可能尚未写完；其他损坏行也不会阻塞后续记录。
    }
  }
  const meta = rootMeta?.payload;
  const threadId =
    readId(meta?.id) || readId(meta?.thread_id) || readId(meta?.threadId);
  const forkedFrom = readId(meta?.forked_from_id);
  const spawnedFrom = readId(
    meta?.source?.subagent?.thread_spawn?.parent_thread_id,
  );
  return {
    path,
    threadId,
    sessionId: threadId ? `codex:${threadId}` : `codex-file:${path}`,
    project: resolveCodexProject(meta),
    parentId: forkedFrom || spawnedFrom,
    parentConflict: Boolean(
      forkedFrom && spawnedFrom && forkedFrom !== spawnedFrom,
    ),
    forkOrdinalExclusive:
      typeof meta?.forked_from_ordinal_exclusive === "number" &&
      Number.isSafeInteger(meta.forked_from_ordinal_exclusive) &&
      meta.forked_from_ordinal_exclusive > 0
        ? meta.forked_from_ordinal_exclusive
        : null,
    maxOrdinal,
    rootTimestampOrder: timestampOrder(
      rootMeta?.timestamp,
      readTimestamp(rootMeta?.timestamp),
    ),
    latestTimestampOrder,
    minLineTimestampOrder,
    tokens,
    prompts,
  };
}

function matchingReplayPrefix(
  tokens: TokenEvent[],
  history: TokenEvent[],
): number {
  let offset = 0;
  let matched = 0;
  // 子线程可能只复制父历史的一个子序列；首次不匹配后全部视为新事件。
  for (const token of tokens) {
    while (
      offset < history.length &&
      (history[offset].signature !== token.signature ||
        // 缺少累计值时，相同用量不能证明回放；还必须对应同一时刻和模型。
        (!token.total &&
          (token.timestampOrder === null ||
            token.timestampOrder !== history[offset].timestampOrder ||
            token.model !== history[offset].model)))
    )
      offset++;
    if (offset === history.length) break;
    offset++;
    matched++;
  }
  return matched;
}

function usageDelta(current: Usage, previous: Usage | null): Usage {
  return {
    input: Math.max(0, current.input - (previous?.input ?? 0)),
    output: Math.max(0, current.output - (previous?.output ?? 0)),
    cached: Math.max(0, current.cached - (previous?.cached ?? 0)),
    reasoning: Math.max(0, current.reasoning - (previous?.reasoning ?? 0)),
    reportedTotal: null,
  };
}

function highWater(previous: Usage | null, current: Usage): Usage {
  return {
    input: Math.max(previous?.input ?? 0, current.input),
    output: Math.max(previous?.output ?? 0, current.output),
    cached: Math.max(previous?.cached ?? 0, current.cached),
    reasoning: Math.max(previous?.reasoning ?? 0, current.reasoning),
    reportedTotal: null,
  };
}

export class CodexParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly dataDirs: string[];

  constructor(
    dataDir = DEFAULT_DATA_DIR,
    archiveDir = dataDir === DEFAULT_DATA_DIR ? DEFAULT_ARCHIVE_DIR : undefined,
  ) {
    this.dataDirs = archiveDir ? [dataDir, archiveDir] : [dataDir];
    this.tool = { id: TOOL_ID, name: "Codex CLI", dataDir };
  }

  isInstalled(): boolean {
    return this.dataDirs.some((directory) => existsSync(directory));
  }

  /** The same list `parse()` reads, so the two can never drift apart. */
  listSourceFiles(): string[] {
    return [...new Set(this.dataDirs.flatMap(findJsonlFiles))].sort();
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];
    const threads = new Map<string, Thread>();
    const threadIndex = new Map<string, Thread>();
    const files = this.listSourceFiles();
    for (const path of files) {
      const file = readRollout(path);
      if (!file) continue;
      let thread = threads.get(file.sessionId);
      if (!thread) {
        thread = {
          files: [],
          timeline: [],
          latestTimestampOrder: 0n,
          minLineTimestampOrder: null,
          invalidTokenTimestamp: false,
          status: "new",
        };
        threads.set(file.sessionId, thread);
      }
      thread.files.push(file);
      if (file.latestTimestampOrder > thread.latestTimestampOrder)
        thread.latestTimestampOrder = file.latestTimestampOrder;
      if (
        file.minLineTimestampOrder !== null &&
        (thread.minLineTimestampOrder === null ||
          file.minLineTimestampOrder < thread.minLineTimestampOrder)
      )
        thread.minLineTimestampOrder = file.minLineTimestampOrder;
      thread.invalidTokenTimestamp ||= file.tokens.some(
        (token) => !token.timestamp,
      );
      if (file.threadId) threadIndex.set(file.threadId, thread);
      const rolloutId = filenameThreadId(path);
      if (rolloutId) threadIndex.set(rolloutId, thread);
    }

    const processThread = (thread: Thread): boolean => {
      if (thread.status !== "new") return thread.status === "done";
      thread.status = "visiting";
      const threadEntries: TokenUsageEntry[] = [];
      const threadEvents: SessionEvent[] = [];
      let cumulative: Usage | null = null;
      const eventKeys = new Set<string>();
      thread.files.sort((left, right) => {
        const firstTime = (file: Rollout) =>
          file.tokens.find((token) => token.timestampOrder !== null)
            ?.timestampOrder ??
          file.rootTimestampOrder ??
          0n;
        const leftTime = firstTime(left);
        const rightTime = firstTime(right);
        return leftTime < rightTime
          ? -1
          : leftTime > rightTime
            ? 1
            : left.path.localeCompare(right.path);
      });

      for (const file of thread.files) {
        let parentPrefix = 0;
        if (file.parentConflict || file.parentId) {
          const parent = file.parentId
            ? threadIndex.get(file.parentId)
            : undefined;
          const cutoff = file.rootTimestampOrder;
          // fork 在父会话写入 session_meta 的瞬间发生，父文件此后不会再有
          // 早于该时刻的增量事件；但时间戳精度（父为整毫秒、fork meta 含
          // 亚毫秒）会让父最大时间戳显得略早于截止点。fork 元数据带有
          // forked_from_ordinal_exclusive 时，按父线程记录的 ordinal
          // 核验覆盖范围；ordinal 允许跳号，也可能分布在多个 rollout 文件。
          // 旧格式日志没有 ordinal 时回退到时间戳容差（1 秒）。
          const parentMaxOrdinal = parent
            ? parent.files.reduce<number | null>(
                (max, rollout) =>
                  rollout.maxOrdinal !== null &&
                  (max === null || rollout.maxOrdinal > max)
                    ? rollout.maxOrdinal
                    : max,
                null,
              )
            : null;
          const coverageOk = parent
            ? file.forkOrdinalExclusive !== null && parentMaxOrdinal !== null
              ? parentMaxOrdinal >= file.forkOrdinalExclusive - 1
              : cutoff !== null &&
                // 父最大时间戳落后不超过 1 秒，或父内容完全早于截止点
                // 且父最早行时间戳也早于截止点（父在截止前已停止写入）。
                (parent.latestTimestampOrder >= cutoff - 1_000_000n ||
                  (parent.minLineTimestampOrder !== null &&
                    parent.minLineTimestampOrder < cutoff))
            : false;
          if (
            file.parentConflict ||
            !parent ||
            parent === thread ||
            cutoff === null ||
            !processThread(parent) ||
            parent.invalidTokenTimestamp ||
            !coverageOk
          ) {
            logger.warn(
              "Codex fork replay could not be verified; skipping " +
                basename(file.path),
            );
            thread.status = "deferred";
            return false;
          }
          parentPrefix = matchingReplayPrefix(
            file.tokens,
            parent.timeline.filter(
              (token) =>
                token.timestampOrder !== null && token.timestampOrder <= cutoff,
            ),
          );
        }

        // 同一逻辑线程的新 rollout 才可能重放旧文件；缺少身份的文件互不去重。
        const ownPrefix = matchingReplayPrefix(file.tokens, thread.timeline);
        const replayPrefix = Math.max(parentPrefix, ownPrefix);
        const replayEndLine = file.tokens[replayPrefix - 1]?.line ?? -1;
        const snapshots = new Map<string, string>();
        const lastOnlyEvents = new Set<string>();
        let previousSignature: string | null = null;
        const addEvent = (
          timestamp: Date,
          order: bigint,
          role: SessionEvent["role"],
        ) => {
          const key = `${role}|${order.toString()}`;
          if (eventKeys.has(key)) return;
          eventKeys.add(key);
          threadEvents.push({
            sessionId: file.sessionId,
            source: TOOL_ID,
            project: file.project,
            timestamp,
            role,
          });
        };
        for (const prompt of file.prompts) {
          if (prompt.line > replayEndLine)
            addEvent(prompt.timestamp, prompt.timestampOrder, "user");
        }

        for (const [index, token] of file.tokens.entries()) {
          if (!token.timestamp || token.timestampOrder === null) continue;
          const duplicate = token.total
            ? snapshots.get(token.snapshotSource) === token.signature ||
              previousSignature === token.signature
            : lastOnlyEvents.has(
                token.model +
                  "|" +
                  token.timestampOrder.toString() +
                  "|" +
                  token.signature,
              );
          if (token.total) snapshots.set(token.snapshotSource, token.signature);
          else
            lastOnlyEvents.add(
              token.model +
                "|" +
                token.timestampOrder.toString() +
                "|" +
                token.signature,
            );
          previousSignature = token.signature;

          const usage =
            token.last ??
            (token.total ? usageDelta(token.total, cumulative) : null);
          // 累计值贯穿模型和限额来源；有 last 时仍推进高水位，重放也不例外。
          if (token.total) cumulative = highWater(cumulative, token.total);
          if (!usage || duplicate || index < replayPrefix) continue;
          addEvent(token.timestamp, token.timestampOrder, "assistant");
          const cachedTokens = Math.min(usage.cached, usage.input);
          const reasoningTokens = Math.min(usage.reasoning, usage.output);
          if (usage.input === 0 && usage.output === 0) continue;
          threadEntries.push({
            sessionId: file.sessionId,
            source: TOOL_ID,
            model: token.model,
            project: file.project,
            timestamp: token.timestamp,
            inputTokens: usage.input - cachedTokens,
            outputTokens: usage.output - reasoningTokens,
            reasoningTokens,
            cachedTokens,
          });
        }
        for (let index = ownPrefix; index < file.tokens.length; index++)
          thread.timeline.push(file.tokens[index]);
      }
      for (const entry of threadEntries) entries.push(entry);
      for (const event of threadEvents) sessionEvents.push(event);
      thread.status = "done";
      return true;
    };

    let incomplete = false;
    for (const thread of threads.values()) {
      if (!processThread(thread)) incomplete = true;
    }
    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
      ...(incomplete ? { incomplete: true } : {}),
    };
  }
}

registerParser(new CodexParser());
