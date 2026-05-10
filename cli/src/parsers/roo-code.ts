import { readdirSync, readFileSync, statSync } from "node:fs";
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

const EXTENSION_ID = "rooveterinaryinc.roo-cline";

const HOSTS = [
  "Code",
  "Cursor",
  "Windsurf",
  "VSCodium",
  "Code - Insiders",
  "Trae",
  "Trae CN",
];

function getHostRoots(): string[] {
  const out: string[] = [];
  let roots: string[];
  if (process.platform === "darwin") {
    roots = [join(homedir(), "Library", "Application Support")];
  } else if (process.platform === "win32") {
    roots = [
      process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"),
    ];
  } else {
    roots = [process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")];
  }
  for (const root of roots) {
    for (const h of HOSTS) {
      out.push(join(root, h));
    }
  }
  return out;
}

function findExtensionDirs(): string[] {
  const dirs: string[] = [];
  for (const root of getHostRoots()) {
    const ext = join(root, "User", "globalStorage", EXTENSION_ID);
    try {
      if (statSync(ext).isDirectory()) dirs.push(ext);
    } catch {
      // not installed in this host; skip
    }
  }
  return dirs;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function projectFromPath(absPath: string | undefined): string {
  if (!absPath || typeof absPath !== "string") return "unknown";
  const trimmed = absPath.replace(/[\\/]+$/, "");
  const name = basename(trimmed);
  return name || "unknown";
}

interface HistoryItem {
  id: string | number;
  workspace?: string;
  apiConfigName?: string;
}

interface UiMessage {
  type?: string;
  say?: string;
  ts?: number;
  text?: string;
}

function readHistoryItems(extDir: string): HistoryItem[] {
  const tasksDir = join(extDir, "tasks");
  const index = readJsonSafe<{ entries?: HistoryItem[] }>(
    join(tasksDir, "_index.json"),
  );
  if (index?.entries && Array.isArray(index.entries)) return index.entries;

  const items: HistoryItem[] = [];
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of names) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith("_") ||
      entry.name.startsWith(".")
    )
      continue;
    const item = readJsonSafe<HistoryItem>(
      join(tasksDir, entry.name, "history_item.json"),
    );
    if (item && typeof item === "object") items.push(item);
  }
  return items;
}

const TOOL: ToolDefinition = {
  id: "roo-code",
  name: "Roo Code",
  dataDir: getHostRoots()[0] ?? "",
};

class RooCodeParser implements IParser {
  readonly tool = TOOL;

  async parse(): Promise<ParseResult> {
    const extDirs = findExtensionDirs();
    if (extDirs.length === 0) return { buckets: [], sessions: [] };

    const entries: TokenUsageEntry[] = [];
    const events: SessionEvent[] = [];

    for (const extDir of extDirs) {
      const items = readHistoryItems(extDir);
      if (!items.length) continue;

      for (const item of items) {
        if (!item || typeof item !== "object" || !item.id) continue;
        const taskId = String(item.id);
        const project = projectFromPath(item.workspace);
        const fallbackModel =
          (item.apiConfigName && String(item.apiConfigName).trim()) ||
          "roo-unknown";

        const messages = readJsonSafe<UiMessage[]>(
          join(extDir, "tasks", taskId, "ui_messages.json"),
        );
        if (!Array.isArray(messages)) continue;

        for (const msg of messages) {
          if (!msg || typeof msg !== "object") continue;
          const ts = Number(msg.ts);
          if (!Number.isFinite(ts)) continue;
          const timestamp = new Date(ts);

          if (msg.type === "say" && msg.say === "api_req_started") {
            let info: {
              tokensIn?: number;
              tokensOut?: number;
              cacheWrites?: number;
              cacheReads?: number;
              model?: string;
            } | null = null;
            try {
              info = JSON.parse(msg.text ?? "");
            } catch {
              // skip
            }
            if (!info) continue;

            const inputTokens = Math.max(0, Number(info.tokensIn) || 0);
            const outputTokens = Math.max(0, Number(info.tokensOut) || 0);
            const cacheWrites = Math.max(0, Number(info.cacheWrites) || 0);
            const cacheReads = Math.max(0, Number(info.cacheReads) || 0);
            if (inputTokens + outputTokens + cacheWrites + cacheReads === 0)
              continue;

            const model =
              (info.model && String(info.model).trim()) || fallbackModel;

            entries.push({
              sessionId: taskId,
              source: "roo-code",
              model,
              project,
              timestamp,
              inputTokens: inputTokens + cacheWrites,
              outputTokens,
              reasoningTokens: 0,
              cachedTokens: cacheReads,
            });
            events.push({
              sessionId: taskId,
              source: "roo-code",
              project,
              timestamp,
              role: "assistant",
            });
          } else if (
            msg.type === "ask" ||
            (msg.type === "say" && msg.say === "user_feedback")
          ) {
            events.push({
              sessionId: taskId,
              source: "roo-code",
              project,
              timestamp,
              role: "user",
            });
          }
        }
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(events, entries),
    };
  }

  isInstalled(): boolean {
    return findExtensionDirs().length > 0;
  }
}

registerParser(new RooCodeParser());
