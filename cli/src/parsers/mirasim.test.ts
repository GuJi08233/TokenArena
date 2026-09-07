import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MirasimParser } from "./mirasim";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-mirasim-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeUsageLog(
  insightsDir: string,
  fileName: string,
  lines: unknown[],
): void {
  writeFileSync(
    join(insightsDir, fileName),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

function usageLine(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 1,
    id: "sess-1:call-1",
    ts: "2026-09-04T15:09:33.475Z",
    sessionId: "sess-1",
    agent: "gui",
    provider: "openai-responses",
    upstreamHost: "relay.mirasim.ai",
    viaRelay: true,
    leg: "relay",
    model: "gpt-5.6-luna",
    status: 200,
    durationMs: 3010,
    input: 3049,
    output: 29,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    workspace: "E:\\ai\\test",
    ...overrides,
  };
}

describe("MirasimParser", () => {
  it("parses a gui call into a bucket and a session", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [usageLine()]);

    const { buckets, sessions } = await new MirasimParser({
      insightsDir,
    }).parse();

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      source: "mirasim",
      model: "gpt-5.6-luna",
      project: "test",
      bucketStart: "2026-09-04T15:00:00.000Z",
      inputTokens: 3049,
      outputTokens: 29,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalTokens: 3078,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      source: "mirasim",
      project: "test",
      primaryModel: "gpt-5.6-luna",
      messageCount: 1,
      userMessageCount: 0,
      totalTokens: 3078,
    });
    expect(sessions[0].userPromptHours).toHaveLength(24);
  });

  it("skips every agent outside the allowlist", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine(),
      usageLine({
        id: "sess-2:call-1",
        sessionId: "sess-2",
        agent: "claude",
        model: "claude-opus-5",
        input: 26,
        output: 3185,
        cacheRead: 323_552,
        cacheWrite: 1122,
      }),
      usageLine({
        id: "sess-3:call-1",
        sessionId: "sess-3",
        agent: "codex",
        model: "gpt-5.6-sol",
        input: 18_472,
        output: 54,
      }),
      // A sub-agent mirasim has not shipped yet: left out until listed.
      usageLine({
        id: "sess-4:call-1",
        sessionId: "sess-4",
        agent: "research",
        model: "gpt-6-astra",
      }),
    ]);

    const { buckets, sessions } = await new MirasimParser({
      insightsDir,
    }).parse();

    expect(buckets).toHaveLength(1);
    expect(buckets[0].model).toBe("gpt-5.6-luna");
    expect(sessions.map((session) => session.primaryModel)).toEqual([
      "gpt-5.6-luna",
    ]);
  });

  it("normalizes agent casing and padding before matching", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({ agent: "GUI" }),
      usageLine({
        id: "sess-2:call-1",
        sessionId: "sess-2",
        agent: " Pi-Gui ",
        model: "claude-sonnet-5-paid",
      }),
    ]);

    const { buckets } = await new MirasimParser({ insightsDir }).parse();

    expect(buckets.map((bucket) => bucket.model).sort()).toEqual([
      "claude-sonnet-5-paid",
      "gpt-5.6-luna",
    ]);
  });

  it("keeps the pre-rename pi-gui agent but not pi", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-08.ndjson", [
      usageLine({
        id: "sess-9:call-1",
        sessionId: "sess-9",
        agent: "pi-gui",
        model: "claude-sonnet-5-paid",
        ts: "2026-08-20T10:15:00.000Z",
      }),
      usageLine({
        id: "sess-10:call-1",
        sessionId: "sess-10",
        agent: "pi",
        model: "kimi-k3",
        ts: "2026-08-20T10:15:00.000Z",
      }),
    ]);

    const { buckets } = await new MirasimParser({ insightsDir }).parse();

    expect(buckets).toHaveLength(1);
    expect(buckets[0].model).toBe("claude-sonnet-5-paid");
  });

  it("honors a custom agent allowlist", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine(),
      usageLine({
        id: "sess-2:call-1",
        sessionId: "sess-2",
        agent: "research",
        model: "gpt-6-astra",
      }),
    ]);

    const { buckets } = await new MirasimParser({
      insightsDir,
      ownAgents: ["research"],
    }).parse();

    expect(buckets).toHaveLength(1);
    expect(buckets[0].model).toBe("gpt-6-astra");
  });

  it("counts a replayed call id only once", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine(),
      usageLine(),
    ]);

    const { buckets, sessions } = await new MirasimParser({
      insightsDir,
    }).parse();

    expect(buckets).toHaveLength(1);
    expect(buckets[0].totalTokens).toBe(3078);
    expect(sessions[0].messageCount).toBe(1);
  });

  it("skips calls logged with zeroed token counts", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({
        status: 503,
        durationMs: 2629,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ]);

    const { buckets, sessions } = await new MirasimParser({
      insightsDir,
    }).parse();

    expect(buckets).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("splits reasoning out of output and folds cache writes into cached", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({
        input: 100,
        output: 90,
        reasoning: 40,
        cacheRead: 1536,
        cacheWrite: 512,
      }),
    ]);

    const { buckets } = await new MirasimParser({ insightsDir }).parse();

    expect(buckets[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 40,
      cachedTokens: 2048,
      totalTokens: 2238,
    });
  });

  it("derives session timing from call durations", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({ ts: "2026-09-04T15:09:30.000Z", durationMs: 3000 }),
      usageLine({
        id: "sess-1:call-2",
        ts: "2026-09-04T15:09:40.000Z",
        durationMs: 5000,
      }),
    ]);

    const { sessions } = await new MirasimParser({ insightsDir }).parse();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      firstMessageAt: "2026-09-04T15:09:30.000Z",
      lastMessageAt: "2026-09-04T15:09:45.000Z",
      durationSeconds: 15,
      activeSeconds: 8,
      messageCount: 2,
    });
  });

  it("clamps overlapping call durations to the session span", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({ ts: "2026-09-04T15:09:30.000Z", durationMs: 60_000 }),
      usageLine({
        id: "sess-1:call-2",
        ts: "2026-09-04T15:09:31.000Z",
        durationMs: 60_000,
      }),
    ]);

    const { sessions } = await new MirasimParser({ insightsDir }).parse();

    expect(sessions[0].durationSeconds).toBe(61);
    expect(sessions[0].activeSeconds).toBe(61);
  });

  it("merges a session that spans two monthly logs", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-08.ndjson", [
      usageLine({ ts: "2026-08-31T23:59:00.000Z", durationMs: 1000 }),
    ]);
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({
        id: "sess-1:call-2",
        ts: "2026-09-01T00:00:30.000Z",
        durationMs: 1000,
      }),
    ]);

    const { buckets, sessions } = await new MirasimParser({
      insightsDir,
    }).parse();

    expect(buckets).toHaveLength(2);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      firstMessageAt: "2026-08-31T23:59:00.000Z",
      lastMessageAt: "2026-09-01T00:00:31.000Z",
      messageCount: 2,
    });
  });

  it("ignores sibling logs that are not monthly usage files", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "session-usage-2026-09.ndjson", [
      usageLine({ turns: 1 }),
    ]);
    writeUsageLog(insightsDir, "usage-2026-09.json", [usageLine()]);

    const { buckets } = await new MirasimParser({ insightsDir }).parse();

    expect(buckets).toHaveLength(0);
  });

  it("falls back to unknown when the workspace is missing", async () => {
    const insightsDir = makeTempDir();
    writeUsageLog(insightsDir, "usage-2026-09.ndjson", [
      usageLine({ workspace: undefined }),
    ]);

    const { buckets, sessions } = await new MirasimParser({
      insightsDir,
    }).parse();

    expect(buckets[0].project).toBe("unknown");
    expect(sessions[0].project).toBe("unknown");
  });

  it("skips malformed lines and rows without a usable timestamp", async () => {
    const insightsDir = makeTempDir();
    writeFileSync(
      join(insightsDir, "usage-2026-09.ndjson"),
      [
        "{not json",
        JSON.stringify(usageLine({ ts: "not-a-date" })),
        JSON.stringify(usageLine({ id: "sess-1:call-2", ts: undefined })),
        JSON.stringify(usageLine({ id: "sess-1:call-3" })),
      ].join("\n"),
    );

    const { buckets } = await new MirasimParser({ insightsDir }).parse();

    expect(buckets).toHaveLength(1);
    expect(buckets[0].totalTokens).toBe(3078);
  });

  it("reports installed only when the insights directory exists", async () => {
    const insightsDir = makeTempDir();

    expect(new MirasimParser({ insightsDir }).isInstalled()).toBe(true);
    expect(
      new MirasimParser({
        insightsDir: join(insightsDir, "missing"),
      }).isInstalled(),
    ).toBe(false);
  });
});
