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
import { readSqliteRows, type SqliteQueryRows } from "../infrastructure/sqlite";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "hermes";
const TOOL_NAME = "Hermes Agent";
const DEFAULT_DB_PATH = join(homedir(), ".hermes", "state.db");

const SESSIONS_QUERY = `SELECT
  id,
  model,
  started_at as startedAt,
  input_tokens as inputTokens,
  output_tokens as outputTokens,
  cache_read_tokens as cacheReadTokens,
  reasoning_tokens as reasoningTokens
  FROM sessions
  WHERE input_tokens > 0
    OR output_tokens > 0
    OR cache_read_tokens > 0
    OR reasoning_tokens > 0`;

const MESSAGES_QUERY = `SELECT
  session_id as sessionId,
  role,
  timestamp
  FROM messages
  WHERE role IN ('user', 'assistant')
  ORDER BY timestamp`;

interface HermesSessionRow {
  id?: unknown;
  model?: unknown;
  startedAt?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  reasoningTokens?: unknown;
}

interface HermesMessageRow {
  sessionId?: unknown;
  role?: unknown;
  timestamp?: unknown;
}

export interface HermesParserOptions {
  dbPath?: string;
  queryRows?: SqliteQueryRows;
}

function createToolDefinition(dbPath: string): ToolDefinition {
  return {
    id: TOOL_ID,
    name: TOOL_NAME,
    dataDir: dirname(dbPath),
  };
}

function toSafeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function parseUnixTimestamp(value: unknown): Date | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }

  const timestamp = new Date(numberValue * 1000);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

export class HermesParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly dbPath: string;
  private readonly queryRows: SqliteQueryRows;

  constructor(options: HermesParserOptions = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.queryRows = options.queryRows || readSqliteRows;
    this.tool = createToolDefinition(this.dbPath);
  }

  async parse(): Promise<ParseResult> {
    if (!existsSync(this.dbPath)) {
      return { buckets: [], sessions: [] };
    }

    const sessionRows = await this.queryRows<HermesSessionRow>(
      this.dbPath,
      SESSIONS_QUERY,
    );

    const entries: TokenUsageEntry[] = [];
    for (const row of sessionRows) {
      const sessionId =
        typeof row.id === "string" && row.id.length > 0 ? row.id : null;
      if (!sessionId) continue;

      const timestamp = parseUnixTimestamp(row.startedAt);
      if (!timestamp) continue;

      const inputTokens = toSafeNumber(row.inputTokens);
      const outputTokens = toSafeNumber(row.outputTokens);
      const cachedTokens = toSafeNumber(row.cacheReadTokens);
      const reasoningTokens = toSafeNumber(row.reasoningTokens);

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cachedTokens === 0 &&
        reasoningTokens === 0
      ) {
        continue;
      }

      entries.push({
        sessionId,
        source: TOOL_ID,
        model:
          typeof row.model === "string" && row.model.length > 0
            ? row.model
            : "unknown",
        project: "unknown",
        timestamp,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
      });
    }

    let messageRows: HermesMessageRow[];
    try {
      messageRows = await this.queryRows<HermesMessageRow>(
        this.dbPath,
        MESSAGES_QUERY,
      );
    } catch {
      return {
        buckets: aggregateToBuckets(entries),
        sessions: [],
      };
    }

    const sessionEvents: SessionEvent[] = [];
    for (const row of messageRows) {
      const sessionId =
        typeof row.sessionId === "string" && row.sessionId.length > 0
          ? row.sessionId
          : null;
      if (!sessionId) continue;

      const role =
        row.role === "user" || row.role === "assistant" ? row.role : null;
      if (!role) continue;

      const timestamp = parseUnixTimestamp(row.timestamp);
      if (!timestamp) continue;

      sessionEvents.push({
        sessionId,
        source: TOOL_ID,
        project: "unknown",
        timestamp,
        role,
      });
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.dbPath);
  }
}

registerParser(new HermesParser());
