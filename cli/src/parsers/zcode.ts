import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { hasInvalidTokenCounts } from "../domain/token-usage";
import type {
  ParseResult,
  SessionMetadata,
  SessionModelUsage,
  TokenUsageEntry,
} from "../domain/types";
import { readSqliteRows, type SqliteQueryRows } from "../infrastructure/sqlite";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "zcode";
const TOOL_NAME = "ZCode";
const DEFAULT_DB_PATH = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

const MODEL_USAGE_QUERY = `SELECT
  model_usage.session_id as sessionId,
  session.directory as directory,
  model_usage.model_id as model,
  model_usage.started_at as startedAt,
  model_usage.input_tokens as inputTokens,
  model_usage.output_tokens as outputTokens,
  model_usage.reasoning_tokens as reasoningTokens,
  model_usage.cache_read_input_tokens as cacheReadInputTokens
  FROM model_usage
  LEFT JOIN session ON session.id = model_usage.session_id
  WHERE model_usage.input_tokens > 0
    OR model_usage.output_tokens > 0
    OR model_usage.reasoning_tokens > 0
    OR model_usage.cache_read_input_tokens > 0`;

const SESSION_QUERY = `SELECT
  id,
  directory,
  time_created as timeCreated,
  time_updated as timeUpdated
  FROM session`;

const MESSAGE_QUERY = `SELECT
  session_id as sessionId,
  time_created as timeCreated,
  data
  FROM message
  ORDER BY time_created`;

const TURN_USAGE_QUERY = `SELECT
  session_id as sessionId,
  duration_ms as durationMs
  FROM turn_usage
  WHERE duration_ms IS NOT NULL`;

interface ZCodeModelUsageRow {
  sessionId?: unknown;
  directory?: unknown;
  model?: unknown;
  startedAt?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadInputTokens?: unknown;
}

interface ZCodeSessionRow {
  id?: unknown;
  directory?: unknown;
  timeCreated?: unknown;
  timeUpdated?: unknown;
}

interface ZCodeMessageRow {
  sessionId?: unknown;
  timeCreated?: unknown;
  data?: unknown;
}

interface ZCodeTurnUsageRow {
  sessionId?: unknown;
  durationMs?: unknown;
}

interface ZCodeMessageData {
  role?: unknown;
  time?: {
    created?: unknown;
  };
}

type ZCodeSessionDraft = {
  sessionId: string;
  source: string;
  project: string;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  fallbackFirstAt: Date | null;
  fallbackLastAt: Date | null;
  activeSeconds: number;
  messageCount: number;
  userMessageCount: number;
  userPromptHours: number[];
};

export interface ZCodeParserOptions {
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
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseUnixMillis(value: unknown): Date | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }

  const timestamp = new Date(numberValue);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function getPathLeaf(value: string | null): string {
  if (!value) {
    return "unknown";
  }

  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = normalized.split("/").filter(Boolean).pop();
  return leaf || "unknown";
}

function parseMessageData(value: unknown): ZCodeMessageData | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as ZCodeMessageData;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getOrCreateDraft(
  drafts: Map<string, ZCodeSessionDraft>,
  sessionId: string,
  project: string,
): ZCodeSessionDraft {
  const existing = drafts.get(sessionId);
  if (existing) {
    if (existing.project === "unknown" && project !== "unknown") {
      existing.project = project;
    }
    return existing;
  }

  const next: ZCodeSessionDraft = {
    sessionId,
    source: TOOL_ID,
    project,
    firstMessageAt: null,
    lastMessageAt: null,
    fallbackFirstAt: null,
    fallbackLastAt: null,
    activeSeconds: 0,
    messageCount: 0,
    userMessageCount: 0,
    userPromptHours: new Array(24).fill(0),
  };

  drafts.set(sessionId, next);
  return next;
}

function buildSessionUsage(entries: TokenUsageEntry[]) {
  const usageBySession = new Map<string, Map<string, SessionModelUsage>>();

  for (const entry of entries) {
    if (!entry.sessionId || hasInvalidTokenCounts(entry)) {
      continue;
    }

    let byModel = usageBySession.get(entry.sessionId);
    if (!byModel) {
      byModel = new Map<string, SessionModelUsage>();
      usageBySession.set(entry.sessionId, byModel);
    }

    const totalTokens =
      entry.inputTokens +
      entry.outputTokens +
      entry.reasoningTokens +
      entry.cachedTokens;
    const existing = byModel.get(entry.model);

    if (existing) {
      existing.inputTokens += entry.inputTokens;
      existing.outputTokens += entry.outputTokens;
      existing.reasoningTokens += entry.reasoningTokens;
      existing.cachedTokens += entry.cachedTokens;
      existing.totalTokens += totalTokens;
      continue;
    }

    byModel.set(entry.model, {
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      reasoningTokens: entry.reasoningTokens,
      cachedTokens: entry.cachedTokens,
      totalTokens,
    });
  }

  return usageBySession;
}

