import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import {
  findJsonlFiles,
  parseJsonl,
  readFileSafe,
} from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "pi-coding-agent";
const TOOL_NAME = "pi";
const DEFAULT_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

interface PiUsage {
  input?: number;
  inputTokens?: number;
  output?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheReadTokens?: number;
  cache_read?: number;
  cacheWrite?: number;
  cacheWriteTokens?: number;
  cache_write?: number;
  reasoningOutputTokens?: number;
  thinkingTokens?: number;
  thoughts?: number;
}

interface PiEvent {
  type?: string;
  id?: string;
  timestamp?: string | number;
  cwd?: string;
  usage?: PiUsage;
  summary?: unknown;
  message?: {
    role?: string;
    timestamp?: string | number;
    model?: string;
    responseModel?: string;
    provider?: string;
    responseId?: string;
    api?: string;
    toolCallId?: string;
    toolName?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: unknown;
    usage?: PiUsage;
  };
}

function createToolDefinition(dataDir: string): ToolDefinition {
  return {
    id: TOOL_ID,
    name: TOOL_NAME,
    dataDir,
  };
}

function toSafeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? Math.trunc(numberValue)
    : 0;
}

function getPathLeaf(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = normalized.split("/").filter(Boolean).pop();
  return leaf || "unknown";
}

function normalizeForPrefix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getUsageNumber(usage: PiUsage, ...keys: Array<keyof PiUsage>): number {
  for (const key of keys) {
    const value = usage[key];
    if (value !== undefined && value !== null) {
      return toSafeNumber(value);
    }
  }

  return 0;
}

function parseTimestamp(value: string | number | undefined): Date | null {
  if (value === undefined) return null;
  const timestamp = new Date(
    typeof value === "number" && Math.abs(value) <= 100_000_000_000
      ? value * 1000
      : value,
  );
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function usageIdentity(row: PiEvent, kind: string, usage: PiUsage) {
  const message = row.message;
  const semantic = createHash("sha256")
    .update(
      canonicalJson({
        kind,
        timestamp: row.timestamp,
        messageTimestamp: message?.timestamp,
        provider: message?.provider,
        model: message?.model,
        responseModel: message?.responseModel,
        responseId: message?.responseId,
        api: message?.api,
        toolCallId: message?.toolCallId,
        toolName: message?.toolName,
        stopReason: message?.stopReason,
        errorMessage: message?.errorMessage,
        content: message?.content,
        summary: row.summary,
        usage,
      }),
    )
    .digest("hex");
  return {
    semantic,
    request: row.id ? JSON.stringify([kind, row.id, row.timestamp]) : semantic,
    hasId: Boolean(row.id),
  };
}

export function extractPiProjectFromCwd(cwd: string): string {
  return getPathLeaf(cwd);
}

export function extractPiProjectFromDir(
  filePath: string,
  sessionsDir = DEFAULT_SESSIONS_DIR,
): string {
  const normalizedFilePath = normalizeForPrefix(filePath);
  const normalizedSessionsDir = normalizeForPrefix(sessionsDir);
  const prefix = `${normalizedSessionsDir}/`;

  if (!normalizedFilePath.startsWith(prefix)) {
    return "unknown";
  }

  const relativePath = normalizedFilePath.slice(prefix.length);
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) {
    return "unknown";
  }

  try {
    const decoded = decodeURIComponent(firstSegment);
    if (decoded.includes("/") || decoded.includes("\\")) {
      return getPathLeaf(decoded);
    }
  } catch {
    // Fall back to slug parsing when the segment is not URI-encoded.
  }

  const slugParts = firstSegment.split("-").filter(Boolean);
  return slugParts.length > 0 ? slugParts[slugParts.length - 1] : "unknown";
}

export class PiCodingAgentParser implements IParser {
  readonly tool: ToolDefinition;

  constructor(private readonly sessionsDir = DEFAULT_SESSIONS_DIR) {
    this.tool = createToolDefinition(sessionsDir);
  }

