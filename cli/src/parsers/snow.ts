import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import type { ParseResult, TokenUsageEntry } from "../domain/types";
import { findJsonlFiles, readFileSafe } from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const DEFAULT_DATA_DIR = join(homedir(), ".snow", "usage");

interface SnowUsageRecord {
  model?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  reasoningTokens?: unknown;
  timestamp?: unknown;
}

function toNonNegativeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

export class SnowParser implements IParser {
  readonly tool: ToolDefinition;

  constructor(private readonly dataDir = DEFAULT_DATA_DIR) {
    this.tool = { id: "snow", name: "Snow CLI", dataDir };
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];

    for (const filePath of findJsonlFiles(this.dataDir)) {
      const content = readFileSafe(filePath);
      if (!content) continue;

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;

        try {
          const record = JSON.parse(line) as SnowUsageRecord;
          if (typeof record.timestamp !== "string") continue;
          const timestamp = new Date(record.timestamp);
          if (Number.isNaN(timestamp.getTime())) continue;

          const inputTokens = toNonNegativeNumber(record.inputTokens);
          const outputTokens = toNonNegativeNumber(record.outputTokens);
          const cachedTokens = toNonNegativeNumber(record.cacheReadInputTokens);
          const reasoningTokens = toNonNegativeNumber(record.reasoningTokens);
          if (inputTokens + outputTokens + cachedTokens + reasoningTokens === 0)
            continue;

          entries.push({
            source: "snow",
            model:
              typeof record.model === "string" && record.model
                ? record.model
                : "unknown",
            project: "unknown",
            timestamp,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cachedTokens,
          });
        } catch {
          // Ignore malformed or partially written JSONL records.
        }
      }
    }

    return { buckets: aggregateToBuckets(entries), sessions: [] };
  }

  isInstalled(): boolean {
    return existsSync(this.dataDir);
  }
}

registerParser(new SnowParser());
