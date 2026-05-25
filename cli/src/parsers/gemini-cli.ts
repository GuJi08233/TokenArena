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
    input_tokens?: number;
    output_tokens?: number;
  };
  usageMetadata?: GeminiMessage["usage"];
  token_count?: GeminiMessage["usage"];
}

interface GeminiRecord {
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
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
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
    return { messages, directories, model, createTime };
  }

  let data: {
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

class GeminiCliParser implements IParser {
  readonly tool = TOOL;

  async parse(): Promise<ParseResult> {
    const sessionFiles = findSessionFiles(TOOL.dataDir);
    if (sessionFiles.length === 0) {
      return { buckets: [], sessions: [] };
    }

    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];

    for (const filePath of sessionFiles) {
      const record = readRecord(filePath);
      if (!record) continue;

      const project = projectFromDirectories(record.directories);

      for (const msg of record.messages) {
        const role = classifyRole(msg);
        if (!role) continue;

        const timestamp = msg.timestamp || msg.createTime || record.createTime;
        if (!timestamp) continue;
        const ts = new Date(timestamp);
        if (Number.isNaN(ts.getTime())) continue;

        sessionEvents.push({
          sessionId: filePath,
          source: "gemini-cli",
          project,
          timestamp: ts,
          role,
        });

        const tokens = msg.tokens;
        const usage = msg.usage || msg.usageMetadata || msg.token_count;
        if (!tokens && !usage) continue;

        // Gemini's `output` already includes thoughts and `input` already
        // includes cached — subtract to avoid double-counting reasoning/cached.
        if (tokens) {
          const cached = tokens.cached || 0;
          const thoughts = tokens.thoughts || 0;
          entries.push({
            sessionId: filePath,
            source: "gemini-cli",
            model: msg.model || record.model || "unknown",
            project,
            timestamp: ts,
            inputTokens: (tokens.input || 0) - cached,
            outputTokens: (tokens.output || 0) - thoughts,
            reasoningTokens: thoughts,
            cachedTokens: cached,
          });
        } else if (usage) {
          const cached = usage.cachedContentTokenCount || 0;
          const thoughts = usage.thoughtsTokenCount || 0;
          entries.push({
            sessionId: filePath,
            source: "gemini-cli",
            model: msg.model || record.model || "unknown",
            project,
            timestamp: ts,
            inputTokens:
              (usage.promptTokenCount || usage.input_tokens || 0) - cached,
            outputTokens:
              (usage.candidatesTokenCount || usage.output_tokens || 0) -
              thoughts,
            reasoningTokens: thoughts,
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
}

registerParser(new GeminiCliParser());
