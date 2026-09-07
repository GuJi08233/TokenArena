import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CherryStudioParser, getCherryStudioDbPaths } from "./cherry-studio";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeDbPath(): string {
  const dbPath = join(
    makeTempDir("tokenarena-cherry-studio-"),
    "cherrystudio.sqlite",
  );
  writeFileSync(dbPath, "", "utf-8");
  return dbPath;
}

interface UsageRow {
  modelId?: unknown;
  noCacheTokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  createdAt?: unknown;
  sessionId?: unknown;
}

interface MessageRow {
  sessionId?: unknown;
  role?: unknown;
  createdAt?: unknown;
}

function makeParser(options: {
  dbPath: string;
  usageRows: UsageRow[];
  messageRows?: MessageRow[] | (() => never);
}) {
  return new CherryStudioParser({
    dbPath: options.dbPath,
    queryRows: async <TRow>(targetDbPath: string, query: string) => {
      expect(targetDbPath).toBe(options.dbPath);

      if (query.includes("FROM ai_usage_record")) {
        return options.usageRows as TRow[];
      }

      if (query.includes("FROM message")) {
        if (typeof options.messageRows === "function") {
          options.messageRows();
        }
        return (options.messageRows ?? []) as TRow[];
      }

      return [];
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CherryStudioParser", () => {
  it("splits cached tokens back out of the recorded input count", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "omen-alpha",
          noCacheTokens: 1295,
          inputTokens: 14607,
          outputTokens: 1083,
          reasoningTokens: 0,
          cacheReadTokens: 13312,
          cacheWriteTokens: null,
          createdAt: 1788812951390,
          sessionId: "topic-1",
        },
      ],
    });

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "cherry-studio",
      model: "omen-alpha",
      project: "unknown",
      inputTokens: 1295,
      outputTokens: 1083,
      reasoningTokens: 0,
      cachedTokens: 13312,
      // Matches the row's own total_tokens of 15690 without double counting.
      totalTokens: 15690,
    });
  });

  it("splits reasoning tokens back out of the recorded output count", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "gemini-3-pro-preview",
          noCacheTokens: 400,
          inputTokens: 400,
          outputTokens: 1000,
          reasoningTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: null,
          createdAt: 1788812951390,
          sessionId: "topic-1",
        },
      ],
    });

    const result = await parser.parse();

    expect(result.buckets[0]).toMatchObject({
      inputTokens: 400,
      outputTokens: 700,
      reasoningTokens: 300,
      cachedTokens: 0,
      totalTokens: 1400,
    });
  });

  it("falls back to arithmetic when migrated rows have no cache breakdown", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "gemini-2.5-pro",
          noCacheTokens: null,
          inputTokens: 5000,
          outputTokens: 800,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: null,
          createdAt: 1770000000000,
          sessionId: "topic-legacy",
        },
      ],
    });

    const result = await parser.parse();

    expect(result.buckets[0]).toMatchObject({
      model: "gemini-2.5-pro",
      inputTokens: 5000,
      outputTokens: 800,
      cachedTokens: 0,
      totalTokens: 5800,
    });
  });

  it("counts cache writes alongside cache reads", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "claude-sonnet-4.5",
          noCacheTokens: 50,
          inputTokens: 354,
          outputTokens: 120,
          reasoningTokens: 0,
          cacheReadTokens: 100,
          cacheWriteTokens: 204,
          createdAt: 1788812951390,
          sessionId: "topic-1",
        },
      ],
    });

    const result = await parser.parse();

    expect(result.buckets[0]).toMatchObject({
      inputTokens: 50,
      outputTokens: 120,
      cachedTokens: 304,
      totalTokens: 474,
    });
  });

  it("skips rows without usable tokens or timestamps", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "gpt-5.2",
          noCacheTokens: null,
          inputTokens: null,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: null,
          createdAt: 1788812951390,
          sessionId: "topic-1",
        },
        {
          modelId: "gpt-5.2",
          noCacheTokens: 10,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: null,
          createdAt: null,
          sessionId: "topic-1",
        },
      ],
    });

    const result = await parser.parse();

    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("groups sessions by topic and still buckets rows without one", async () => {
    const dbPath = makeDbPath();
    const firstMessageAt = 1788800000000;
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "kimi-k2",
          noCacheTokens: 100,
          inputTokens: 120,
          outputTokens: 70,
          reasoningTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: null,
          createdAt: firstMessageAt,
          sessionId: "topic-1",
        },
        {
          modelId: "kimi-k2",
          noCacheTokens: 40,
          inputTokens: 40,
          outputTokens: 8,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: null,
          createdAt: firstMessageAt,
          // Agent-session rows resolve to no topic and cannot form a session.
          sessionId: null,
        },
      ],
      messageRows: [
        { sessionId: "topic-1", role: "user", createdAt: firstMessageAt },
        {
          sessionId: "topic-1",
          role: "assistant",
          createdAt: firstMessageAt + 4000,
        },
        {
          sessionId: "topic-1",
          role: "assistant",
          createdAt: firstMessageAt + 6000,
        },
        // Topic root nodes are not turns and must never reach session timing.
        {
          sessionId: "topic-1",
          role: "root",
          createdAt: firstMessageAt - 1000,
        },
      ],
    });

    const result = await parser.parse();

    // Both rows share a model and half-hour window, so they merge.
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 140,
      outputTokens: 68,
      reasoningTokens: 10,
      cachedTokens: 20,
      totalTokens: 238,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "cherry-studio",
      project: "unknown",
      durationSeconds: 6,
      activeSeconds: 2,
      messageCount: 3,
      userMessageCount: 1,
      // Only the row carrying topic-1 contributes to session usage.
      inputTokens: 100,
      outputTokens: 60,
      reasoningTokens: 10,
      cachedTokens: 20,
      totalTokens: 190,
      primaryModel: "kimi-k2",
    });
  });

  it("returns buckets when the message query fails", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: "grok-4.20-multi-agent-xhigh",
          noCacheTokens: 90,
          inputTokens: 100,
          outputTokens: 30,
          reasoningTokens: 0,
          cacheReadTokens: 10,
          cacheWriteTokens: null,
          createdAt: 1788812951390,
          sessionId: "topic-1",
        },
      ],
      messageRows: () => {
        throw new Error("message table missing");
      },
    });

    const result = await parser.parse();

    expect(result.sessions).toEqual([]);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "grok-4.20-multi-agent-xhigh",
      inputTokens: 90,
      outputTokens: 30,
      cachedTokens: 10,
      totalTokens: 130,
    });
  });

  it("falls back to unknown for rows without a model id", async () => {
    const dbPath = makeDbPath();
    const parser = makeParser({
      dbPath,
      usageRows: [
        {
          modelId: null,
          noCacheTokens: 10,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: null,
          createdAt: 1788812951390,
          sessionId: null,
        },
      ],
    });

    const result = await parser.parse();

    expect(result.buckets[0]).toMatchObject({ model: "unknown" });
  });

  it("returns nothing when the database is missing", async () => {
    const parser = new CherryStudioParser({
      dbPath: join(makeTempDir("tokenarena-cherry-studio-"), "absent.sqlite"),
      queryRows: async () => {
        throw new Error("should not query a missing database");
      },
    });

    expect(parser.isInstalled()).toBe(false);
    await expect(parser.parse()).resolves.toEqual({
      buckets: [],
      sessions: [],
    });
  });
});

describe("getCherryStudioDbPaths", () => {
  it("accepts an explicit sqlite file and keeps the platform default", () => {
    const explicit = join("C:", "custom", "cherrystudio.sqlite");
    const paths = getCherryStudioDbPaths({
      TOKEN_ARENA_CHERRY_STUDIO_DB: explicit,
    } as NodeJS.ProcessEnv);

    expect(paths[0]).toBe(explicit);
    expect(paths).toHaveLength(2);
  });

  it("resolves an explicit data directory to the sqlite file inside it", () => {
    const paths = getCherryStudioDbPaths({
      TOKEN_ARENA_CHERRY_STUDIO_DB: join("C:", "custom", "CherryStudio"),
    } as NodeJS.ProcessEnv);

    expect(paths[0]).toBe(
      join("C:", "custom", "CherryStudio", "Data", "cherrystudio.sqlite"),
    );
  });

  it("returns only the platform default without the override", () => {
    const paths = getCherryStudioDbPaths({} as NodeJS.ProcessEnv);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(join("CherryStudio", "Data"));
  });
});
