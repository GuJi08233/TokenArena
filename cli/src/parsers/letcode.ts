import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import {
  extractSessionId,
  findJsonlFiles,
  parseJsonl,
  readFileSafe,
} from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "letcode";
const TOOL_NAME = "LetCode";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "letcode");
const DEFAULT_SESSIONS_DIR = join(DEFAULT_CONFIG_DIR, "sessions");

interface LetcodeEvent {
  kind?: string;
  phase?: string;
  usage_completeness?: string;
  session_id?: string;
  model?: string;
  timestamp_ms?: number | string;
  provider_input_tokens?: number | string;
  provider_output_tokens?: number | string;
  provider_cached_tokens?: number | string;
  provider_reasoning_tokens?: number | string;
  provider_total_tokens?: number | string;
}

function getLetcodeSessionsDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = [
    env.TOKEN_ARENA_LETCODE_DIR,
    env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, "letcode", "sessions")
      : undefined,
    DEFAULT_SESSIONS_DIR,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(dirs));
}

function toNonNegativeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

/**
 * Split one request's provider counts into the non-overlapping fields the
 * upload sums.
 *
 * LetCode reports OpenAI-style counts: `provider_input_tokens` includes the
 * cached prompt and `provider_output_tokens` the reasoning, as
 * `provider_total_tokens` = input + output shows. Adding cached and reasoning
 * on top counted them twice, the bug 221c670 fixed for ZCode. The reported
 * total decides which subsets are included; without one, a subset no larger
 * than its parent is taken to be inside it.
 */
function splitProviderUsage(row: LetcodeEvent) {
  const input = toNonNegativeNumber(row.provider_input_tokens);
  const output = toNonNegativeNumber(row.provider_output_tokens);
  const cached = toNonNegativeNumber(row.provider_cached_tokens);
  const reasoning = toNonNegativeNumber(row.provider_reasoning_tokens);

  let cachedInInput = cached <= input;
  let reasoningInOutput = reasoning <= output;

  if (row.provider_total_tokens !== undefined) {
    const total = toNonNegativeNumber(row.provider_total_tokens);

    if (total === input + output) {
      cachedInInput = true;
      reasoningInOutput = true;
    } else if (total === input + output + reasoning) {
      cachedInInput = true;
      reasoningInOutput = false;
    } else if (total === input + output + cached) {
      cachedInInput = false;
      reasoningInOutput = true;
    } else if (total === input + output + cached + reasoning) {
      cachedInInput = false;
      reasoningInOutput = false;
    }
  }

  return {
    inputTokens: cachedInInput ? Math.max(0, input - cached) : input,
    outputTokens: reasoningInOutput ? Math.max(0, output - reasoning) : output,
    cachedTokens: cached,
    reasoningTokens: reasoning,
  };
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      const timestamp = new Date(asNumber);
      if (!Number.isNaN(timestamp.getTime())) {
        return timestamp;
      }
    }

    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  return null;
}

function shouldCountTelemetry(event: LetcodeEvent): boolean {
  if (event.kind !== "llm_request_telemetry") {
    return false;
  }

  if (event.phase !== "completed") {
    return false;
  }

  // Prefer provider-reported usage. Skip pre-request / missing usage rows.
  if (event.usage_completeness === "usage_missing") {
    return false;
  }

  return true;
}

function toSessionRole(kind: string | undefined): "user" | "assistant" | null {
  if (kind === "user_message") {
    return "user";
  }

  if (kind === "assistant_message") {
    return "assistant";
  }

  return null;
}

export class LetcodeParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly sessionsDirs: string[];

  constructor(sessionsDir?: string) {
    this.sessionsDirs = sessionsDir ? [sessionsDir] : getLetcodeSessionsDirs();
    this.tool = {
      id: TOOL_ID,
      name: TOOL_NAME,
      dataDir: this.sessionsDirs[0] ?? DEFAULT_SESSIONS_DIR,
    };
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];
    const seenEntryKeys = new Set<string>();

    for (const sessionsDir of this.sessionsDirs) {
      for (const filePath of findJsonlFiles(sessionsDir)) {
        const content = readFileSafe(filePath);
        if (!content) continue;

        const rows = parseJsonl<LetcodeEvent>(content);
        if (rows.length === 0) continue;

        const fallbackSessionId =
          extractSessionId(filePath) || basename(filePath);

        for (const row of rows) {
          const sessionId =
            typeof row.session_id === "string" && row.session_id
              ? row.session_id
              : fallbackSessionId;
          const timestamp = parseTimestamp(row.timestamp_ms);
          if (!timestamp) continue;

          const role = toSessionRole(row.kind);
          if (role) {
            sessionEvents.push({
              sessionId,
              source: TOOL_ID,
              project: "unknown",
              timestamp,
              role,
            });
          }

          if (!shouldCountTelemetry(row)) {
            continue;
          }

          const { inputTokens, outputTokens, cachedTokens, reasoningTokens } =
            splitProviderUsage(row);

          if (
            inputTokens + outputTokens + cachedTokens + reasoningTokens ===
            0
          ) {
            continue;
          }

          const model =
            typeof row.model === "string" && row.model ? row.model : "unknown";

          // Deduplicate when the same sessions dir appears under multiple roots.
          const entryKey = [
            sessionId,
            timestamp.toISOString(),
            model,
            inputTokens,
            outputTokens,
            cachedTokens,
            reasoningTokens,
          ].join("|");
          if (seenEntryKeys.has(entryKey)) {
            continue;
          }
          seenEntryKeys.add(entryKey);

          entries.push({
            sessionId,
            source: TOOL_ID,
            model,
            project: "unknown",
            timestamp,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cachedTokens,
          });
        }
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  isInstalled(): boolean {
    return this.sessionsDirs.some((dir) => existsSync(dir));
  }
}

registerParser(new LetcodeParser());
