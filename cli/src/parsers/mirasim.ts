import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { aggregateToBuckets } from "../domain/aggregator";
import { hasInvalidTokenCounts } from "../domain/token-usage";
import type {
  ParseResult,
  SessionMetadata,
  SessionModelUsage,
  TokenUsageEntry,
} from "../domain/types";
import {
  findJsonFiles,
  parseJsonl,
  readFileSafe,
} from "../infrastructure/fs/utils";
import { registerParser } from "./registry";
import type { IParser, ToolDefinition } from "./types";

const TOOL_ID = "mirasim";
const TOOL_NAME = "Mirasim";
const DEFAULT_INSIGHTS_DIR = join(homedir(), ".mirasim", "insights");
const USAGE_FILE_PATTERN = /^usage-\d{4}-\d{2}\.ndjson$/;

/**
 * Mirasim's own sub-agents: the only calls in the relay log that no other
 * parser can see. Every other agent (`claude`, `codex`, …) also writes that
 * tool's own local log, which its dedicated parser already ingests, so an
 * allowlist is what keeps one call from being counted twice.
 *
 * Add a name when mirasim ships a new sub-agent. An unlisted agent is simply
 * not counted — the safe direction, since the alternative silently
 * double-counts a tool that already has a parser.
 *
 * `pi-gui` is the pre-rename GUI agent. It no longer appears in new logs, but
 * its historical calls are real GUI usage with no other local source.
 */
const MIRASIM_OWN_AGENTS: readonly string[] = ["gui", "pi-gui"];

/**
 * One line of `~/.mirasim/insights/usage-YYYY-MM.ndjson`: a single upstream
 * model call as recorded by the relay. All fields are optional — failed calls
 * are logged too, with zeroed token counts.
 */
interface MirasimUsageLine {
  id?: unknown;
  ts?: unknown;
  sessionId?: unknown;
  agent?: unknown;
  model?: unknown;
  durationMs?: unknown;
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  workspace?: unknown;
}

type MirasimSessionDraft = {
  sessionId: string;
  project: string;
  firstCallAt: Date;
  lastCallEndAt: Date;
  activeMs: number;
  callCount: number;
};

export interface MirasimParserOptions {
  insightsDir?: string;
  ownAgents?: readonly string[];
}

function getInsightsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [
    env.TOKEN_ARENA_MIRASIM_DIR,
    env.MIRASIM_HOME ? join(env.MIRASIM_HOME, "insights") : undefined,
    DEFAULT_INSIGHTS_DIR,
  ].filter((value): value is string => Boolean(value));

  return Array.from(new Set(dirs));
}

function toNonNegativeInteger(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return 0;
  }

  const rounded = Math.round(numberValue);
  return Number.isSafeInteger(rounded) ? rounded : 0;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeAgent(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim().toLowerCase() || null;
}

