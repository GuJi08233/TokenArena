import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL: ToolDefinition = {
  id: "gemini-cli",
  name: "Gemini CLI",
  dataDir: join(homedir(), ".gemini", "tmp"),
};

// Gemini CLI session storage:
//   ~/.gemini/tmp/<hash>/chats/session-<ts>-<id>.jsonl    (current, v0.39+)
//   ~/.gemini/tmp/<hash>/chats/session-<ts>-<id>.json     (legacy single-object)
//   ~/.gemini/tmp/<hash>/chats/<parent>/<sub>.jsonl       (nested subagent sessions)
// The .jsonl migration (PR #23749, ~v0.39.0) means a .json-only glob misses every
// new session — collect both extensions and descend one level for subagent files.
function findSessionFiles(baseDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(baseDir)) return results;

  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    collectChatFiles(join(baseDir, entry.name, "chats"), results, 0);
  }
  return results;
}

function collectChatFiles(dir: string, out: string[], depth: number): void {
  if (depth > 2) return; // chats/ + nested subagent dir is as deep as it goes
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      collectChatFiles(full, out, depth + 1);
    } else if (e.name.endsWith(".jsonl") || e.name.endsWith(".json")) {
      out.push(full);
    }
  }
}

interface GeminiMessage {
  id?: string;
  type?: string;
  role?: string;
  timestamp?: string;
  createTime?: string;
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
  };
  usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  usageMetadata?: GeminiMessage["usage"];
  token_count?: GeminiMessage["usage"];
}

interface GeminiRecord {
  sessionId: string | null;
  messages: GeminiMessage[];
  directories: string[] | null;
  model: string | null;
  createTime: string | null;
}

// .jsonl: line 1 is session metadata (carries `directories`), each following line
// is one event record identified by `type` or `role`. .json: single ConversationRecord.
function readRecord(filePath: string): GeminiRecord | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  if (filePath.endsWith(".jsonl")) {
    const messages: GeminiMessage[] = [];
    let directories: string[] | null = null;
    let model: string | null = null;
    let createTime: string | null = null;
    let sessionId: string | null = null;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (!directories && Array.isArray(obj.directories)) {
        directories = obj.directories as string[];
        if (typeof obj.model === "string") model = obj.model;
        if (typeof obj.createTime === "string") createTime = obj.createTime;
        continue;
      }
      if (typeof obj.type === "string" || typeof obj.role === "string") {
        messages.push(obj as GeminiMessage);
      }
    }
    return { messages, directories, model, createTime, sessionId };
  }

  let data: {
    sessionId?: string;
    messages?: GeminiMessage[];
    history?: GeminiMessage[];
    directories?: string[];
    model?: string;
    createTime?: string;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return {
    sessionId: typeof data?.sessionId === "string" ? data.sessionId : null,
    messages: Array.isArray(data?.messages)
      ? data.messages
      : Array.isArray(data?.history)
        ? data.history
        : [],
    directories: Array.isArray(data?.directories) ? data.directories : null,
    model: typeof data?.model === "string" ? data.model : null,
    createTime: typeof data?.createTime === "string" ? data.createTime : null,
  };
}

// .jsonl format records assistant turns as `type: 'gemini'`; legacy .json uses
// `role: 'assistant'`. Accept both, plus the raw API `role: 'model'`.
function classifyRole(msg: GeminiMessage): "user" | "assistant" | null {
  const t = msg.type ?? msg.role;
  if (t === "user") return "user";
  if (t === "gemini" || t === "model" || t === "assistant") return "assistant";
  return null;
}

