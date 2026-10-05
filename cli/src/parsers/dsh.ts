import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as zlib from "node:zlib";
import { aggregateToBuckets } from "../domain/aggregator";
import { extractSessions } from "../domain/session-extractor";
import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";
import { parseJsonl } from "../infrastructure/fs/utils";
import { logger } from "../utils/logger";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "dsh";
const TOOL_NAME = "DeepSeek Harness";
const DEFAULT_SESSIONS_DIR = join(homedir(), ".dsh", "sessions");

/**
 * A session log's file name, by storage generation.
 *
 * dsh publishes one generation per on-disk format change: v0 carries no version
 * segment, and every later generation appends `vN` — the layout notes that
 * "later versions use vN", so the suffix has to be matched generically rather
 * than enumerated. Matching only the v0 names found nothing at all on any newer
 * release, which turned the whole source into a silent zero.
 */
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

/** v0 is the generation without a version segment. */
const LEGACY_GENERATION = 0;

interface DshTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface DshMessageSource {
  kind?: string;
  model?: string;
  /** Stamped by the control RPC on what a person submits. */
  rpcId?: string;
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
  /** Header: absent or 0 for a top-level session, parent depth + 1 below. */
  delegationDepth?: number;
  /** v0 header: how many leading events a fork inherited. */
  seedLength?: number;
  data?: {
    /** `user/message` rows carry the UserMessage inline: `data.source.kind`. */
    source?: DshMessageSource;
    message?: {
      source?: DshMessageSource;
    };
    usage?: DshTokenUsage;
    model?: string;
    header?: {
      config?: {
        model?: string;
      };
    };
    /** `session/end-seed`: closes the prefix a fork copied from its source. */
    inherited?: boolean;
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

/** The generation a session log file name declares, or null if it is not one. */
export function getSessionLogGeneration(fileName: string): number | null {
  const match = SESSION_LOG_PATTERN.exec(fileName);
  if (!match) return null;
  return match[1] === undefined ? LEGACY_GENERATION : Number(match[1]);
}

function toNonNegativeNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function toModelName(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
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
 *
 * `damaged` distinguishes "this runtime has no zstd" from "committed frames
 * would not decode". The first is a missing capability, the second a corrupt
 * log; only the latter may under-count, so the caller must not treat them
 * alike. The container is authoritative rather than zstd's own decoder because
 * a truncated tail frame is expected after a crash and is not corruption.
 */
function decompressZstdLog(buffer: Buffer): {
  text: string | null;
  damaged: boolean;
} {
  if (typeof zlib.zstdDecompressSync !== "function") {
    return { text: null, damaged: false };
  }

  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) return { text: null, damaged: false };

  const chunks: Buffer[] = [];
  let damaged = false;
  for (const [start, end] of frames) {
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      damaged = true;
    }
  }

  if (chunks.length === 0) return { text: null, damaged };
  return { text: Buffer.concat(chunks).toString("utf-8"), damaged };
}

function readSessionLog(log: DshSessionLog): {
  text: string | null;
  damaged: boolean;
} {
  let buffer: Buffer;
  try {
    buffer = readFileSync(log.filePath);
  } catch {
    return { text: null, damaged: false };
  }
  if (log.compressed) {
    return decompressZstdLog(buffer);
  }
  return { text: buffer.toString("utf-8"), damaged: false };
}

interface DshSessionLog {
  filePath: string;
  /** Storage generation named by the file; higher is newer. */
  generation: number;
  /** The compressed root and the raw root encode one log, not two. */
  compressed: boolean;
  /** The configured root this log was found under, for relative paths. */
  rootDir: string;
}

/** Recursively collect session logs of every storage generation. */
function findSessionLogs(dir: string, rootDir = dir): DshSessionLog[] {
  const results: DshSessionLog[] = [];
  if (!existsSync(dir)) return results;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findSessionLogs(fullPath, rootDir));
        continue;
      }

      const generation = getSessionLogGeneration(entry.name);
      if (generation === null) continue;
      results.push({
        filePath: fullPath,
        generation,
        compressed: entry.name.endsWith(".zstd"),
        rootDir,
      });
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

