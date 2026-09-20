import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { readFileSafe } from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "grok-build";
const TOOL_NAME = "Grok Build";
const DEFAULT_DATA_DIR = join(homedir(), ".grok", "sessions");
const DEFAULT_ARCHIVE_DIR = join(homedir(), ".grok", "archived_sessions");

/**
 * Grok Build (grok TUI) session storage:
 *   ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/updates.jsonl
 *   ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/summary.json
 *   ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/events.jsonl
 *
 * Token usage lives on `sessionUpdate: "turn_completed"` records inside
 * updates.jsonl (methods: `session/update` or `_x.ai/session/update`):
 *   usage.inputTokens / outputTokens / cachedReadTokens / reasoningTokens
 *   usage.modelUsage[modelId] — per-model breakdown when present
 *
 * Note: `inputTokens` already includes cache reads; `outputTokens` already
 * includes reasoning — we subtract to match TokenArena's non-overlapping
 * token categories.
 */

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

export function projectFromEncodedCwd(encoded: string): string {
  try {
    const decoded = decodeURIComponent(encoded);
    const leaf = basename(decoded.replace(/[\\/]+$/, ""));
    return leaf || "unknown";
  } catch {
    const leaf = basename(encoded);
    return leaf || "unknown";
  }
}

function resolveTimestamp(obj: {
  timestamp?: number | string;
  params?: { update?: { _meta?: { agentTimestampMs?: number } } };
  _meta?: { agentTimestampMs?: number };
}): Date | null {
  const ms =
    obj._meta?.agentTimestampMs ?? obj.params?.update?._meta?.agentTimestampMs;
  if (typeof ms === "number" && Number.isFinite(ms)) {
    const timestamp = new Date(ms);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  const raw = obj.timestamp;
  if (raw == null) return null;
  if (typeof raw === "number") {
    // Grok uses unix seconds for top-level timestamp
    const timestamp = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }
  const ts = new Date(raw);
  return Number.isNaN(ts.getTime()) ? null : ts;
}

interface GrokModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  apiDurationMs?: number;
}

interface GrokTurnUsage extends GrokModelUsage {
  modelUsage?: Record<string, GrokModelUsage>;
  numTurns?: number;
}

function pushUsageEntries(
  entries: Map<string, TokenUsageEntry[]>,
  args: {
    eventKey: string;
    sessionId: string;
    project: string;
    timestamp: Date;
    usage: GrokTurnUsage;
    fallbackModel: string;
  },
): void {
  const { eventKey, sessionId, project, timestamp, usage, fallbackModel } =
    args;
  const modelUsage = usage.modelUsage;

  const models =
    modelUsage && Object.keys(modelUsage).length > 0
      ? Object.entries(modelUsage)
      : ([[fallbackModel, usage]] as Array<[string, GrokModelUsage]>);

  const modelEntries: TokenUsageEntry[] = [];
  for (const [model, mu] of models) {
    if (!mu || typeof mu !== "object") continue;
    const cached = toSafeNumber(mu.cachedReadTokens);
    const rawInput = toSafeNumber(mu.inputTokens);
    const rawOutput = toSafeNumber(mu.outputTokens);
    const reasoning = Math.min(rawOutput, toSafeNumber(mu.reasoningTokens));
    const inputTokens = Math.max(0, rawInput - cached);
    const outputTokens = Math.max(0, rawOutput - reasoning);

    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cached === 0 &&
      reasoning === 0
    ) {
      continue;
    }

    modelEntries.push({
      sessionId,
      source: TOOL_ID,
      model: model || fallbackModel || "unknown",
      project,
      timestamp,
      inputTokens,
      outputTokens,
      reasoningTokens: reasoning,
      cachedTokens: cached,
    });
  }
  // 重放完整快照时整体替换，不能留下旧快照中已消失的模型条目。
  entries.set(eventKey, modelEntries);
}

function findSessionDirs(dataDir: string): Array<{
  sessionDir: string;
  project: string;
  sessionId: string;
}> {
  const results: Array<{
    sessionDir: string;
    project: string;
    sessionId: string;
  }> = [];
  if (!existsSync(dataDir)) return results;

  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const projectEntry of projectDirs) {
    if (!projectEntry.isDirectory()) continue;
    // Skip sqlite / non-session artifacts at the sessions root
    if (projectEntry.name.endsWith(".sqlite")) continue;

    const projectDir = join(dataDir, projectEntry.name);
    const project = projectFromEncodedCwd(projectEntry.name);

    let sessionEntries: import("node:fs").Dirent[];
    try {
      sessionEntries = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = join(projectDir, sessionEntry.name);
      if (!existsSync(join(sessionDir, "updates.jsonl"))) continue;
      results.push({
        sessionDir,
        project,
        sessionId: sessionEntry.name,
      });
    }
  }

  return results;
}

