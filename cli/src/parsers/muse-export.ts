import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MAX_TS_SECONDS,
  MIN_TS_SECONDS,
  type MuseUsageRecord,
  normalizeModel,
} from "./muse";

/**
 * Building the Muse usage export from the Muse runtime database.
 *
 * The parser in `muse.ts` reads a prepared JSONL export; this module is
 * how that export is produced, so the format knowledge lives in the CLI
 * instead of in whatever script an operator (or a Muse agent) would
 * otherwise have to reinvent. Muse records per-message usage in its
 * runtime database, PostgreSQL schema `agent`:
 *
 * - `agent.agent_message_token_usage` — one row per message: agent id,
 *   message id, input/output token counts, creation time (epoch seconds).
 * - `agent.agents` — the agent rows, carrying the model and the session
 *   ids; a subagent's calls roll up to its root session.
 *
 * The database is reachable only through the Muse host (an agent's
 * database tool, or `psql` where the host exposes the socket), so the
 * CLI owns the canonical query and the transform, and accepts the query
 * result as input: `tokenarena muse export` reads it from stdin or a
 * file, or runs the query itself through `psql` (`--db`).
 *
 * The transform mirrors the export contract the parser documents: ids
 * are SHA-256 hashed (the export never carries raw runtime ids),
 * duplicate messages keep the first row, internal model ids normalize
 * to `muse-spark`, and records are ordered by time. A malformed row
 * aborts the export — silently dropping usage would corrupt the ledger,
 * and the previous export file is left untouched.
 */

/** Canonical query: one JSON object per usage row, in export order. */
export const MUSE_USAGE_ROWS_QUERY = `SELECT json_build_object(
  'ts', u.created_at,
  'messageId', u.message_id,
  'sessionId', coalesce(a.root_session_id, a.session_id, u.agent_id),
  'agentId', u.agent_id,
  'model', a.model,
  'inputTokens', u.input_tokens,
  'outputTokens', u.output_tokens
)::text AS line
FROM agent.agent_message_token_usage u
JOIN agent.agents a ON a.agent_id = u.agent_id
ORDER BY u.created_at, u.agent_id, u.message_id`;

/** Cross-check query: the export's record count and token sums must match. */
export const MUSE_USAGE_TOTALS_QUERY = `SELECT count(*) AS records,
  coalesce(sum(input_tokens), 0) AS input_tokens,
  coalesce(sum(output_tokens), 0) AS output_tokens,
  max(created_at) AS max_ts
FROM agent.agent_message_token_usage`;

/** One raw database row, before hashing and normalization. */
export interface MuseRawRow {
  /** Call time, epoch seconds. */
  ts: number;
  messageId: string;
  /** Root session the call belongs to (already coalesced by the query). */
  sessionId: string;
  agentId: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}

