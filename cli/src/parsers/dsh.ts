import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as zlib from "node:zlib";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { parseJsonl } from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "dsh";
const TOOL_NAME = "DeepSeek Harness";
const DEFAULT_SESSIONS_DIR = join(homedir(), ".dsh", "sessions");
const LOG_BASENAME = "session";

interface DshTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * One JSONL record: the leading `session` header line (id/cwd) or an event
 * line (seq/time/data). All fields optional; unknown event types are skipped.
 */
interface DshLine {
  type?: string;
  seq?: number;
  time?: number;
  id?: string;
  cwd?: string;
  data?: {
    message?: {
      source?: { kind?: string };
    };
    usage?: DshTokenUsage;
    model?: string;
    header?: {
      config?: {
        model?: string;
      };
    };
  };
}

function getDshSessionsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    env.TOKEN_ARENA_DSH_DIR,
    env.DSH_HOME ? join(env.DSH_HOME, "sessions") : undefined,
    DEFAULT_SESSIONS_DIR,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(dirs));
}

function toNonNegativeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

/**
 * Byte ranges of structurally complete Zstandard frames in a concatenated
 * stream. A torn final frame (crash-truncated write) is excluded; corrupt
 * structure mid-file stops the scan, mirroring dsh's own frame scanner.
 */
function scanZstdFrames(buffer: Buffer): Array<[number, number]> {
  const ZSTD_MAGIC = 0xfd2fb528;
  const frames: Array<[number, number]> = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;

    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) break;

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;

    let complete = true;
    for (;;) {
      if (buffer.length - offset < 3) {
        complete = false;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        complete = false;
        break;
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        complete = false;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!complete) break;

    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push([start, offset]);
  }

  return frames;
}

/**
 * Decompress a `.jsonl.zstd` session log. dsh writes one independently
 * decodable frame per batch, so frames are split first and decompressed one at
 * a time (a one-shot decompress only returns the first frame's plaintext).
 * Frames that fail to decompress are skipped; returns null when the runtime
 * lacks zstd support (Node < 22.15) or nothing could be decoded.
 */
function decompressZstdLog(buffer: Buffer): string | null {
  if (typeof zlib.zstdDecompressSync !== "function") return null;

  const chunks: Buffer[] = [];
  for (const [start, end] of scanZstdFrames(buffer)) {
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      // skip undecodable frame
    }
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf-8");
}

function readSessionLog(filePath: string): string | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  if (filePath.endsWith(".zstd")) {
    return decompressZstdLog(buffer);
  }
  return buffer.toString("utf-8");
}

/** Recursively collect `session.jsonl`/`session.jsonl.zstd` artifacts. */
function findSessionLogs(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findSessionLogs(fullPath));
      } else if (
        entry.name === `${LOG_BASENAME}.jsonl` ||
        entry.name === `${LOG_BASENAME}.jsonl.zstd`
      ) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

/** Reverse dsh's `encodeSegment`: `~XXXX` escapes back to raw characters. */
function decodeSegment(segment: string): string {
  return segment.replace(/~([0-9A-F]{4})/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

/**
 * Recover a display project name from dsh's lossy project directory key
 * (`--{slug}--`, separators collapsed to `-`): the last dash-separated piece.
 */
function projectFromDirName(name: string): string {
  if (name === "_no-cwd") return "unknown";
  const slug = name.replace(/^-+/, "").replace(/-+$/, "");
  if (!slug) return "unknown";
  const parts = slug.split("-").filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
}

export class DshParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly sessionsDirs: string[];

  constructor(sessionsDir?: string) {
    this.sessionsDirs = sessionsDir ? [sessionsDir] : getDshSessionsDirs();
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
      for (const filePath of findSessionLogs(sessionsDir)) {
        const content = readSessionLog(filePath);
        if (!content) continue;

        const rows = parseJsonl<DshLine>(content);
        if (rows.length === 0) continue;

        const relativeParts = filePath
          .slice(sessionsDir.length + 1)
          .split(/[\\/]/);
        const header = rows[0]?.type === "session" ? rows[0] : undefined;
        const sessionId =
          (header?.id ?? decodeSegment(relativeParts[1] ?? "")) || "unknown";
        const project =
          typeof header?.cwd === "string" && header.cwd
            ? basename(header.cwd) || "unknown"
            : projectFromDirName(relativeParts[0] ?? "");

        let currentModel = "unknown";
        for (const row of rows) {
          if (row.type === "request/context") {
            const model = row.data?.model;
            if (typeof model === "string" && model) currentModel = model;
            continue;
          }
          if (row.type === "request/header") {
            const model = row.data?.header?.config?.model;
            if (typeof model === "string" && model) currentModel = model;
            continue;
          }

          const timestamp =
            typeof row.time === "number" && Number.isFinite(row.time)
              ? new Date(row.time)
              : null;

          if (row.type === "user/message") {
            // Plugin-source user rows are injected context, not human prompts.
            if (row.data?.message?.source?.kind !== "user") continue;
            if (timestamp) {
              sessionEvents.push({
                sessionId,
                source: TOOL_ID,
                project,
                timestamp,
                role: "user",
              });
            }
            continue;
          }

          if (row.type !== "assistant/message") continue;
          if (timestamp) {
            sessionEvents.push({
              sessionId,
              source: TOOL_ID,
              project,
              timestamp,
              role: "assistant",
            });
          }

          const usage = row.data?.usage;
          if (!usage || timestamp === null) continue;

          const inputTokens = toNonNegativeNumber(usage.inputTokens);
          const outputTokens = toNonNegativeNumber(usage.outputTokens);
          const cachedTokens =
            toNonNegativeNumber(usage.cacheReadTokens) +
            toNonNegativeNumber(usage.cacheWriteTokens);
          const reasoningTokens = toNonNegativeNumber(usage.reasoningTokens);

          if (inputTokens + outputTokens + cachedTokens === 0) continue;

          const entryKey = [
            sessionId,
            timestamp.toISOString(),
            currentModel,
            inputTokens,
            outputTokens,
            cachedTokens,
          ].join("|");
          if (seenEntryKeys.has(entryKey)) continue;
          seenEntryKeys.add(entryKey);

          entries.push({
            sessionId,
            source: TOOL_ID,
            model: currentModel,
            project,
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

registerParser(new DshParser());