function readFallbackModel(sessionDir: string): string {
  const summaryPath = join(sessionDir, "summary.json");
  const content = readFileSafe(summaryPath);
  if (!content) return "unknown";
  try {
    const summary = JSON.parse(content) as { current_model_id?: string };
    return summary.current_model_id || "unknown";
  } catch {
    return "unknown";
  }
}

export class GrokBuildParser implements IParser {
  readonly tool: ToolDefinition;

  constructor(
    private readonly dataDir = DEFAULT_DATA_DIR,
    private readonly archiveDir = dataDir === DEFAULT_DATA_DIR
      ? DEFAULT_ARCHIVE_DIR
      : undefined,
  ) {
    this.tool = createToolDefinition(dataDir);
  }

  async parse(): Promise<ParseResult> {
    const entries = new Map<string, TokenUsageEntry[]>();
    const sessionEvents = new Map<string, SessionEvent>();
    const sessions = [
      ...(this.archiveDir ? findSessionDirs(this.archiveDir) : []),
      ...findSessionDirs(this.dataDir),
    ];

    for (const { sessionDir, project, sessionId } of sessions) {
      const updatesPath = join(sessionDir, "updates.jsonl");
      const content = readFileSafe(updatesPath);
      if (!content) continue;

      const fallbackModel = readFallbackModel(sessionDir);
      // Streaming user chunks share a promptId — count once per prompt.
      const seenUserPrompts = new Set<string>();
      const ANON_USER_OPEN = "__anon_user_open";

      for (const [lineNumber, line] of content.split("\n").entries()) {
        if (!line.trim()) continue;
        let obj: {
          method?: string;
          timestamp?: number | string;
          params?: {
            sessionId?: string;
            update?: {
              sessionUpdate?: string;
              prompt_id?: string;
              stop_reason?: string;
              usage?: GrokTurnUsage;
              model_id?: string;
              content?: unknown;
              _meta?: {
                agentTimestampMs?: number;
                promptId?: string;
                updateType?: string;
              };
            };
          };
          _meta?: { agentTimestampMs?: number };
        };
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== "object") continue;

        if (
          obj.method !== "session/update" &&
          obj.method !== "_x.ai/session/update"
        )
          continue;
        const update = obj.params?.update;
        if (!update) continue;

        const ts = resolveTimestamp(obj);
        if (!ts) continue;

        const sid = obj.params?.sessionId || sessionId;
        const updateType = update.sessionUpdate;
        const promptId = update.prompt_id || update._meta?.promptId || null;

        if (updateType === "user_message_chunk") {
          const key = promptId ?? ANON_USER_OPEN;
          if (seenUserPrompts.has(key)) continue;
          seenUserPrompts.add(key);

          sessionEvents.set(
            JSON.stringify([
              sid,
              "user",
              key,
              promptId ? null : ts.toISOString(),
            ]),
            {
              sessionId: sid,
              source: TOOL_ID,
              project,
              timestamp: ts,
              role: "user",
            },
          );
          continue;
        }

        // turn_completed is the authoritative assistant boundary + usage source.
        // Skip agent_message_chunk to avoid double-counting streaming deltas.
        if (updateType && updateType !== "turn_completed") continue;
        if (!updateType && !update.usage) continue;

        seenUserPrompts.delete(ANON_USER_OPEN);

        // prompt_id 标识一次独立调用；归档副本和重放快照只保留一份最新用量。
        // 无稳定 prompt ID 时，时间戳不足以区分同秒多轮；保守保留独立事件。
        const eventKey = promptId
          ? JSON.stringify([sid, promptId])
          : JSON.stringify([sid, "anonymous", updatesPath, lineNumber]);
        if (
          (sessionEvents.get(eventKey)?.timestamp.getTime() ?? -Infinity) >
          ts.getTime()
        )
          continue;
        sessionEvents.set(eventKey, {
          sessionId: sid,
          source: TOOL_ID,
          project,
          timestamp: ts,
          role: "assistant",
        });

        const usage = update.usage;
        if (!usage) continue;

        pushUsageEntries(entries, {
          eventKey,
          sessionId: sid,
          project,
          timestamp: ts,
          usage,
          fallbackModel: update.model_id || fallbackModel,
        });
      }
    }

    const usageEntries = [...entries.values()].flat();
    return {
      buckets: aggregateToBuckets(usageEntries),
      sessions: extractSessions([...sessionEvents.values()], usageEntries),
    };
  }

  isInstalled(): boolean {
    return (
      existsSync(this.dataDir) ||
      Boolean(this.archiveDir && existsSync(this.archiveDir)) ||
      existsSync(join(homedir(), ".grok")) ||
      existsSync(join(homedir(), ".local", "bin", "grok"))
    );
  }
}

registerParser(new GrokBuildParser());
