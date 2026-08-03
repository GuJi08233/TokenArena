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

const TOOL_ID = "atomcode";
const TOOL_NAME = "AtomCode";
const DEFAULT_SESSIONS_DIR = join(homedir(), ".atomcode", "sessions");

interface AtomCodeModelUsage {
  model_id?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached_input?: number;
  };
}

interface AtomCodeTurnStats {
  model_usage?: AtomCodeModelUsage[];
}

interface AtomCodeMeta {
  id?: string;
  working_dir?: string;
  turn_stats?: AtomCodeTurnStats[];
}

interface AtomCodeEvent {
  ts?: number | string;
  session_id?: string;
  user?: unknown;
  assistant?: unknown;
  usage?: {
    prompt?: number;
    completion?: number;
    cached?: number;
  };
}

function getAtomCodeSessionsDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = [
    env.TOKEN_ARENA_ATOMCODE_DIR,
    env.ATOMCODE_HOME ? join(env.ATOMCODE_HOME, "sessions") : undefined,
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

function parseMeta(content: string | null): AtomCodeMeta | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as AtomCodeMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getMetaModel(meta: AtomCodeMeta | null): string {
  for (const turn of meta?.turn_stats ?? []) {
    for (const usage of turn.model_usage ?? []) {
      if (typeof usage.model_id === "string" && usage.model_id) {
        return usage.model_id;
      }
    }
  }
  return "unknown";
}

function getMetaProject(meta: AtomCodeMeta | null): string {
  if (typeof meta?.working_dir === "string" && meta.working_dir) {
    return basename(meta.working_dir) || "unknown";
  }
  return "unknown";
}

export class AtomCodeParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly sessionsDirs: string[];

  constructor(sessionsDir?: string) {
    this.sessionsDirs = sessionsDir ? [sessionsDir] : getAtomCodeSessionsDirs();
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

        const rows = parseJsonl<AtomCodeEvent>(content);
        if (rows.length === 0) continue;

        const fallbackSessionId = extractSessionId(filePath);
        const meta = parseMeta(
          readFileSafe(filePath.replace(/\.jsonl$/, ".meta")),
        );
        const project = getMetaProject(meta);
        const model = getMetaModel(meta);

        for (const row of rows) {
          const sessionId =
            typeof row.session_id === "string" && row.session_id
              ? row.session_id
              : fallbackSessionId;
          const timestamp = parseTimestamp(row.ts);
          if (!timestamp) continue;

          if (row.user !== undefined || row.assistant !== undefined) {
            sessionEvents.push({
              sessionId,
              source: TOOL_ID,
              project,
              timestamp,
              role: row.user !== undefined ? "user" : "assistant",
            });
          }

          const usage = row.usage;
          if (!usage) continue;

          const prompt = toNonNegativeNumber(usage.prompt);
          const completion = toNonNegativeNumber(usage.completion);
          const cached = toNonNegativeNumber(usage.cached);
          // usage.prompt includes the cached input portion.
          const inputTokens = Math.max(0, prompt - cached);

          if (inputTokens + completion + cached === 0) {
            continue;
          }

          const entryKey = [
            sessionId,
            timestamp.toISOString(),
            model,
            inputTokens,
            completion,
            cached,
          ].join("|");
          if (seenEntryKeys.has(entryKey)) {
            continue;
          }
          seenEntryKeys.add(entryKey);

          entries.push({
            sessionId,
            source: TOOL_ID,
            model,
            project,
            timestamp,
            inputTokens,
            outputTokens: completion,
            reasoningTokens: 0,
            cachedTokens: cached,
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

registerParser(new AtomCodeParser());
