import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import { hasInvalidTokenCounts } from "../domain/token-usage";
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

type JsonRecord = Record<string, unknown>;

type UsageSnapshot = {
  entry: TokenUsageEntry;
  completed: boolean;
  order: number;
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function getIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tokenCount(value: unknown): number {
  if (value == null) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : Number.NaN;
}

function selectSnapshot(
  current: UsageSnapshot | undefined,
  candidate: UsageSnapshot,
): UsageSnapshot {
  if (!current) return candidate;

  // 同一请求的 usage 是累计快照，完整响应优先，其次取输出最多的快照。
  const replace =
    candidate.completed !== current.completed
      ? candidate.completed
      : candidate.entry.outputTokens !== current.entry.outputTokens
        ? candidate.entry.outputTokens > current.entry.outputTokens
        : candidate.entry.timestamp > current.entry.timestamp;
  const selected = replace ? candidate : current;
  const owner = current.order < candidate.order ? current : candidate;

  // 跨文件副本只补全用量，不把请求迁移到最后扫描到的副本会话。
  return {
    ...selected,
    order: owner.order,
    entry: {
      ...selected.entry,
      sessionId: owner.entry.sessionId,
      project: owner.entry.project,
    },
  };
}

/**
 * Every directory `parse()` walks, in the same order.
 *
 * `parse()` and `listSourceFiles()` must agree on this set — a directory listed
 * in one but not the other either hides a change from the cache or invalidates
 * it for no reason.
 */
function getScanDirectories(): string[] {
  const directories: string[] = [];

  for (const root of getClaudeRoots()) {
    directories.push(join(root, "projects"));
  }

  for (const root of getClaudeRoots()) {
    for (const directory of ["transcripts", "sessions"]) {
      directories.push(join(root, directory));
    }
  }

  return directories;
}

class ClaudeCodeParser implements IParser {
  readonly tool = TOOL;

  listSourceFiles(): string[] {
    return getScanDirectories().flatMap((directory) =>
      findJsonlFiles(directory),
    );
  }

  async parse(): Promise<ParseResult> {
    const snapshots = new Map<string, Map<string, UsageSnapshot>>();
    const sessionEvents = new Map<string, SessionEvent>();
    const projectSessionIds = new Set<string>();
    let snapshotOrder = 0;

    const scanFile = (
      filePath: string,
      fileIdentity: string,
      project: string,
      includeUsage: boolean,
    ) => {
      const content = readFileSafe(filePath);
      if (!content) return;
      const sessionId = extractSessionId(filePath);
      if (includeUsage) projectSessionIds.add(sessionId);

      for (const [lineIndex, line] of content.split("\n").entries()) {
        if (!line.trim()) continue;
        try {
          const record = asRecord(JSON.parse(line));
          if (
            !record ||
            (typeof record.timestamp !== "string" &&
              typeof record.timestamp !== "number")
          ) {
            continue;
          }
          const timestamp = new Date(record.timestamp);
          if (Number.isNaN(timestamp.getTime())) continue;

          const message = asRecord(record.message);
          const messageId = getIdentifier(message?.id);
          const requestId =
            getIdentifier(record.requestId) ??
            getIdentifier(record.request_id) ??
            "";
          const uuid = getIdentifier(record.uuid);
          // 无 ID 的旧记录用文件相对位置和内容识别副本，保留同文件内独立的相同行。
          const anonymousId =
            uuid || messageId
              ? ""
              : createHash("sha256")
                  .update(JSON.stringify([fileIdentity, lineIndex, line]))
                  .digest("hex");
          const eventKey = uuid
            ? JSON.stringify(["uuid", uuid])
            : messageId
              ? JSON.stringify([
                  "message",
                  messageId,
                  requestId,
                  record.type,
                  record.timestamp,
                ])
              : JSON.stringify(["anonymous", anonymousId]);

          if (
            !sessionEvents.has(eventKey) &&
            (record.type === "user" ||
              record.type === "assistant" ||
              record.type === "tool_use" ||
              record.type === "tool_result")
          ) {
            sessionEvents.set(eventKey, {
              sessionId,
              source: "claude-code",
              project,
              timestamp,
              role: record.type === "user" ? "user" : "assistant",
            });
          }

          if (!includeUsage || record.type !== "assistant" || !message)
            continue;
          const usage = asRecord(message.usage);
          if (!usage) continue;
          const cacheCreation = asRecord(usage.cache_creation);
          // TTL 明细是合计的拆分，仅在缺失合计时回退，不能重复相加。
          const cacheCreationTokens = tokenCount(
            usage.cache_creation_input_tokens ??
              tokenCount(cacheCreation?.ephemeral_5m_input_tokens) +
                tokenCount(cacheCreation?.ephemeral_1h_input_tokens),
          );
          const event = sessionEvents.get(eventKey);
          const entry: TokenUsageEntry = {
            sessionId: event?.sessionId ?? sessionId,
            source: "claude-code",
            model: getIdentifier(message.model) ?? "unknown",
            project: event?.project ?? project,
            timestamp,
            inputTokens: tokenCount(usage.input_tokens),
            outputTokens: tokenCount(usage.output_tokens),
            reasoningTokens: 0,
            cachedTokens: tokenCount(usage.cache_read_input_tokens),
            cacheCreationTokens,
          };
          if (
            hasInvalidTokenCounts(entry) ||
            entry.inputTokens +
              entry.outputTokens +
              entry.cachedTokens +
              cacheCreationTokens ===
              0
          ) {
            continue;
          }

          const messageKey = messageId
            ? JSON.stringify(["message", messageId])
            : uuid
              ? JSON.stringify(["uuid", uuid])
              : JSON.stringify(["anonymous", anonymousId]);
          let requests = snapshots.get(messageKey);
          if (!requests) {
            requests = new Map();
            snapshots.set(messageKey, requests);
          }
          requests.set(
            requestId,
            selectSnapshot(requests.get(requestId), {
              entry,
              completed: getIdentifier(message.stop_reason) !== null,
              order: snapshotOrder++,
            }),
          );
        } catch {
          // 单行损坏不阻断其余会话记录。
        }
      }
    };

    const roots = getClaudeRoots();
    for (const root of roots) {
      const projectsDir = join(root, "projects");
      for (const filePath of findJsonlFiles(projectsDir)) {
        // 不按相对路径跳过整个副本文件，其他根目录可能多出尚未同步的消息。
        scanFile(
          filePath,
          join(
            "projects",
            projectRelativePath(filePath, projectsDir) ?? filePath,
          ),
          extractProject(filePath, projectsDir),
          true,
        );
      }
    }

    for (const root of roots) {
      for (const directory of ["transcripts", "sessions"]) {
        const transcriptDir = join(root, directory);
        for (const filePath of findJsonlFiles(transcriptDir)) {
          if (projectSessionIds.has(extractSessionId(filePath))) continue;
          scanFile(
            filePath,
            join(
              directory,
              projectRelativePath(filePath, transcriptDir) ?? filePath,
            ),
            "unknown",
            false,
          );
        }
      }
    }

    const entries: TokenUsageEntry[] = [];
    for (const requests of snapshots.values()) {
      const unidentified = requests.get("");
      // 早期流式记录可能没有 requestId；只有一个明确请求时才允许归并。
      if (unidentified && requests.size === 2) {
        const identified = Array.from(requests.entries()).find(([id]) => id);
        if (identified) {
          entries.push(selectSnapshot(unidentified, identified[1]).entry);
          continue;
        }
      }
      entries.push(
        ...Array.from(requests.values(), (snapshot) => snapshot.entry),
      );
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(Array.from(sessionEvents.values()), entries),
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
