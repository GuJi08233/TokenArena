import type {
  ParseResult,
  SessionMetadata,
  TokenBucket,
} from "../domain/types";
import { detectInstalledTools, getAllParsers } from "../parsers/registry";
import { logger } from "../utils/logger";

export interface ParserResult {
  source: string;
  buckets: number;
  sessions: number;
}

export interface AllParsersResult {
  buckets: TokenBucket[];
  sessions: SessionMetadata[];
  parserResults: ParserResult[];
  failedSources?: string[];
}

/**
 * Run all registered parsers and collect results
 */
export async function runAllParsers(): Promise<AllParsersResult> {
  const allBuckets: TokenBucket[] = [];
  const allSessions: SessionMetadata[] = [];
  const parserResults: ParserResult[] = [];
  const failedSources = new Set<string>();

  for (const parser of getAllParsers()) {
    try {
      const result: ParseResult = await parser.parse();
      const buckets = result.buckets;
      const sessions = result.sessions;
      if (result.incomplete) {
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
        });
      }
    } catch (err) {
      failedSources.add(parser.tool.id);
      logger.warn(
        `${parser.tool.id} parser failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
