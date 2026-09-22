import type {
  ParseResult,
  SessionMetadata,
  TokenBucket,
} from "../domain/types";
import { detectInstalledTools, getAllParsers } from "../parsers/registry";
import type { IParser } from "../parsers/types";
import { logger } from "../utils/logger";
import {
  computeScanFingerprint,
  loadCachedParseResult,
  saveCachedParseResult,
} from "./parse-cache";

export interface ParserResult {
  source: string;
  buckets: number;
  sessions: number;
  /** True when the counts were replayed from cache instead of a fresh scan. */
  cached?: boolean;
}

export interface AllParsersResult {
  buckets: TokenBucket[];
  sessions: SessionMetadata[];
  parserResults: ParserResult[];
  failedSources?: string[];
}

/**
 * 同时在跑的解析器上限。
 *
 * 解析几乎全是读文件，串行跑时每个工具都在等磁盘。不放开到全部并发是因为
 * 每个解析器扫描期间都持有自己的中间状态（去重表、事件表），几十个一起展开
 * 会把内存峰值叠起来。
 */
const PARSER_CONCURRENCY = 8;

type SettledParse =
  | { status: "ok"; result: ParseResult; cached: boolean }
  | { status: "failed"; message: string };

/**
 * Parse a tool, reusing the previous result when its files have not changed.
 *
 * Only parsers that declare `listSourceFiles` take part; everything else parses
 * exactly as before. The fingerprint covers the file list with each file's mtime
 * and size, plus the CLI version and hostname, so a logic change or a machine
 * rename invalidates it too.
 */
async function parseWithCache(parser: IParser): Promise<SettledParse> {
  const files = parser.listSourceFiles?.();
  const fingerprint = files ? computeScanFingerprint(files) : null;
  const cached = loadCachedParseResult(parser.tool.id, fingerprint);

  if (cached) {
    return { status: "ok", result: cached, cached: true };
  }

  try {
    const result = await parser.parse();
    saveCachedParseResult(parser.tool.id, fingerprint, result);

    return { status: "ok", result, cached: false };
  } catch (err) {
    return {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 限制并发地映射，并保持输入顺序。
 *
 * 顺序要稳定：桶和会话的合并顺序决定上传载荷的排列，跟着完成快慢变会让同样的
 * 本地数据产生不同的载荷。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

/**
 * Run all registered parsers and collect results
 */
export async function runAllParsers(): Promise<AllParsersResult> {
  const allBuckets: TokenBucket[] = [];
  const allSessions: SessionMetadata[] = [];
  const parserResults: ParserResult[] = [];
  const failedSources = new Set<string>();

  const parsers = getAllParsers();
  const settled = await mapWithConcurrency<IParser, SettledParse>(
    parsers,
    PARSER_CONCURRENCY,
    parseWithCache,
  );

  // 收集与日志留在注册顺序上，与并发之前的输出逐字节一致。
  for (const [index, parser] of parsers.entries()) {
    const outcome = settled[index];

    if (outcome.status === "failed") {
      failedSources.add(parser.tool.id);
      logger.warn(`${parser.tool.id} parser failed: ${outcome.message}`);
      continue;
    }

    const { buckets, sessions, incomplete } = outcome.result;

    if (incomplete) {
      failedSources.add(parser.tool.id);
      logger.warn(
        `${parser.tool.id} parser reported an incomplete scan; preserving its remote history.`,
      );
      // 上传的是桶的完整快照，部分结果会覆盖云端完整计数，因此整工具暂缓。
      continue;
    }

    if (buckets.length > 0) allBuckets.push(...buckets);
    if (sessions.length > 0) allSessions.push(...sessions);

    if (buckets.length > 0 || sessions.length > 0) {
      parserResults.push({
        source: parser.tool.id,
        buckets: buckets.length,
        sessions: sessions.length,
        ...(outcome.cached ? { cached: true } : {}),
      });
    }
  }

  return {
    buckets: allBuckets,
    sessions: allSessions,
    parserResults,
    failedSources: Array.from(failedSources),
  };
}

/**
 * Get list of detected tools for status display
 */
export function getDetectedTools() {
  return detectInstalledTools();
}
