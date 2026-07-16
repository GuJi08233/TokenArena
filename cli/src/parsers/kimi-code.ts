import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { readFileSafe } from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "kimi-code";
const TOOL_NAME = "Kimi Code";
const DEFAULT_SESSIONS_DIR = join(homedir(), ".kimi-code", "sessions");
const DEFAULT_CONFIG_PATH = join(homedir(), ".kimi-code", "workspaces.json");

const USER_EVENT_TYPES = new Set([
  "UserMessage",
  "user_message",
  "Input",
  "turn.prompt",
]);
const ASSISTANT_EVENT_TYPES = new Set([
  "AssistantMessage",
  "assistant_message",
  "Output",
  "ModelOutput",
  "AssistantOutput",
]);

interface KimiTokenUsage {
  input_other?: unknown;
  output?: unknown;
  input_cache_read?: unknown;
  input_cache_creation?: unknown;
  // New format field names
  inputOther?: unknown;
  inputCacheRead?: unknown;
  inputCacheCreation?: unknown;
}

interface KimiPayload {
  timestamp?: string | number;
  model?: string;
  role?: string;
  token_usage?: KimiTokenUsage;
  message_id?: string;
}

interface KimiEvent {
  type?: string;
  timestamp?: string | number;
  time?: number; // Unix timestamp in milliseconds for usage.record
  payload?: KimiPayload;
  // New format fields for usage.record
  model?: string;
  usage?: KimiTokenUsage;
  usageScope?: string;
}

export interface KimiCodeParserOptions {
  sessionsDir?: string;
  configPath?: string;
}

function createToolDefinition(dataDir: string): ToolDefinition {
  return {
    id: TOOL_ID,
    name: TOOL_NAME,
    dataDir,
  };
}

function toSafeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function getPathLeaf(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = normalized.split("/").filter(Boolean).pop();
  return leaf || "unknown";
}

function findWireFiles(
  baseDir: string,
): Array<{ filePath: string; workDirHash: string }> {
  const results: Array<{ filePath: string; workDirHash: string }> = [];
  if (!existsSync(baseDir)) return results;

  try {
    for (const workDir of readdirSync(baseDir, { withFileTypes: true })) {
      if (!workDir.isDirectory()) continue;

      const workDirPath = join(baseDir, workDir.name);
      try {
        for (const session of readdirSync(workDirPath, {
          withFileTypes: true,
        })) {
          if (!session.isDirectory()) continue;

          // New structure: agents/main/wire.jsonl
          const newWireFile = join(
            workDirPath,
            session.name,
            "agents",
            "main",
            "wire.jsonl",
          );
          if (existsSync(newWireFile)) {
            results.push({ filePath: newWireFile, workDirHash: workDir.name });
            continue;
          }

          // Legacy structure: wire.jsonl directly in session dir
          const legacyWireFile = join(workDirPath, session.name, "wire.jsonl");
          if (existsSync(legacyWireFile)) {
            results.push({
              filePath: legacyWireFile,
              workDirHash: workDir.name,
            });
          }
        }
      } catch {
        // Ignore unreadable session directories and keep scanning.
      }
    }
  } catch {
    return results;
  }

  return results;
}

