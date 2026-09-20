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
import { readSqliteRows, type SqliteQueryRows } from "../infrastructure/sqlite";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

export function getMcodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir =
    [env.MINIMAX_DATA_DIR, env.MAVIS_DATA_DIR]
      .map((value) => value?.trim())
      .find(Boolean) || join(homedir(), ".minimax");
  return join(dataDir, "v2", "sqlite", "runtime-state.sqlite");
}

interface UsageRow {
  id: string | number;
  sessionId: string;
  model: string | null;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

interface SessionRow {
  sessionId: string;
  directory: string | null;
}

function tokenCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
}

export class McodeParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly dbPath: string;
  private readonly queryRows: SqliteQueryRows;

  constructor(options: { dbPath?: string; queryRows?: SqliteQueryRows } = {}) {
    this.dbPath = options.dbPath ?? getMcodeDbPath();
    this.queryRows = options.queryRows ?? readSqliteRows;
    this.tool = { id: "mcode", name: "MiniMax Code", dataDir: this.dbPath };
  }

  async parse(): Promise<ParseResult> {
    if (!existsSync(this.dbPath)) return { buckets: [], sessions: [] };
    let rows: UsageRow[];
    try {
      // 只读取原生已提交的用量表，避免把运行时事件重放为第二份账单。
      rows = await this.queryRows<UsageRow>(
        this.dbPath,
        `SELECT
        id, session_id AS sessionId, model, ts AS timestamp,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        reasoning_tokens AS reasoningTokens, cache_read_tokens AS cachedTokens,
        cache_write_tokens AS cacheCreationTokens
        FROM local_runtime_token_usage ORDER BY id`,
      );
    } catch (error) {
      process.stderr.write(
        `warn: mcode usage parse failed (${(error as Error).message})\n`,
      );
      return { buckets: [], sessions: [], incomplete: true };
    }

    const projects = new Map<string, string>();
    let incomplete = false;
    try {
      const sessions = await this.queryRows<SessionRow>(
        this.dbPath,
        "SELECT session_id AS sessionId, workspace_dir AS directory FROM local_runtime_sessions",
      );
      for (const row of sessions) {
        const project = row.directory
          ?.replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop();
        if (project) projects.set(row.sessionId, project);
      }
    } catch (error) {
      // 旧版可缺少元数据表；锁定等读取失败仍标记不完整，阻止破坏性重建。
      if (
        !(error as Error).message.includes(
          "no such table: local_runtime_sessions",
        )
      ) {
        incomplete = true;
        process.stderr.write(
          `warn: mcode session metadata parse failed (${(error as Error).message})\n`,
        );
      }
    }

    const entries: TokenUsageEntry[] = [];
    const events: SessionEvent[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.timestamp === null || row.timestamp === undefined) continue;
      const timestamp = new Date(Number(row.timestamp));
      if (
        !Number.isFinite(Number(row.timestamp)) ||
        Number.isNaN(timestamp.getTime())
      )
        continue;
      const key = JSON.stringify([row.sessionId, row.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      const nativeModel = row.model || "unknown";
      // 第一段为供应商命名空间，后续的 vendor/model 层级必须保留。
      const model = nativeModel.includes("/")
        ? nativeModel.slice(nativeModel.indexOf("/") + 1)
        : nativeModel;
      const entry: TokenUsageEntry = {
        sessionId: row.sessionId,
        source: "mcode",
        project: projects.get(row.sessionId) || "unknown",
        model: model || "unknown",
        timestamp,
        inputTokens: tokenCount(row.inputTokens),
        outputTokens: tokenCount(row.outputTokens),
        reasoningTokens: tokenCount(row.reasoningTokens),
        cachedTokens: tokenCount(row.cachedTokens),
        cacheCreationTokens: tokenCount(row.cacheCreationTokens),
      };
      if (
        entry.inputTokens +
          entry.outputTokens +
          entry.reasoningTokens +
          entry.cachedTokens +
          (entry.cacheCreationTokens ?? 0) ===
        0
      )
        continue;
      entries.push(entry);
      events.push({
        sessionId: row.sessionId,
        source: "mcode",
        project: entry.project,
        timestamp,
        role: "assistant",
      });
    }
    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(events, entries),
      ...(incomplete ? { incomplete: true } : {}),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.dbPath);
  }
}

registerParser(new McodeParser());