  async parse(): Promise<ParseResult> {
    const sessionFiles = findJsonlFiles(this.sessionsDir);
    if (sessionFiles.length === 0) {
      return { buckets: [], sessions: [] };
    }

    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];
    const seenRequests = new Set<string>();
    const seenSemantics = new Set<string>();
    const legacySemantics = new Set<string>();

    for (const filePath of sessionFiles) {
      const content = readFileSafe(filePath);
      if (!content) continue;

      const rows = parseJsonl<PiEvent>(content);
      if (rows.length === 0) continue;

      let sessionId = filePath;
      let project = extractPiProjectFromDir(filePath, this.sessionsDir);
      let sessionTimestamp: Date | null = null;

      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        if (row.type !== "session") continue;
        if (row.id) {
          sessionId = row.id;
        }
        if (row.cwd) {
          project = extractPiProjectFromCwd(row.cwd);
        }
        sessionTimestamp = parseTimestamp(row.timestamp);
        break;
      }

      let fallbackTimestamp = sessionTimestamp;
      if (!fallbackTimestamp) {
        try {
          fallbackTimestamp = statSync(filePath).mtime;
        } catch {
          // 扫描途中被删除的文件只能使用行内时间，不能伪造当前时间。
        }
      }
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const message = row.message;
        const timestamp =
          parseTimestamp(row.timestamp) ??
          parseTimestamp(message?.timestamp) ??
          fallbackTimestamp;
        if (!timestamp) continue;
        if (row.type === "message" && message?.role === "user") {
          sessionEvents.push({
            sessionId,
            source: TOOL_ID,
            project,
            timestamp,
            role: "user",
          });
          continue;
        }
        const kind = row.type === "message" ? message?.role : row.type;
        if (
          kind !== "assistant" &&
          kind !== "toolResult" &&
          kind !== "compaction" &&
          kind !== "branch_summary"
        )
          continue;
        const usage = row.type === "message" ? message?.usage : row.usage;
        if (!usage) {
          if (kind === "assistant")
            sessionEvents.push({
              sessionId,
              source: TOOL_ID,
              project,
              timestamp,
              role: "assistant",
            });
          continue;
        }

        const inputTokens = getUsageNumber(usage, "input", "inputTokens");
        const rawOutput = getUsageNumber(usage, "output", "outputTokens");
        const cachedTokens = getUsageNumber(
          usage,
          "cacheRead",
          "cacheReadTokens",
          "cache_read",
        );
        const cacheCreationTokens = getUsageNumber(
          usage,
          "cacheWrite",
          "cacheWriteTokens",
          "cache_write",
        );
        const reasoningTokens = Math.min(
          rawOutput,
          getUsageNumber(
            usage,
            "reasoningOutputTokens",
            "thinkingTokens",
            "thoughts",
          ),
        );
        const outputTokens = rawOutput - reasoningTokens;

        if (
          inputTokens === 0 &&
          outputTokens === 0 &&
          cachedTokens === 0 &&
          cacheCreationTokens === 0 &&
          reasoningTokens === 0
        ) {
          if (kind === "assistant")
            sessionEvents.push({
              sessionId,
              source: TOOL_ID,
              project,
              timestamp,
              role: "assistant",
            });
          continue;
        }

        // 分叉会话会复制 entry；仅按裸 ID 会误丢同 ID 不同时间的真实请求。
        // 无 ID 的旧格式用语义指纹去重，有不同稳定 ID 的相同用量保留两笔。
        const identity = usageIdentity(row, kind, usage);
        if (
          seenRequests.has(identity.request) ||
          (identity.hasId ? legacySemantics : seenSemantics).has(
            identity.semantic,
          )
        )
          continue;
        seenRequests.add(identity.request);
        seenSemantics.add(identity.semantic);
        if (!identity.hasId) legacySemantics.add(identity.semantic);
        sessionEvents.push({
          sessionId,
          source: TOOL_ID,
          project,
          timestamp,
          role: "assistant",
        });

        entries.push({
          sessionId,
          source: TOOL_ID,
          model:
            kind === "assistant"
              ? message?.responseModel || message?.model || "unknown"
              : "unknown",
          project,
          timestamp,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          cacheCreationTokens,
        });
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.sessionsDir);
  }
}

registerParser(new PiCodingAgentParser());
