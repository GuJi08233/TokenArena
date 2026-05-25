import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
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
  readFileSafe,
} from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL: ToolDefinition = {
  id: "claude-code",
  name: "Claude Code",
  dataDir: join(homedir(), ".claude", "projects"),
};

function getClaudeRoots(): string[] {
  const roots = [join(homedir(), ".claude")];

  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) {
    let custom = cfg;
    if (custom.startsWith("~")) custom = join(homedir(), custom.slice(1));
    custom = custom.replace(/[/\\]+$/, "") || custom;
    roots.push(custom);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of roots) {
    let key = r;
    try {
      key = realpathSync(r);
    } catch {
      // dir may not exist yet
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  return unique;
}

function projectRelativePath(
  filePath: string,
  projectsDir: string,
): string | null {
  const prefix = projectsDir + sep;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

function extractProject(filePath: string, projectsDir: string): string {
  const relative = projectRelativePath(filePath, projectsDir);
  if (!relative) return "unknown";
  const firstSegment = relative.split(sep)[0];
  if (!firstSegment) return "unknown";
  const parts = firstSegment.split("-").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "unknown";
}

class ClaudeCodeParser implements IParser {
  readonly tool = TOOL;

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const sessionEvents: SessionEvent[] = [];
    const seenUuids = new Set<string>();
    const seenSessionIds = new Set<string>();
    const seenProjectFiles = new Set<string>();

    const roots = getClaudeRoots();

    for (const root of roots) {
      const projectsDir = join(root, "projects");
      const projectFiles = findJsonlFiles(projectsDir);

      for (const filePath of projectFiles) {
        const relative = projectRelativePath(filePath, projectsDir);
        if (relative !== null) {
          if (seenProjectFiles.has(relative)) continue;
          seenProjectFiles.add(relative);
        }

        const content = readFileSafe(filePath);
        if (!content) continue;

        const project = extractProject(filePath, projectsDir);
        const sessionId = extractSessionId(filePath);
        seenSessionIds.add(sessionId);

        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const timestamp = obj.timestamp;
            if (!timestamp) continue;

            const parsedTimestamp = new Date(timestamp);
            if (Number.isNaN(parsedTimestamp.getTime())) continue;

            if (
              obj.type === "user" ||
              obj.type === "assistant" ||
              obj.type === "tool_use" ||
              obj.type === "tool_result"
            ) {
              sessionEvents.push({
                sessionId,
                source: "claude-code",
                project,
                timestamp: parsedTimestamp,
                role: obj.type === "user" ? "user" : "assistant",
              });
            }

            if (obj.type !== "assistant") continue;
            const message = obj.message;
            if (!message?.usage) continue;

            const usage = message.usage;
            if (usage.input_tokens == null && usage.output_tokens == null) {
              continue;
            }

            const uuid = obj.uuid;
            if (uuid) {
              if (seenUuids.has(uuid)) continue;
              seenUuids.add(uuid);
            }

            entries.push({
              sessionId,
              source: "claude-code",
              model: message.model || "unknown",
              project,
              timestamp: parsedTimestamp,
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              reasoningTokens: 0,
              cachedTokens: usage.cache_read_input_tokens || 0,
            });
          } catch {
            // Ignore malformed lines and continue scanning the session log.
          }
        }
      }
    }

    for (const root of roots) {
      for (const transcriptsDir of ["transcripts", "sessions"]) {
        const transcriptFiles = findJsonlFiles(join(root, transcriptsDir));

        for (const filePath of transcriptFiles) {
          const sessionId = extractSessionId(filePath);
          if (seenSessionIds.has(sessionId)) continue;
          seenSessionIds.add(sessionId);

          const content = readFileSafe(filePath);
          if (!content) continue;

          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const timestamp = obj.timestamp;
              if (!timestamp) continue;

              const parsedTimestamp = new Date(timestamp);
              if (Number.isNaN(parsedTimestamp.getTime())) continue;

              if (
                obj.type === "user" ||
                obj.type === "assistant" ||
                obj.type === "tool_use" ||
                obj.type === "tool_result"
              ) {
                sessionEvents.push({
                  sessionId,
                  source: "claude-code",
                  project: "unknown",
                  timestamp: parsedTimestamp,
                  role: obj.type === "user" ? "user" : "assistant",
                });
              }
            } catch {
              // Ignore malformed lines and continue scanning the transcript log.
            }
          }
        }
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
    };
  }

  isInstalled(): boolean {
    const roots = getClaudeRoots();
    return roots.some(
      (root) =>
        existsSync(join(root, "projects")) ||
        existsSync(join(root, "transcripts")) ||
        existsSync(join(root, "sessions")),
    );
  }
}

registerParser(new ClaudeCodeParser());