function parseTimestamp(value: string | number | undefined): Date | null {
  if (value == null) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function classifyKimiRole(
  type: string | undefined,
  payload: KimiPayload | undefined,
): SessionEvent["role"] | null {
  if (payload?.role === "user" || payload?.role === "assistant") {
    return payload.role;
  }

  if (type && USER_EVENT_TYPES.has(type)) {
    return "user";
  }

  if (type && ASSISTANT_EVENT_TYPES.has(type)) {
    return "assistant";
  }

  if (type?.toLowerCase().includes("assistant")) {
    return "assistant";
  }

  return null;
}

function loadProjectMap(configPath: string): Map<string, string> {
  const projectMap = new Map<string, string>();
  const content = readFileSafe(configPath);
  if (!content) return projectMap;

  try {
    const config = JSON.parse(content) as {
      version?: number;
      workspaces?: Record<
        string,
        string | { root?: string; path?: string; dir?: string; name?: string }
      >;
      projects?: Record<
        string,
        string | { root?: string; path?: string; dir?: string }
      >;
    };

    // New format: workspaces.json with { root, name }
    const workspaces = config.workspaces || config.projects || {};
    for (const [hash, info] of Object.entries(workspaces)) {
      let pathValue: string | undefined;
      if (typeof info === "string") {
        pathValue = info;
      } else {
        pathValue = info.root || info.path || info.dir || undefined;
      }
      if (!pathValue) continue;

      // Use name field if available, otherwise extract from path
      const name =
        typeof info === "object" && info.name
          ? info.name
          : getPathLeaf(pathValue);
      projectMap.set(hash, name);
    }
  } catch {
    // Ignore unreadable config and fall back to work-dir hashes.
  }

  return projectMap;
}

export class KimiCodeParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly sessionsDir: string;
  private readonly configPath: string;

  constructor(options: KimiCodeParserOptions = {}) {
    this.sessionsDir = options.sessionsDir || DEFAULT_SESSIONS_DIR;
    this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
    this.tool = createToolDefinition(this.sessionsDir);
  }

  async parse(): Promise<ParseResult> {
    const wireFiles = findWireFiles(this.sessionsDir);
    if (wireFiles.length === 0) {
      return { buckets: [], sessions: [] };
    }

    const projectMap = loadProjectMap(this.configPath);
    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];
    const seenMessageIds = new Set<string>();

    for (const { filePath, workDirHash } of wireFiles) {
      const content = readFileSafe(filePath);
      if (!content) continue;

      const sessionId = filePath;
      const project = projectMap.get(workDirHash) || workDirHash;
      let currentModel = "unknown";
      let lastTimestampRaw: string | number | undefined;

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;

        let obj: KimiEvent;
        try {
          obj = JSON.parse(line) as KimiEvent;
        } catch {
          continue;
        }

        // Handle new format: usage.record (no payload, uses top-level time)
        if (obj.type === "usage.record") {
          const timestampValue = obj.time;
          const timestamp = timestampValue ? new Date(timestampValue) : null;
          if (!timestamp || Number.isNaN(timestamp.getTime())) continue;

          const usage = obj.usage;
          if (!usage) continue;

          const inputTokens = toSafeNumber(
            usage.input_other ?? usage.inputOther,
          );
          const outputTokens = toSafeNumber(usage.output);
          const cachedTokens = toSafeNumber(
            usage.input_cache_read ?? usage.inputCacheRead,
          );

          if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0) {
            continue;
          }

          sessionEvents.push({
            sessionId,
            source: TOOL_ID,
            project,
            timestamp,
            role: "assistant",
          });

          entries.push({
            sessionId,
            source: TOOL_ID,
            model: obj.model || currentModel,
            project,
            timestamp,
            inputTokens,
            outputTokens,
            reasoningTokens: 0,
            cachedTokens,
          });
          continue;
        }

        // Handle legacy format with payload
        const payload = obj.payload;
        if (!payload) continue;

        if (payload.model) {
          currentModel = payload.model;
        }

        const timestampValue =
          payload.timestamp ?? obj.timestamp ?? lastTimestampRaw;
        const timestamp = parseTimestamp(timestampValue);
        if (payload.timestamp != null) {
          lastTimestampRaw = payload.timestamp;
        } else if (obj.timestamp != null) {
          lastTimestampRaw = obj.timestamp;
        }

        const role = classifyKimiRole(obj.type, payload);
        if (role && timestamp) {
          sessionEvents.push({
            sessionId,
            source: TOOL_ID,
            project,
            timestamp,
            role,
          });
        }

        // Handle legacy format: StatusUpdate
        if (obj.type !== "StatusUpdate") continue;

        const tokenUsage = payload.token_usage;
        if (!tokenUsage || !timestamp) continue;

        const inputTokens = toSafeNumber(tokenUsage.input_other);
        const outputTokens = toSafeNumber(tokenUsage.output);
        const cachedTokens = toSafeNumber(tokenUsage.input_cache_read);
        const cacheCreateTokens = toSafeNumber(tokenUsage.input_cache_creation);

        if (
          inputTokens === 0 &&
          outputTokens === 0 &&
          cachedTokens === 0 &&
          cacheCreateTokens === 0
        ) {
          continue;
        }

        if (payload.message_id) {
          if (seenMessageIds.has(payload.message_id)) continue;
          seenMessageIds.add(payload.message_id);
        }

        if (!role) {
          sessionEvents.push({
            sessionId,
            source: TOOL_ID,
            project,
            timestamp,
            role: "assistant",
          });
        }

        entries.push({
          sessionId,
          source: TOOL_ID,
          model: currentModel,
          project,
          timestamp,
          inputTokens,
          outputTokens,
          reasoningTokens: 0,
          cachedTokens,
        });
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  isInstalled(): boolean {
    return existsSync(this.sessionsDir);
  }
}

registerParser(new KimiCodeParser());