function isNewerLog(candidate: DshSessionLog, current: DshSessionLog): boolean {
  if (candidate.generation !== current.generation) {
    return candidate.generation > current.generation;
  }
  if (candidate.compressed !== current.compressed) return candidate.compressed;
  // Same generation and encoding should not occur; keep the choice stable.
  return candidate.filePath < current.filePath;
}

/**
 * The single log `parse()` should read for each session directory.
 *
 * dsh owns one directory per session and renames the log when the on-disk
 * format changes, so more than one generation can be left behind. Reading them
 * all would bill an upgraded session twice, and dsh itself resolves a session by
 * its numerically highest canonical generation. The compressed and raw roots are
 * alternative encodings of the same log; the compressed one is the default.
 */
function selectCurrentSessionLogs(logs: DshSessionLog[]): DshSessionLog[] {
  const byDirectory = new Map<string, DshSessionLog>();

  for (const log of logs) {
    const directory = dirname(log.filePath);
    const current = byDirectory.get(directory);
    if (!current || isNewerLog(log, current)) {
      byDirectory.set(directory, log);
    }
  }

  return Array.from(byDirectory.values()).sort((left, right) =>
    left.filePath < right.filePath
      ? -1
      : left.filePath > right.filePath
        ? 1
        : 0,
  );
}

