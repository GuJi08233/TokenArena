import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { readSqliteRows } from "../infrastructure/sqlite";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "mimocode";
const TOOL_NAME = "MiMoCode";
const DEFAULT_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "mimocode",
  "mimocode.db",
);

const MESSAGES_QUERY = `SELECT
  m.session_id as sessionId,
  json_extract(m.data, '$.modelID') as modelID,
  json_extract(m.data, '$.tokens.input') as inputTokens,
  json_extract(m.data, '$.tokens.output') as outputTokens,
  json_extract(m.data, '$.tokens.reasoning') as reasoningTokens,
  json_extract(m.data, '$.tokens.cache.read') as cacheReadTokens,
  json_extract(m.data, '$.tokens.cache.write') as cacheWriteTokens,
  json_extract(m.data, '$.time.created') as timeCreated,
  s.directory as directory
  FROM message m
  LEFT JOIN session s ON m.session_id = s.id
  WHERE json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(m.data, '$.tokens') IS NOT NULL`;

const SESSIONS_QUERY = `SELECT
  m.session_id as sessionId,
  json_extract(m.data, '$.role') as role,
  json_extract(m.data, '$.time.created') as timeCreated
  FROM message m
  WHERE json_extract(m.data, '$.role') IN ('user', 'assistant')
  ORDER BY json_extract(m.data, '$.time.created')`;

interface MimocodeMessageRow {
  sessionId?: unknown;
  modelID?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  timeCreated?: unknown;
  directory?: unknown;
}

interface MimocodeSessionRow {
  sessionId?: unknown;
  role?: unknown;
  timeCreated?: unknown;
}

function getMimocodeDbPaths(): string[] {
  const paths = [
    process.env.TOKEN_ARENA_MIMOCODE_DB,
    DEFAULT_DB_PATH,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "mimocode", "mimocode.db")
      : undefined,
    process.env.APPDATA
      ? join(process.env.APPDATA, "mimocode", "mimocode.db")
      : undefined,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(paths));
}

function toSafeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function extractProject(directory: unknown): string {
  if (typeof directory !== "string" || !directory) return "unknown";
  const parts = directory.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts.length > 0 ? parts[parts.length - 1] : "unknown";
}

function toTimestamp(value: unknown): Date | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // MiMoCode stores timestamps in milliseconds
  const d = new Date(n > 1e12 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class MimocodeParser implements IParser {
  readonly tool: ToolDefinition;

  constructor(
    private readonly resolveDbPaths: () => string[] = getMimocodeDbPaths,
  ) {
    this.tool = {
      id: TOOL_ID,
      name: TOOL_NAME,
      dataDir: DEFAULT_DB_PATH,
    };
  }

  async parse(): Promise<ParseResult> {
    const allEntries: TokenUsageEntry[] = [];
    const allSessionEvents: SessionEvent[] = [];

    for (const dbPath of this.resolveDbPaths()) {
      if (!existsSync(dbPath)) continue;

      try {
        const { entries, sessionEvents } = await this.parseDb(dbPath);
        allEntries.push(...entries);
        allSessionEvents.push(...sessionEvents);
      } catch (err) {
        process.stderr.write(
          `warn: mimocode parse failed for ${dbPath} (${(err as Error).message})\n`,
        );
      }
    }

    return {
      buckets: aggregateToBuckets(allEntries),
      sessions: extractSessions(allSessionEvents, allEntries),
    };
  }

  isInstalled(): boolean {
    return this.resolveDbPaths().some((p) => existsSync(p));
  }

  private async parseDb(
    dbPath: string,
  ): Promise<{ entries: TokenUsageEntry[]; sessionEvents: SessionEvent[] }> {
    const messageRows = await readSqliteRows<MimocodeMessageRow>(
      dbPath,
      MESSAGES_QUERY,
    );
    const sessionRows = await readSqliteRows<MimocodeSessionRow>(
      dbPath,
      SESSIONS_QUERY,
    );

    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];

    // Parse token usage from assistant messages
    for (const row of messageRows) {
      const timestamp = toTimestamp(row.timeCreated);
      const model = typeof row.modelID === "string" ? row.modelID : "unknown";
      const sessionId =
        typeof row.sessionId === "string" ? row.sessionId : "unknown";
      const project = extractProject(row.directory);

      const inputTokens = toSafeNumber(row.inputTokens);
      const outputTokens = toSafeNumber(row.outputTokens);
      const reasoningTokens = toSafeNumber(row.reasoningTokens);
      const cachedTokens = toSafeNumber(row.cacheReadTokens);

      if (inputTokens + outputTokens + reasoningTokens + cachedTokens === 0) {
        continue;
      }

      entries.push({
        sessionId,
        source: TOOL_ID,
        model,
        project,
        timestamp: timestamp || new Date(),
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
      });
    }

    // Parse session events for session extraction
    for (const row of sessionRows) {
      const timestamp = toTimestamp(row.timeCreated);
      const sessionId =
        typeof row.sessionId === "string" ? row.sessionId : "unknown";
      const role = typeof row.role === "string" ? row.role : "unknown";

      if (!timestamp) continue;

      if (role === "user" || role === "assistant") {
        sessionEvents.push({
          sessionId,
          source: TOOL_ID,
          project: "unknown",
          timestamp,
          role: role === "user" ? "user" : "assistant",
        });
      }
    }

    return { entries, sessionEvents };
  }
}

registerParser(new MimocodeParser());
