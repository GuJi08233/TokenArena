import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const TOOL_ID = "cherry-studio";
const TOOL_NAME = "Cherry Studio";
const DB_RELATIVE = join("Data", "cherrystudio.sqlite");

// `message_id` resolves to a chat message whose `topic_id` is the conversation
// Cherry Studio shows in its sidebar, so the join recovers the session id.
// Agent-session records point elsewhere and come back with a null topic.
const USAGE_QUERY = `SELECT
  u.model_id as modelId,
  u.no_cache_tokens as noCacheTokens,
  u.input_tokens as inputTokens,
  u.output_tokens as outputTokens,
  u.reasoning_tokens as reasoningTokens,
  u.cache_read_tokens as cacheReadTokens,
  u.cache_write_tokens as cacheWriteTokens,
  u.created_at as createdAt,
  m.topic_id as sessionId
  FROM ai_usage_record u
  LEFT JOIN message m ON m.id = u.message_id`;

// Every topic also holds a `root` node that is not a real turn, so the role
// filter keeps session timing limited to actual prompts and replies.
const MESSAGES_QUERY = `SELECT
  topic_id as sessionId,
  role,
  created_at as createdAt
  FROM message
  WHERE role IN ('user', 'assistant')
    AND deleted_at IS NULL
  ORDER BY created_at`;

interface CherryStudioUsageRow {
  modelId?: unknown;
  noCacheTokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  createdAt?: unknown;
  sessionId?: unknown;
}

interface CherryStudioMessageRow {
  sessionId?: unknown;
  role?: unknown;
  createdAt?: unknown;
}

export interface CherryStudioParserOptions {
  dbPath?: string;
  queryRows?: SqliteQueryRows;
}

function getDefaultUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "CherryStudio");
  }
  if (process.platform === "win32") {
    const appData =
      env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "CherryStudio");
  }

  const xdgConfigHome =
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(xdgConfigHome, "CherryStudio");
}

export function getCherryStudioDbPaths(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths: string[] = [];

  // The app lets users relocate their data directory, so accept either the
  // sqlite file itself or the directory that contains `Data/`.
  const explicit = env.TOKEN_ARENA_CHERRY_STUDIO_DB?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    paths.push(
      resolved.endsWith(".sqlite") ? resolved : join(resolved, DB_RELATIVE),
    );
  }

  paths.push(join(getDefaultUserDataDir(env), DB_RELATIVE));

  return Array.from(new Set(paths));
}

function resolveCherryStudioDbPath(): string {
  const candidates = getCherryStudioDbPaths();
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function createToolDefinition(dbPath: string): ToolDefinition {
  return {
    id: TOOL_ID,
    name: TOOL_NAME,
    dataDir: dbPath ? dirname(dbPath) : join(getDefaultUserDataDir(), "Data"),
  };
}

function toSafeCount(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0
    ? Math.round(numberValue)
    : 0;
}

/**
 * Same as `toSafeCount` but keeps null distinguishable from zero: rows migrated
 * from Cherry Studio v1 leave the cache breakdown empty, and that has to fall
 * back to arithmetic instead of being read as "no cached tokens".
 */
function toOptionalCount(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0
    ? Math.round(numberValue)
    : null;
}

function parseEpochMillis(value: unknown): Date | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return null;
  }

  const timestamp = new Date(numberValue);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function getNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class CherryStudioParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly dbPath: string;
  private readonly queryRows: SqliteQueryRows;

  constructor(options: CherryStudioParserOptions = {}) {
    this.dbPath = options.dbPath || resolveCherryStudioDbPath();
    this.queryRows = options.queryRows || readSqliteRows;
    this.tool = createToolDefinition(this.dbPath);
  }

  async parse(): Promise<ParseResult> {
    if (!this.dbPath || !existsSync(this.dbPath)) {
      return { buckets: [], sessions: [] };
    }

    const usageRows = await this.queryRows<CherryStudioUsageRow>(
      this.dbPath,
      USAGE_QUERY,
    );

    const entries: TokenUsageEntry[] = [];
    for (const row of usageRows) {
      const timestamp = parseEpochMillis(row.createdAt);
      if (!timestamp) continue;

      // Both cache reads and writes are billed, so they fold together.
      const cachedTokens =
        toSafeCount(row.cacheReadTokens) + toSafeCount(row.cacheWriteTokens);
      // `input_tokens` already covers the cached tokens and the aggregator sums
      // all four fields, so the uncached remainder is what belongs in
      // inputTokens. Prefer the recorded breakdown; migrated rows have none.
      const noCacheTokens = toOptionalCount(row.noCacheTokens);
      const inputTokens =
        noCacheTokens ??
        Math.max(0, toSafeCount(row.inputTokens) - cachedTokens);
      // Reasoning is reported as a subset of output, like parsers/mirasim.ts.
      const reasoningTokens = toSafeCount(row.reasoningTokens);
      const outputTokens = Math.max(
        0,
        toSafeCount(row.outputTokens) - reasoningTokens,
      );

      // Cancelled and failed requests are recorded with every count empty.
      if (inputTokens + outputTokens + reasoningTokens + cachedTokens === 0) {
        continue;
      }

      entries.push({
        // Rows the topic join could not resolve still count toward buckets,
        // they just cannot take part in session timing.
        sessionId: getNonEmptyString(row.sessionId) ?? undefined,
        source: TOOL_ID,
        model: getNonEmptyString(row.modelId) ?? "unknown",
        project: "unknown",
        timestamp,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
      });
    }

    let messageRows: CherryStudioMessageRow[];
    try {
      messageRows = await this.queryRows<CherryStudioMessageRow>(
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
      const sessionId = getNonEmptyString(row.sessionId);
      if (!sessionId) continue;

      const role =
        row.role === "user" || row.role === "assistant" ? row.role : null;
      if (!role) continue;

      const timestamp = parseEpochMillis(row.createdAt);
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
    return Boolean(this.dbPath) && existsSync(this.dbPath);
  }
}

registerParser(new CherryStudioParser());
