import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const TOOL_ID = "muse";
const TOOL_NAME = "Muse";
const EXPORT_FILE_NAME = "token-usage.jsonl";
const DEFAULT_MODEL = "muse-spark";
const PROJECT_LABEL = "Muse";

/**
 * Where the Muse usage export lives.
 *
 * Muse is a hosted agent service: it leaves no token-usage logs on the
 * user's own machine for a parser to scan. Instead the Muse agent
 * periodically exports its per-message usage records — counts only, with
 * ids hashed — to a JSONL file, and this parser reads that file like any
 * other tool's local logs. `MUSE_USAGE_DIR` overrides the export
 * directory, mirroring the `MINIMAX_DATA_DIR` / `CLAUDE_CONFIG_DIR`
 * precedents.
 */
export function getMuseExportPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir =
    env.MUSE_USAGE_DIR?.trim() || join(homedir(), ".local", "share", "muse");
  return join(dir, EXPORT_FILE_NAME);
}

/** One line of the Muse usage export: a single attributed message. */
export interface MuseUsageRecord {
  /** Call time, epoch seconds. */
  ts: number;
  messageId: string;
  /** Root session the call belongs to; subagent calls roll up to it. */
  sessionId: string;
  /** The agent that made the call; input sequences are tracked per agent. */
  agentId: string;
  model?: string;
  /** Full prompt size of the call, as reported by Muse. */
  inputTokens: number;
  outputTokens: number;
}

function tokenCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Validate one parsed JSONL value; returns null for anything unusable. */
export function parseMuseRecord(value: unknown): MuseUsageRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const ts = Number(raw.ts);
  const inputTokens = tokenCount(raw.inputTokens);
  const outputTokens = tokenCount(raw.outputTokens);
  const messageId = typeof raw.messageId === "string" ? raw.messageId : "";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (inputTokens === null || outputTokens === null) return null;
  if (!messageId || !sessionId || !agentId) return null;
  const model =
    typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim()
      : undefined;
  return {
    ts,
    messageId,
    sessionId,
    agentId,
    model,
    inputTokens,
    outputTokens,
  };
}

/**
 * Convert export records into usage entries.
 *
 * Muse reports each call's *full* prompt as its input count, while
 * TokenArena's `inputTokens` means fresh, uncached input. Within one
 * agent's sequence, the growth over the previous call is fresh input and
 * the carried-over remainder is treated as cache reads, so every record
 * still partitions exactly: fresh + cached = the reported input. A drop
 * (context compaction, a fresh segment) counts the whole call as fresh.
 * Reasoning and cache creation are not reported by Muse and stay 0,
 * per the no-fabrication rule in docs/usage-reconciliation.md.
 *
 * Duplicate message ids keep the first record: the export is a snapshot
 * of an append-only ledger, so a repeated id is the same call re-exported.
 */
export function museRecordsToEntries(
  records: MuseUsageRecord[],
): TokenUsageEntry[] {
  const seen = new Set<string>();
  const byAgent = new Map<string, MuseUsageRecord[]>();
  for (const record of records) {
    if (seen.has(record.messageId)) continue;
    seen.add(record.messageId);
    const list = byAgent.get(record.agentId) ?? [];
    list.push(record);
    byAgent.set(record.agentId, list);
  }

  const entries: TokenUsageEntry[] = [];
  for (const list of byAgent.values()) {
    list.sort((a, b) => a.ts - b.ts || a.messageId.localeCompare(b.messageId));
    let previous: number | null = null;
    for (const record of list) {
      let fresh: number;
      let cached: number;
      if (previous === null || record.inputTokens < previous) {
        fresh = record.inputTokens;
        cached = 0;
      } else {
        fresh = record.inputTokens - previous;
        cached = previous;
      }
      previous = record.inputTokens;
      entries.push({
        sessionId: record.sessionId,
        source: TOOL_ID,
        model: record.model ?? DEFAULT_MODEL,
        project: PROJECT_LABEL,
        timestamp: new Date(record.ts * 1000),
        inputTokens: fresh,
        outputTokens: record.outputTokens,
        reasoningTokens: 0,
        cachedTokens: cached,
        cacheCreationTokens: 0,
      });
    }
  }
  return entries;
}

export class MuseParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly filePath: string;

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath ?? getMuseExportPath();
    this.tool = {
      id: TOOL_ID,
      name: TOOL_NAME,
      dataDir: dirname(this.filePath),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.filePath);
  }

  listSourceFiles(): string[] {
    return this.isInstalled() ? [this.filePath] : [];
  }

  async parse(): Promise<ParseResult> {
    const content = readFileSafe(this.filePath);
    if (content === null) {
      // A vanished export simply means "not installed". An export that
      // exists but cannot be read must not pose as an empty snapshot.
      return this.isInstalled()
        ? { buckets: [], sessions: [], incomplete: true }
        : { buckets: [], sessions: [] };
    }

    const records: MuseUsageRecord[] = [];
    let partial = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        partial = true;
        continue;
      }
      const record = parseMuseRecord(parsed);
      if (record === null) {
        partial = true;
        continue;
      }
      records.push(record);
    }

    const entries = museRecordsToEntries(records);
    // Muse's records carry no message roles, so every event is an
    // assistant generation record: session user counts and prompt hours
    // stay 0 rather than being fabricated (see the reconciliation doc).
    const events: SessionEvent[] = entries.map((entry) => ({
      sessionId: entry.sessionId ?? "",
      source: entry.source,
      project: entry.project,
      timestamp: entry.timestamp,
      role: "assistant",
    }));

    const result: ParseResult = {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(events, entries),
    };
    if (partial) result.partial = true;
    return result;
  }
}

registerParser(new MuseParser());