function buildSessions(input: {
  sessionRows: ZCodeSessionRow[];
  messageRows: ZCodeMessageRow[];
  turnRows: ZCodeTurnUsageRow[];
  entries: TokenUsageEntry[];
}): SessionMetadata[] {
  const drafts = new Map<string, ZCodeSessionDraft>();

  for (const row of input.sessionRows) {
    const sessionId = getString(row.id);
    if (!sessionId) {
      continue;
    }

    const draft = getOrCreateDraft(
      drafts,
      sessionId,
      getPathLeaf(getString(row.directory)),
    );
    draft.fallbackFirstAt = parseUnixMillis(row.timeCreated);
    draft.fallbackLastAt = parseUnixMillis(row.timeUpdated);
  }

  for (const row of input.messageRows) {
    const sessionId = getString(row.sessionId);
    if (!sessionId) {
      continue;
    }

    const data = parseMessageData(row.data);
    const role =
      data?.role === "user" || data?.role === "assistant" ? data.role : null;
    if (!role) {
      continue;
    }

    const timestamp =
      parseUnixMillis(data?.time?.created) ?? parseUnixMillis(row.timeCreated);
    if (!timestamp) {
      continue;
    }

    const draft = getOrCreateDraft(drafts, sessionId, "unknown");
    draft.messageCount += 1;

    if (!draft.firstMessageAt || timestamp < draft.firstMessageAt) {
      draft.firstMessageAt = timestamp;
    }
    if (!draft.lastMessageAt || timestamp > draft.lastMessageAt) {
      draft.lastMessageAt = timestamp;
    }

    if (role === "user") {
      draft.userMessageCount += 1;
      draft.userPromptHours[timestamp.getUTCHours()] += 1;
    }
  }

  for (const row of input.turnRows) {
    const sessionId = getString(row.sessionId);
    if (!sessionId) {
      continue;
    }

    const draft = getOrCreateDraft(drafts, sessionId, "unknown");
    draft.activeSeconds += Math.round(toSafeNumber(row.durationMs) / 1000);
  }

  const usageBySession = buildSessionUsage(input.entries);
  const host = hostname().replace(/\.local$/, "");

  return Array.from(drafts.values())
    .map((draft) => {
      const firstMessageAt = draft.firstMessageAt ?? draft.fallbackFirstAt;
      const lastMessageAt =
        draft.lastMessageAt ?? draft.fallbackLastAt ?? firstMessageAt;

      if (!firstMessageAt || !lastMessageAt) {
        return null;
      }

      const modelUsages = Array.from(
        usageBySession.get(draft.sessionId)?.values() ?? [],
      ).sort((left, right) => {
        if (right.totalTokens !== left.totalTokens) {
          return right.totalTokens - left.totalTokens;
        }

        return left.model.localeCompare(right.model);
      });
      const inputTokens = modelUsages.reduce(
        (sum, usage) => sum + usage.inputTokens,
        0,
      );
      const outputTokens = modelUsages.reduce(
        (sum, usage) => sum + usage.outputTokens,
        0,
      );
      const reasoningTokens = modelUsages.reduce(
        (sum, usage) => sum + usage.reasoningTokens,
        0,
      );
      const cachedTokens = modelUsages.reduce(
        (sum, usage) => sum + usage.cachedTokens,
        0,
      );
      const totalTokens = modelUsages.reduce(
        (sum, usage) => sum + usage.totalTokens,
        0,
      );
      const durationSeconds = Math.max(
        0,
        Math.round((lastMessageAt.getTime() - firstMessageAt.getTime()) / 1000),
      );

      return {
        source: draft.source,
        project: draft.project,
        sessionHash: createHash("sha256")
          .update(draft.sessionId)
          .digest("hex")
          .slice(0, 16),
        hostname: host,
        firstMessageAt: firstMessageAt.toISOString(),
        lastMessageAt: lastMessageAt.toISOString(),
        durationSeconds,
        activeSeconds: draft.activeSeconds,
        messageCount: draft.messageCount,
        userMessageCount: draft.userMessageCount,
        userPromptHours: draft.userPromptHours,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
        primaryModel: modelUsages[0]?.model ?? "",
        modelUsages,
      } satisfies SessionMetadata;
    })
    .filter((session): session is SessionMetadata => session !== null);
}

export class ZCodeParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly dbPath: string;
  private readonly queryRows: SqliteQueryRows;

  constructor(options: ZCodeParserOptions = {}) {
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.queryRows = options.queryRows || readSqliteRows;
    this.tool = createToolDefinition(this.dbPath);
  }

  async parse(): Promise<ParseResult> {
    if (!existsSync(this.dbPath)) {
      return { buckets: [], sessions: [] };
    }

    const usageRows = await this.queryRows<ZCodeModelUsageRow>(
      this.dbPath,
      MODEL_USAGE_QUERY,
    );
    const entries: TokenUsageEntry[] = [];

    for (const row of usageRows) {
      const timestamp = parseUnixMillis(row.startedAt);
      if (!timestamp) {
        continue;
      }

      const inputTokens = toSafeNumber(row.inputTokens);
      const outputTokens = toSafeNumber(row.outputTokens);
      const reasoningTokens = toSafeNumber(row.reasoningTokens);
      const cachedTokens = toSafeNumber(row.cacheReadInputTokens);

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        reasoningTokens === 0 &&
        cachedTokens === 0
      ) {
        continue;
      }

      entries.push({
        sessionId: getString(row.sessionId) ?? undefined,
        source: TOOL_ID,
        model: getString(row.model) ?? "unknown",
        project: getPathLeaf(getString(row.directory)),
        timestamp,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
      });
    }

    let sessionRows: ZCodeSessionRow[] = [];
    let messageRows: ZCodeMessageRow[] = [];
    let turnRows: ZCodeTurnUsageRow[] = [];

    try {
      [sessionRows, messageRows, turnRows] = await Promise.all([
        this.queryRows<ZCodeSessionRow>(this.dbPath, SESSION_QUERY),
        this.queryRows<ZCodeMessageRow>(this.dbPath, MESSAGE_QUERY),
        this.queryRows<ZCodeTurnUsageRow>(this.dbPath, TURN_USAGE_QUERY),
      ]);
    } catch {
      return {
        buckets: aggregateToBuckets(entries),
        sessions: [],
      };
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: buildSessions({
        sessionRows,
        messageRows,
        turnRows,
        entries,
      }),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.dbPath);
  }
}

registerParser(new ZCodeParser());