/** The logs a parser instance reads, across its configured roots. */
function currentSessionLogs(roots: string[]): DshSessionLog[] {
  const logs: DshSessionLog[] = [];
  for (const dir of roots) {
    logs.push(...findSessionLogs(dir));
  }
  return selectCurrentSessionLogs(logs);
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
 * `~XXXX` escapes are decoded afterwards, so non-ASCII and spaced directory
 * names read as themselves instead of leaking the escape form.
 */
function projectFromDirName(name: string): string {
  if (name === "_no-cwd") return "unknown";
  const slug = name.replace(/^-+/, "").replace(/-+$/, "");
  if (!slug) return "unknown";
  const parts = slug.split("-").filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? decodeSegment(last) || "unknown" : "unknown";
}

/**
 * Index of the first row the session owns rather than inherited by forking.
 *
 * A fork starts with its source's events copied verbatim — usage, prompts and
 * timestamps included — and the source session already billed them. dsh ends
 * the copy with the last `session/end-seed` marked `inherited`; v0 headers
 * counted the copied events in `seedLength` instead.
 */
function firstOwnRowIndex(rows: DshLine[]): number {
  const bodyStart = rows[0]?.type === "session" ? 1 : 0;
  const seedLength = bodyStart === 1 ? rows[0].seedLength : undefined;
  if (typeof seedLength === "number" && seedLength > 0) {
    const index = rows.findIndex(
      (row, position) =>
        position >= bodyStart &&
        typeof row.seq === "number" &&
        row.seq >= seedLength,
    );
    return index === -1 ? rows.length : index;
  }

  let firstOwn = bodyStart;
  for (let index = bodyStart; index < rows.length; index++) {
    const row = rows[index];
    if (row.type === "session/end-seed" && row.data?.inherited === true) {
      firstOwn = index + 1;
    }
  }
  return firstOwn;
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
    let incomplete = false;

    const logs = currentSessionLogs(this.sessionsDirs);
    for (const log of logs) {
      const { text: content, damaged } = readSessionLog(log);
      if (content === null) {
        // Absent between the walk and the read means dsh removed it; still
        // present means it was readable a moment ago, so its usage is missing.
        if (existsSync(log.filePath)) incomplete = true;
        continue;
      }
      if (damaged) {
        // Committed frames refusing to decode under-count this log, and the
        // upload replaces the device snapshot, so the whole source defers.
        logger.warn(
          `dsh session log ${log.filePath} has frames that could not be decompressed.`,
        );
        incomplete = true;
        continue;
      }

      const rows = parseJsonl<DshLine>(content);
      if (rows.length === 0) continue;

      const relativeParts = log.filePath
        .slice(log.rootDir.length + 1)
        .split(/[\\/]/);
      const header = rows[0]?.type === "session" ? rows[0] : undefined;
      const sessionId =
        (header?.id ?? decodeSegment(relativeParts[1] ?? "")) || "unknown";
      const project =
        typeof header?.cwd === "string" && header.cwd
          ? basename(header.cwd) || "unknown"
          : projectFromDirName(relativeParts[0] ?? "");

      const firstOwn = firstOwnRowIndex(rows);
      // A subagent's task is its parent agent's prompt, not a person's. dsh
      // delivers it as the child's first user-kind message with a bare source;
      // a person prompting the child goes through the control RPC, which
      // stamps `rpcId` on the message.
      let delegatedTaskPending = (header?.delegationDepth ?? 0) > 0;

      let currentModel = "unknown";
      for (const [index, row] of rows.entries()) {
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

        // Rows a fork copied were billed in its source session; they still
        // set the route its own calls inherit, but count nothing here.
        const inherited = index < firstOwn;
        const timestamp =
          typeof row.time === "number" && Number.isFinite(row.time)
            ? new Date(row.time)
            : null;

        if (row.type === "user/message") {
          if (inherited) continue;
          // Plugin-source user rows are injected context, not human prompts.
          // The UserMessage sits inline on `data`; older logs nested it.
          const sourceKind =
            row.data?.source?.kind ?? row.data?.message?.source?.kind;
          if (sourceKind !== "user") continue;
          if (delegatedTaskPending) {
            delegatedTaskPending = false;
            const rpcId =
              row.data?.source?.rpcId ?? row.data?.message?.source?.rpcId;
            if (rpcId === undefined) continue;
          }
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

        // Compaction summaries are their own billed model call, logged with
        // the model that wrote them rather than the session's current route.
        const isCompaction = row.type === "compaction/summary";
        if (row.type !== "assistant/message" && !isCompaction) continue;
        if (timestamp && !isCompaction && !inherited) {
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
        // The call's own model wins: a session can change route mid-way, and
        // dropping the per-message attribution billed every later call to the
        // model that happened to be current when `request/context` last fired.
        // Compaction summaries carry their own writer; assistant messages carry
        // theirs on `data.model` and, on newer logs, `message.source.model`.
        const declaredModel =
          toModelName(row.data?.model) ??
          toModelName(row.data?.message?.source?.model);
        if (declaredModel) currentModel = declaredModel;
        if (inherited) continue;
        const model = declaredModel ?? currentModel;

        const inputTokens = toNonNegativeNumber(usage.inputTokens);
        const cachedTokens = toNonNegativeNumber(usage.cacheReadTokens);
        const cacheCreationTokens = toNonNegativeNumber(usage.cacheWriteTokens);
        const reasoningTokens = toNonNegativeNumber(usage.reasoningTokens);
        // 推理量已包含在输出中，拆分后再聚合，避免重复计数。
        const outputTokens = Math.max(
          0,
          toNonNegativeNumber(usage.outputTokens) - reasoningTokens,
        );

        if (
          inputTokens +
            outputTokens +
            cachedTokens +
            cacheCreationTokens +
            reasoningTokens ===
          0
        )
          continue;

        const entryKey = [
          sessionId,
          timestamp.toISOString(),
          model,
          inputTokens,
          outputTokens,
          cachedTokens,
          cacheCreationTokens,
          reasoningTokens,
        ].join("|");
        if (seenEntryKeys.has(entryKey)) continue;
        seenEntryKeys.add(entryKey);

        entries.push({
          sessionId,
          source: TOOL_ID,
          model,
          project,
          timestamp,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          cacheCreationTokens,
        });
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: extractSessions(sessionEvents, entries),
      ...(incomplete ? { incomplete: true } : {}),
    };
  }

  /**
   * Exhaustive: every file `parse()` reads, generation selection included.
   *
   * A log that is discovered but no longer selected must not appear here either,
   * or an upgraded session would look changed while contributing nothing.
   */
  listSourceFiles(): string[] {
    return currentSessionLogs(this.sessionsDirs).map((log) => log.filePath);
  }

  isInstalled(): boolean {
    return this.sessionsDirs.some((dir) => existsSync(dir));
  }
}

registerParser(new DshParser());