function parseIsoDate(value: unknown): Date | null {
  const raw = getString(value);
  if (!raw) {
    return null;
  }

  const timestamp = new Date(raw);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function getPathLeaf(value: string | null): string {
  if (!value) {
    return "unknown";
  }

  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const leaf = normalized.split("/").filter(Boolean).pop();
  return leaf || "unknown";
}

function buildSessionUsage(entries: TokenUsageEntry[]) {
  const usageBySession = new Map<string, Map<string, SessionModelUsage>>();

  for (const entry of entries) {
    if (!entry.sessionId || hasInvalidTokenCounts(entry)) {
      continue;
    }

    let byModel = usageBySession.get(entry.sessionId);
    if (!byModel) {
      byModel = new Map<string, SessionModelUsage>();
      usageBySession.set(entry.sessionId, byModel);
    }

    const totalTokens =
      entry.inputTokens +
      entry.outputTokens +
      entry.reasoningTokens +
      entry.cachedTokens;
    const existing = byModel.get(entry.model);

    if (existing) {
      existing.inputTokens += entry.inputTokens;
      existing.outputTokens += entry.outputTokens;
      existing.reasoningTokens += entry.reasoningTokens;
      existing.cachedTokens += entry.cachedTokens;
      existing.totalTokens += totalTokens;
      continue;
    }

    byModel.set(entry.model, {
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      reasoningTokens: entry.reasoningTokens,
      cachedTokens: entry.cachedTokens,
      totalTokens,
    });
  }

  return usageBySession;
}

function buildSessions(
  drafts: Map<string, MirasimSessionDraft>,
  entries: TokenUsageEntry[],
): SessionMetadata[] {
  const usageBySession = buildSessionUsage(entries);
  const host = hostname().replace(/\.local$/, "");

  return Array.from(drafts.values()).map((draft) => {
    const modelUsages = Array.from(
      usageBySession.get(draft.sessionId)?.values() ?? [],
    ).sort((left, right) => {
      if (right.totalTokens !== left.totalTokens) {
        return right.totalTokens - left.totalTokens;
      }

      return left.model.localeCompare(right.model);
    });
    const inputTokens = modelUsages.reduce(
      (sum, usage) => sum + usage.inputTokens,
      0,
    );
    const outputTokens = modelUsages.reduce(
      (sum, usage) => sum + usage.outputTokens,
      0,
    );
    const reasoningTokens = modelUsages.reduce(
      (sum, usage) => sum + usage.reasoningTokens,
      0,
    );
    const cachedTokens = modelUsages.reduce(
      (sum, usage) => sum + usage.cachedTokens,
      0,
    );
    const totalTokens = modelUsages.reduce(
      (sum, usage) => sum + usage.totalTokens,
      0,
    );
    // Span the wall clock to the end of the last call, not its start, so a
    // one-call session still reports the time it actually took.
    const durationSeconds = Math.max(
      0,
      Math.round(
        (draft.lastCallEndAt.getTime() - draft.firstCallAt.getTime()) / 1000,
      ),
    );

    return {
      source: TOOL_ID,
      project: draft.project,
      sessionHash: createHash("sha256")
        .update(draft.sessionId)
        .digest("hex")
        .slice(0, 16),
      hostname: host,
      firstMessageAt: draft.firstCallAt.toISOString(),
      lastMessageAt: draft.lastCallEndAt.toISOString(),
      durationSeconds,
      // Relay calls can overlap (parallel sub-agent work), so the sum of call
      // durations may exceed the session's wall-clock span.
      activeSeconds: Math.min(
        Math.round(draft.activeMs / 1000),
        durationSeconds,
      ),
      messageCount: draft.callCount,
      // Mirasim's own sub-agents are driven by the orchestrator, not by a
      // human at a prompt, so there are no user messages to attribute.
      userMessageCount: 0,
      userPromptHours: new Array(24).fill(0),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
      totalTokens,
      primaryModel: modelUsages[0]?.model ?? "",
      modelUsages,
    } satisfies SessionMetadata;
  });
}

export class MirasimParser implements IParser {
  readonly tool: ToolDefinition;
  private readonly insightsDirs: string[];
  private readonly ownAgents: Set<string>;

  constructor(options: MirasimParserOptions = {}) {
    this.insightsDirs = options.insightsDir
      ? [options.insightsDir]
      : getInsightsDirs();
    this.ownAgents = new Set(options.ownAgents ?? MIRASIM_OWN_AGENTS);
    this.tool = {
      id: TOOL_ID,
      name: TOOL_NAME,
      dataDir: this.insightsDirs[0] ?? DEFAULT_INSIGHTS_DIR,
    };
  }

  async parse(): Promise<ParseResult> {
    const entries: TokenUsageEntry[] = [];
    const drafts = new Map<string, MirasimSessionDraft>();
    const seenCallIds = new Set<string>();

    for (const insightsDir of this.insightsDirs) {
      for (const filePath of findJsonFiles(insightsDir, USAGE_FILE_PATTERN)) {
        const content = readFileSafe(filePath);
        if (!content) continue;

        for (const row of parseJsonl<MirasimUsageLine>(content)) {
          const agent = normalizeAgent(row.agent);
          if (!agent || !this.ownAgents.has(agent)) continue;

          const timestamp = parseIsoDate(row.ts);
          if (!timestamp) continue;

          const model = getString(row.model) ?? "unknown";
          const inputTokens = toNonNegativeInteger(row.input);
          const reasoningTokens = toNonNegativeInteger(row.reasoning);
          // Reasoning is reported as a subset of output and the aggregator
          // sums all four fields, so split it out like parsers/codex.ts.
          const outputTokens = Math.max(
            0,
            toNonNegativeInteger(row.output) - reasoningTokens,
          );
          // The relay logs cache reads and writes separately; both are billed,
          // so they fold into cachedTokens like parsers/dsh.ts.
          const cachedTokens =
            toNonNegativeInteger(row.cacheRead) +
            toNonNegativeInteger(row.cacheWrite);

          // Rejected or aborted calls are logged with zeroed counts.
          if (
            inputTokens + outputTokens + reasoningTokens + cachedTokens ===
            0
          ) {
            continue;
          }

          const sessionId = getString(row.sessionId);
          const project = getPathLeaf(getString(row.workspace));
          // `id` is `sessionId:callId`. The log is append-only but can be
          // replayed across app restarts, so drop calls already seen.
          const callId =
            getString(row.id) ??
            [sessionId ?? "", timestamp.toISOString(), agent, model].join("|");
          if (seenCallIds.has(callId)) continue;
          seenCallIds.add(callId);

          entries.push({
            sessionId: sessionId ?? undefined,
            source: TOOL_ID,
            model,
            project,
            timestamp,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cachedTokens,
          });

          if (!sessionId) continue;

          const durationMs = toNonNegativeInteger(row.durationMs);
          const callEndAt = new Date(timestamp.getTime() + durationMs);
          const draft = drafts.get(sessionId);
          if (!draft) {
            drafts.set(sessionId, {
              sessionId,
              project,
              firstCallAt: timestamp,
              lastCallEndAt: callEndAt,
              activeMs: durationMs,
              callCount: 1,
            });
            continue;
          }

          if (draft.project === "unknown" && project !== "unknown") {
            draft.project = project;
          }
          if (timestamp < draft.firstCallAt) draft.firstCallAt = timestamp;
          if (callEndAt > draft.lastCallEndAt) draft.lastCallEndAt = callEndAt;
          draft.activeMs += durationMs;
          draft.callCount += 1;
        }
      }
    }

    return {
      buckets: aggregateToBuckets(entries),
      sessions: buildSessions(drafts, entries),
    };
  }

  isInstalled(): boolean {
    return this.insightsDirs.some((dir) => existsSync(dir));
  }
}

registerParser(new MirasimParser());