function projectFromDirectories(directories: string[] | null): string {
  if (!directories || directories.length === 0) return "unknown";
  const first = directories[0];
  if (!first) return "unknown";
  return basename(String(first).replace(/[\\/]+$/, "")) || "unknown";
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function selectUsageSnapshot(
  current: TokenUsageEntry | undefined,
  candidate: TokenUsageEntry,
): TokenUsageEntry {
  if (!current) return candidate;
  const total = (entry: TokenUsageEntry) =>
    entry.inputTokens +
    entry.outputTokens +
    entry.reasoningTokens +
    entry.cachedTokens;
  const currentTotal = total(current);
  const candidateTotal = total(candidate);
  // 空占位快照不能覆盖已有计费量；其余优先有效新时间，同时间保留更完整的量。
  if (candidateTotal === 0 && currentTotal > 0) return current;
  if (candidate.timestamp.getTime() !== current.timestamp.getTime()) {
    return candidate.timestamp > current.timestamp ? candidate : current;
  }
  if (candidateTotal !== currentTotal)
    return candidateTotal > currentTotal ? candidate : current;
  return current.model === "unknown" && candidate.model !== "unknown"
    ? candidate
    : current;
}

class GeminiCliParser implements IParser {
  readonly tool = TOOL;

  async parse(): Promise<ParseResult> {
    const sessionFiles = findSessionFiles(TOOL.dataDir);
    if (sessionFiles.length === 0) {
      return { buckets: [], sessions: [] };
    }

    const entries = new Map<string, TokenUsageEntry>();
    const sessionEvents = new Map<string, SessionEvent>();
    const storeEntry = (key: string, entry: TokenUsageEntry) => {
      entries.set(key, selectUsageSnapshot(entries.get(key), entry));
    };

    for (const filePath of sessionFiles) {
      const record = readRecord(filePath);
      if (!record) continue;

      const project = projectFromDirectories(record.directories);
      const sessionId = record.sessionId || filePath;

      for (const [index, msg] of record.messages.entries()) {
        if (!msg || typeof msg !== "object") continue;
        const role = classifyRole(msg);
        if (!role) continue;

        const timestamp = msg.timestamp || msg.createTime || record.createTime;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (Number.isNaN(ts.getTime())) continue;

        // 稳定会话和消息 ID 合并副本，快照选择不得依赖文件遍历顺序。
        const key = JSON.stringify([
          sessionId,
          msg.id || `${filePath}:${index}`,
        ]);
        if (
          (sessionEvents.get(key)?.timestamp.getTime() ?? -Infinity) <=
          ts.getTime()
        )
          sessionEvents.set(key, {
            sessionId,
            source: "gemini-cli",
            project,
            timestamp: ts,
            role,
          });
        if (role !== "assistant") continue;

        const tokens = msg.tokens;
        const usage = msg.usage || msg.usageMetadata || msg.token_count;
        if (!tokens && !usage) continue;

        // Gemini 的 output/candidates 与 thoughts 分开上报，只有输入含缓存。
        if (tokens) {
          const cached = tokenCount(tokens.cached);
          const input = tokenCount(tokens.input);
          const thoughts = tokenCount(tokens.thoughts);
          storeEntry(key, {
            sessionId,
            source: "gemini-cli",
            model: msg.model || record.model || "unknown",
            project,
            timestamp: ts,
            inputTokens: input >= cached ? input - cached : input,
            outputTokens: tokenCount(tokens.output),
            reasoningTokens: thoughts,
            cachedTokens: cached,
          });
        } else if (usage) {
          const cached = tokenCount(usage.cachedContentTokenCount);
          const thoughts = tokenCount(usage.thoughtsTokenCount);
          const input = tokenCount(
            usage.promptTokenCount ?? usage.input_tokens,
          );
          const output = usage.candidatesTokenCount ?? usage.output_tokens;
          storeEntry(key, {
            sessionId,
            source: "gemini-cli",
            model: msg.model || record.model || "unknown",
            project,
            timestamp: ts,
            inputTokens: input >= cached ? input - cached : input,
            outputTokens:
              output !== undefined
                ? tokenCount(output)
                : Math.max(
                    0,
                    tokenCount(usage.totalTokenCount) - input - thoughts,
                  ),
            reasoningTokens: thoughts,
            cachedTokens: cached,
          });
        }
      }
    }

    return {
      buckets: aggregateToBuckets([...entries.values()]),
      sessions: extractSessions(
        [...sessionEvents.values()],
        [...entries.values()],
      ),
    };
  }
}

registerParser(new GeminiCliParser());
