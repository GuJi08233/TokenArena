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

          const inputTokens = toNonNegativeNumber(row.provider_input_tokens);
          const outputTokens = toNonNegativeNumber(row.provider_output_tokens);
          const cachedTokens = toNonNegativeNumber(row.provider_cached_tokens);
          const reasoningTokens = toNonNegativeNumber(
            row.provider_reasoning_tokens,
          );

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
