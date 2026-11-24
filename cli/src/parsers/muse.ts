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
 * Accepted call-time range, epoch seconds: [2020-01-01, 2080-01-01) UTC.
 * Mirrors the millisecond window snow.ts enforces. Anything outside it —
 * a millisecond or microsecond timestamp from a misconfigured exporter,
 * say — is a malformed record, never a bucket: an out-of-range Date would
 * make the aggregator throw and take every good record down with it.
 */
export const MIN_TS_SECONDS = 1_577_836_800;
export const MAX_TS_SECONDS = 3_471_292_800;

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

/** One line of the Muse usage export (format v1): a single attributed message. */
export interface MuseUsageRecord {
  /** Call time, epoch seconds. */
  ts: number;
  messageId: string;
  /** Root session the call belongs to; subagent calls roll up to it. */
  sessionId: string;
  /** The agent that made the call. */
  agentId: string;
  model?: string;
  /** Full prompt size of the call, as reported by Muse. */
  inputTokens: number;
  outputTokens: number;
}

function tokenCount(value: unknown): number | null {
  // Only a genuine JSON number counts. Number() coercion would silently
  // accept null, "" and [] as 0 and true as 1, corrupting the ledger.
  if (typeof value !== "number") return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Validate one parsed JSONL value; returns null for anything unusable. */
export function parseMuseRecord(value: unknown): MuseUsageRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const ts = raw.ts;
  if (
    typeof ts !== "number" ||
    !Number.isFinite(ts) ||
    ts < MIN_TS_SECONDS ||
    ts >= MAX_TS_SECONDS
  ) {
    return null;
  }
  const inputTokens = tokenCount(raw.inputTokens);
  const outputTokens = tokenCount(raw.outputTokens);
  const messageId = typeof raw.messageId === "string" ? raw.messageId : "";
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  const agentId = typeof raw.agentId === "string" ? raw.agentId : "";
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
 * The display model for a record. The exporter normalizes Muse's
 * internal runtime ids (`ipnext/avocado-*`) to `muse-spark`; repeat that
 * here as a fallback so a leaked internal id cannot mint a new bucket key
 * (and double-count history once fixed).
 */
export function normalizeModel(model: string | undefined): string {
  if (!model) return DEFAULT_MODEL;
  if (model.startsWith("ipnext/avocado-")) return DEFAULT_MODEL;
  return model;
}

/**
 * Convert export records into usage entries.
 *
 * Muse reports each call's *full* prompt as its input count, so the value
 * is stored as reported. Cache reads are not reported and stay 0: that a
 * later call resends earlier context is a transport fact, not a reported
 * cache hit, and estimating it would fabricate a provider-side quantity
 * (and feed cache-share statistics and achievements). Reasoning and
 * cache creation are likewise unreported and stay 0, per the
 * no-fabrication rule in docs/usage-reconciliation.md.
 *
 * Duplicate (sessionId, messageId) pairs keep the first record: the
 * export is a cumulative snapshot of an append-only ledger, so a repeated
 * pair is the same call re-exported.
 */
export function museRecordsToEntries(
  records: MuseUsageRecord[],
): TokenUsageEntry[] {
  const seen = new Set<string>();
  const entries: TokenUsageEntry[] = [];
  for (const record of records) {
    // JSON-encode the pair so the key is unambiguous: there is no separator
    // byte to lose, and ("ab", "c") can never collide with ("a", "bc").
    const key = JSON.stringify([record.sessionId, record.messageId]);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      sessionId: record.sessionId,
      source: TOOL_ID,
      model: normalizeModel(record.model),
      project: PROJECT_LABEL,
      timestamp: new Date(record.ts * 1000),
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
    });
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