/** One line of the export file: a usage record stamped with format v1. */
export interface MuseExportRecord extends MuseUsageRecord {
  v: 1;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenCount(value: unknown): number | null {
  // Same discipline as the parser: only a genuine JSON number counts.
  if (typeof value !== "number") return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function invalidRow(index: number, reason: string): Error {
  return new Error(`muse export: row ${index + 1} is invalid: ${reason}`);
}

/** Validate one raw row value; throws on anything unusable. */
function parseMuseRawRow(value: unknown, index: number): MuseRawRow {
  if (typeof value !== "object" || value === null) {
    throw invalidRow(index, "not an object");
  }
  const raw = value as Record<string, unknown>;
  const ts = raw.ts;
  if (
    typeof ts !== "number" ||
    !Number.isFinite(ts) ||
    ts < MIN_TS_SECONDS ||
    ts >= MAX_TS_SECONDS
  ) {
    throw invalidRow(index, "ts is missing or outside the accepted range");
  }
  const messageId = raw.messageId;
  const sessionId = raw.sessionId;
  const agentId = raw.agentId;
  if (
    typeof messageId !== "string" ||
    !messageId ||
    typeof sessionId !== "string" ||
    !sessionId ||
    typeof agentId !== "string" ||
    !agentId
  ) {
    throw invalidRow(
      index,
      "messageId, sessionId and agentId must be non-empty strings",
    );
  }
  const inputTokens = tokenCount(raw.inputTokens);
  const outputTokens = tokenCount(raw.outputTokens);
  if (inputTokens === null || outputTokens === null) {
    throw invalidRow(
      index,
      "inputTokens and outputTokens must be non-negative integers",
    );
  }
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
 * Unwrap one input value into the row object it carries. The canonical
 * query selects a single `line` column, so rows arrive either as bare
 * objects or wrapped as `{ "line": "<json>" }` — the shape the Muse
 * host's database tool returns. A JSON string is parsed one level down.
 */
function unwrapRowValue(value: unknown, index: number): unknown {
  let current = value;
  if (typeof current === "string") {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      throw invalidRow(index, "line is not valid JSON");
    }
  }
  if (typeof current === "object" && current !== null) {
    const record = current as Record<string, unknown>;
    if (typeof record.line === "string" && !("messageId" in record)) {
      try {
        return JSON.parse(record.line) as unknown;
      } catch {
        throw invalidRow(index, "line is not valid JSON");
      }
    }
  }
  return current;
}

/** Extract the row values from a whole-input JSON document, if it is one. */
function documentRowValues(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    // The Muse host's database tool wraps results as { result: { rows } }.
    const result = record.result;
    if (typeof result === "object" && result !== null) {
      const rows = (result as Record<string, unknown>).rows;
      if (Array.isArray(rows)) return rows;
    }
    if (Array.isArray(record.rows)) return record.rows;
    // A single row (or a single { line } wrapper) is a one-row document.
    return [parsed];
  }
  return null;
}

/**
 * Parse the rows-query result into raw rows. Accepts a JSON array, a
 * JSONL stream (one row per line, bare or `line`-wrapped), a single JSON
 * document, or the Muse host database tool's `{ result: { rows } }`
 * envelope. Throws on empty input or on any malformed row: an export
 * that silently drops usage would corrupt the ledger.
 */
export function parseMuseRawRows(input: string): MuseRawRow[] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("muse export: no input — expected the rows-query result");
  }

  let values: unknown[] | null = null;
  try {
    values = documentRowValues(JSON.parse(trimmed) as unknown);
  } catch {
    values = null; // Not a single JSON document: fall through to JSONL.
  }
  if (values === null) {
    values = [];
    for (const line of trimmed.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        values.push(JSON.parse(text) as unknown);
      } catch {
        throw new Error(
          `muse export: input line ${values.length + 1} is not valid JSON`,
        );
      }
    }
  }
  if (values.length === 0) {
    throw new Error("muse export: input contains no rows");
  }
  return values.map((value, index) =>
    parseMuseRawRow(unwrapRowValue(value, index), index),
  );
}

/**
 * Transform raw rows into export records: dedupe by message (the first
 * row wins — the database is an append-only ledger, so a repeated
 * message id is the same call re-read, e.g. by an overlapping page),
 * hash every id, normalize the model, and order by time.
 */
export function transformMuseRows(
  rows: readonly MuseRawRow[],
): MuseExportRecord[] {
  const seen = new Set<string>();
  const records: MuseExportRecord[] = [];
  for (const row of rows) {
    if (seen.has(row.messageId)) continue;
    seen.add(row.messageId);
    records.push({
      v: 1,
      ts: row.ts,
      messageId: sha256Hex(row.messageId),
      sessionId: sha256Hex(row.sessionId),
      agentId: sha256Hex(row.agentId),
      model: normalizeModel(row.model),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    });
  }
  records.sort((a, b) => a.ts - b.ts);
  return records;
}

/** Serialize export records as the JSONL the Muse parser reads. */
export function serializeMuseExport(
  records: readonly MuseExportRecord[],
): string {
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** Record count and token sums, for cross-checking against the totals query. */
export function summarizeMuseExport(records: readonly MuseExportRecord[]): {
  records: number;
  inputTokens: number;
  outputTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
  }
  return { records: records.length, inputTokens, outputTokens };
}

/**
 * Write the export atomically: a reader (the daemon's parser) must never
 * observe a half-written file, and a failed export leaves the previous
 * file in place.
 */
export function writeMuseExportFile(
  records: readonly MuseExportRecord[],
  targetPath: string,
): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, serializeMuseExport(records), "utf-8");
  renameSync(tempPath, targetPath);
}
