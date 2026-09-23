import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { logger } from "../utils/logger";
import { CodexParser, resolveCodexProject } from "./codex";

const makeTempDir = useTempDirs();

describe("resolveCodexProject", () => {
  it("extracts the folder name from a Windows cwd", () => {
    expect(
      resolveCodexProject({
        cwd: "D:\\Project\\tokens-burned",
      }),
    ).toBe("tokens-burned");
  });

  it("prefers the repository slug when available", () => {
    expect(
      resolveCodexProject({
        cwd: "D:\\Project\\tokens-burned",
        git: {
          repository_url: "https://github.com/poco-ai/tokens-burned.git",
        },
      }),
    ).toBe("poco-ai/tokens-burned");
  });
});

describe("CodexParser", () => {
  it("splits cached input and reasoning output into non-overlapping fields", async () => {
    const sessionsDir = makeTempDir("tokenarena-codex-");
    const sessionDir = join(sessionsDir, "2026", "04", "20");
    mkdirSync(sessionDir, { recursive: true });

    const sessionPath = join(sessionDir, "rollout-1.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            cwd: "/Users/dev/tokenarena",
            git: {
              repository_url: "https://github.com/poco-ai/tokenarena.git",
            },
          },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-04-20T10:00:00.000Z",
          payload: { model: "gpt-5-codex" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-20T10:00:05.000Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: {
                input_tokens: 100,
                output_tokens: 80,
                cached_input_tokens: 20,
                reasoning_output_tokens: 30,
              },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new CodexParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "codex",
      model: "gpt-5-codex",
      project: "poco-ai/tokenarena",
      inputTokens: 80,
      outputTokens: 50,
      reasoningTokens: 30,
      cachedTokens: 20,
      totalTokens: 180,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "codex",
      project: "poco-ai/tokenarena",
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 80,
      outputTokens: 50,
      reasoningTokens: 30,
      cachedTokens: 20,
      totalTokens: 180,
      primaryModel: "gpt-5-codex",
    });
    expect(result.sessions[0].modelUsages).toMatchObject([
      {
        model: "gpt-5-codex",
        inputTokens: 80,
        outputTokens: 50,
        reasoningTokens: 30,
        cachedTokens: 20,
        totalTokens: 180,
      },
    ]);
  });

  it("clamps cumulative deltas to zero when counters reset or shrink", async () => {
    const sessionsDir = makeTempDir("tokenarena-codex-");
    const sessionDir = join(sessionsDir, "2026", "04", "20");
    mkdirSync(sessionDir, { recursive: true });

    const sessionPath = join(sessionDir, "rollout-2.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            cwd: "/Users/dev/tokenarena",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-04-20T11:00:00.000Z",
          payload: { model: "gpt-5-codex" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-20T11:00:05.000Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              total_token_usage: {
                input_tokens: 100,
                output_tokens: 50,
                cached_input_tokens: 20,
                reasoning_output_tokens: 10,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-04-20T11:00:06.000Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              total_token_usage: {
                input_tokens: 90,
                output_tokens: 40,
                cached_input_tokens: 25,
                reasoning_output_tokens: 12,
              },
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new CodexParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 40,
      reasoningTokens: 10,
      cachedTokens: 20,
      totalTokens: 150,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 40,
      reasoningTokens: 10,
      cachedTokens: 20,
      totalTokens: 150,
    });
    expect(result.sessions[0].modelUsages).toMatchObject([
      {
        model: "gpt-5-codex",
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 10,
        cachedTokens: 20,
        totalTokens: 150,
      },
    ]);
  });

  it("counts a repeated cumulative state only once (double-writes and heartbeats)", async () => {
    const sessionsDir = makeTempDir("tokenarena-codex-");
    const sessionDir = join(sessionsDir, "2026", "04", "20");
    mkdirSync(sessionDir, { recursive: true });

    const usage = {
      input_tokens: 100,
      output_tokens: 80,
      cached_input_tokens: 20,
      reasoning_output_tokens: 30,
    };
    const tokenCount = (timestamp: string) =>
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5-codex",
            total_token_usage: usage,
            last_token_usage: usage,
          },
        },
      });

    writeFileSync(
      join(sessionDir, "rollout-1.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/Users/dev/tokenarena" },
        }),
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-04-20T10:00:00.000Z",
          payload: { model: "gpt-5-codex" },
        }),
        // Original event, a double-write 1ms later and a heartbeat re-emit
        // 44s later all carry the identical cumulative state.
        tokenCount("2026-04-20T10:00:05.000Z"),
        tokenCount("2026-04-20T10:00:05.001Z"),
        tokenCount("2026-04-20T10:00:49.000Z"),
      ].join("\n"),
      "utf-8",
    );

    const parser = new CodexParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 50,
      reasoningTokens: 30,
      cachedTokens: 20,
      totalTokens: 180,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      messageCount: 2,
      userMessageCount: 1,
      totalTokens: 180,
    });
  });

  it("does not double count history replayed into a resumed rollout file", async () => {
    const sessionsDir = makeTempDir("tokenarena-codex-");
    const sessionDir = join(sessionsDir, "2026", "04", "20");
    mkdirSync(sessionDir, { recursive: true });

    const meta = JSON.stringify({
      type: "session_meta",
      payload: { id: "resumed-thread", cwd: "/Users/dev/tokenarena" },
    });
    const turnContext = (timestamp: string) =>
      JSON.stringify({
        type: "turn_context",
        timestamp,
        payload: { model: "gpt-5-codex" },
      });
    const tokenCount = (
      timestamp: string,
      total: Record<string, number>,
      last: Record<string, number>,
    ) =>
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5-codex",
            total_token_usage: total,
            last_token_usage: last,
          },
        },
      });

    const turn1Total = {
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 20,
      reasoning_output_tokens: 10,
    };
    const turn2Total = {
      input_tokens: 300,
      output_tokens: 120,
      cached_input_tokens: 80,
      reasoning_output_tokens: 30,
    };
    const turn2Last = {
      input_tokens: 200,
      output_tokens: 70,
      cached_input_tokens: 60,
      reasoning_output_tokens: 20,
    };

    writeFileSync(
      join(sessionDir, "rollout-1.jsonl"),
      [
        meta,
        turnContext("2026-04-20T10:00:00.000Z"),
        tokenCount("2026-04-20T10:00:05.000Z", turn1Total, turn1Total),
        tokenCount("2026-04-20T10:05:00.000Z", turn2Total, turn2Last),
      ].join("\n"),
      "utf-8",
    );

    // Resuming replays the full history with fresh timestamps before the
    // genuinely new turn is appended.
    writeFileSync(
      join(sessionDir, "rollout-2.jsonl"),
      [
        meta,
        turnContext("2026-04-20T12:00:00.000Z"),
        tokenCount("2026-04-20T12:00:00.100Z", turn1Total, turn1Total),
        tokenCount("2026-04-20T12:00:00.101Z", turn2Total, turn2Last),
        tokenCount(
          "2026-04-20T12:10:00.000Z",
          {
            input_tokens: 600,
            output_tokens: 220,
            cached_input_tokens: 180,
            reasoning_output_tokens: 60,
          },
          {
            input_tokens: 300,
            output_tokens: 100,
            cached_input_tokens: 100,
            reasoning_output_tokens: 30,
          },
        ),
      ].join("\n"),
      "utf-8",
    );

    const parser = new CodexParser(sessionsDir);
    const result = await parser.parse();

    // turn1: 150, turn2: 270, resumed turn3: 400. The replayed copies of
    // turn1/turn2 in rollout-2 must not be counted again.
    const bucketTotal = result.buckets.reduce(
      (sum, bucket) => sum + bucket.totalTokens,
      0,
    );
    expect(bucketTotal).toBe(820);

    expect(result.sessions).toHaveLength(1);
    const sessionTotals = result.sessions
      .map((session) => session.totalTokens)
      .sort((a, b) => a - b);
    expect(sessionTotals).toEqual([820]);
  });

  it("deduplicates double-written events that only carry last_token_usage", async () => {
    const sessionsDir = makeTempDir("tokenarena-codex-");
    const sessionDir = join(sessionsDir, "2026", "04", "20");
    mkdirSync(sessionDir, { recursive: true });

    const line = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-04-20T10:00:05.000Z",
      payload: {
        type: "token_count",
        info: {
          model: "gpt-5-codex",
          last_token_usage: {
            input_tokens: 100,
            output_tokens: 80,
            cached_input_tokens: 20,
            reasoning_output_tokens: 30,
          },
        },
      },
    });

    writeFileSync(
      join(sessionDir, "rollout-1.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/Users/dev/tokenarena" },
        }),
        line,
        line,
      ].join("\n"),
      "utf-8",
    );

    const parser = new CodexParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 50,
      reasoningTokens: 30,
      cachedTokens: 20,
      totalTokens: 180,
    });
  });
});

type UsageFixture = Record<string, number>;
const counters = (input: number): UsageFixture => ({
  input_tokens: input,
  output_tokens: 0,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
});
const metadata = (id?: string, extra: Record<string, unknown> = {}) => ({
  type: "session_meta",
  timestamp: "2026-07-10T03:00:00Z",
  payload: { id, cwd: "/workspace/project", ...extra },
});
const tokenEvent = (
  second: number,
  total?: UsageFixture,
  last?: UsageFixture,
  options: { model?: string; source?: string } = {},
) => ({
  type: "event_msg",
  timestamp: `2026-07-10T03:00:${String(second).padStart(2, "0")}Z`,
  payload: {
    type: "token_count",
    rate_limits: { limit_id: options.source },
    info: {
      model: options.model ?? "gpt-5-codex",
      total_token_usage: total,
      last_token_usage: last,
    },
  },
});
function writeFixture(
  directory: string,
  name: string,
  events: unknown[],
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf-8",
  );
}
function bucketTotal(
  result: Awaited<ReturnType<CodexParser["parse"]>>,
): number {
  return result.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
}

describe("Codex usage and replay regressions", () => {
  it.each([
    true,
    false,
  ])("keeps independent files with equal counters (metadata IDs: %s)", async (withIds) => {
    const directory = makeTempDir("tokenarena-codex-independent-");
    writeFixture(directory, "a", [
      metadata(withIds ? "thread-a" : undefined, { cwd: "/workspace/a" }),
      tokenEvent(1, counters(100), counters(100)),
    ]);
    writeFixture(directory, "b", [
      metadata(withIds ? "thread-b" : undefined, { cwd: "/workspace/b" }),
      tokenEvent(2, counters(100), counters(100)),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(200);
    expect(result.sessions.map((session) => session.totalTokens)).toEqual([
      100, 100,
    ]);
    expect(result.buckets.map((bucket) => bucket.project).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("advances the total baseline when exact last usage is present", async () => {
    const directory = makeTempDir("tokenarena-codex-baseline-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), counters(100)),
      tokenEvent(2, counters(150)),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(150);
  });

  it("shares cumulative counters across model switches", async () => {
    const directory = makeTempDir("tokenarena-codex-model-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), undefined, { model: "model-a" }),
      tokenEvent(2, counters(150), undefined, { model: "model-b" }),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(150);
    expect(
      result.buckets.map(({ model, totalTokens }) => ({ model, totalTokens })),
    ).toEqual([
      { model: "model-a", totalTokens: 100 },
      { model: "model-b", totalTokens: 50 },
    ]);
  });

  it("keeps the cumulative high-water mark across older snapshots", async () => {
    const directory = makeTempDir("tokenarena-codex-watermark-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100)),
      tokenEvent(2, counters(80)),
      tokenEvent(3, counters(120)),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(120);
  });

  it("falls back to total when last usage is an empty object", async () => {
    const directory = makeTempDir("tokenarena-codex-empty-last-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), {}),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(100);
  });

  it("does not use an empty total object to deduplicate distinct requests", async () => {
    const directory = makeTempDir("tokenarena-codex-empty-total-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, {}, counters(100)),
      tokenEvent(2, {}, counters(100)),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(200);
  });

  it("honors explicit zero last usage while advancing the total baseline", async () => {
    const directory = makeTempDir("tokenarena-codex-zero-last-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), counters(0)),
      tokenEvent(2, counters(150)),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(50);
  });

  it("counts a genuine reset that returns to a previously seen total", async () => {
    const directory = makeTempDir("tokenarena-codex-reset-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), counters(100)),
      tokenEvent(2, counters(100), counters(100)),
      tokenEvent(3, counters(200), counters(100)),
      tokenEvent(4, counters(100), counters(50)),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(250);
  });

  it("deduplicates the latest snapshot per limit source without losing exact usage", async () => {
    const directory = makeTempDir("tokenarena-codex-lanes-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), counters(10), { source: "a" }),
      tokenEvent(2, counters(300), counters(20), { source: "b" }),
      tokenEvent(3, counters(150), counters(30), { source: "a" }),
      tokenEvent(4, counters(300), counters(20), { source: "b" }),
      tokenEvent(5, counters(350), undefined, { source: "a" }),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(110);
  });

  it("deduplicates adjacent cross-source notifications but permits later resets", async () => {
    const directory = makeTempDir("tokenarena-codex-notifications-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, counters(100), counters(10), { source: "a" }),
      tokenEvent(2, counters(100), counters(10), { source: "b" }),
      tokenEvent(3, counters(200), counters(10), { source: "a" }),
      tokenEvent(4, counters(100), counters(10), { source: "a" }),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(30);
  });

  it("carries the baseline into a continuation file without replayed history", async () => {
    const directory = makeTempDir("tokenarena-codex-continuation-");
    writeFixture(directory, "a", [
      metadata("thread-a"),
      tokenEvent(1, counters(100)),
    ]);
    writeFixture(directory, "b", [
      metadata("thread-a"),
      tokenEvent(2, counters(150)),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(150);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].totalTokens).toBe(150);
  });

  it("includes archived sessions and does not count an archived copy twice", async () => {
    const directory = makeTempDir("tokenarena-codex-archive-");
    const sessions = join(directory, "sessions");
    const archived = join(directory, "archived_sessions");
    const original = [metadata("thread-a"), tokenEvent(1, counters(100))];
    writeFixture(sessions, "original", original);
    writeFixture(archived, "copied", original);
    writeFixture(archived, "archive-only", [
      metadata("thread-b"),
      tokenEvent(2, counters(50)),
    ]);
    const result = await new CodexParser(sessions, archived).parse();
    expect(bucketTotal(result)).toBe(150);
    expect(result.sessions).toHaveLength(2);
    expect(bucketTotal(await new CodexParser(sessions).parse())).toBe(100);
    expect(
      new CodexParser(join(directory, "missing"), archived).isInstalled(),
    ).toBe(true);
  });

  it.each([
    { second: 1, expected: 15 },
    { second: 2, expected: 30 },
  ])("distinguishes last-only continuation calls by their original timestamp ($second)", async ({
    second,
    expected,
  }) => {
    const directory = makeTempDir("tokenarena-codex-last-only-continuation-");
    const usage = { ...counters(10), output_tokens: 5 };
    writeFixture(directory, "a", [
      metadata("thread-a"),
      tokenEvent(1, undefined, usage),
    ]);
    writeFixture(directory, "b", [
      metadata("thread-a"),
      tokenEvent(second, undefined, usage),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(expected);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].totalTokens).toBe(expected);
  });

  it.each([
    "fork",
    "subagent",
  ])("removes only the inherited prefix for a %s", async (kind) => {
    const directory = makeTempDir("tokenarena-codex-fork-");
    // 子文件按路径排在父文件之前，验证解析不依赖目录枚举顺序。
    writeFixture(directory, "z-parent", [
      metadata("parent"),
      tokenEvent(1, counters(100)),
      tokenEvent(2, counters(200)),
      tokenEvent(3, counters(300)),
      {
        type: "turn_context",
        timestamp: "2026-07-10T03:00:10Z",
        payload: { model: "gpt-5-codex" },
      },
    ]);
    const parentField =
      kind === "fork"
        ? { forked_from_id: "parent" }
        : {
            source: {
              subagent: { thread_spawn: { parent_thread_id: "parent" } },
            },
          };
    writeFixture(directory, "a-child", [
      { ...metadata("child", parentField), timestamp: "2026-07-10T03:00:05Z" },
      tokenEvent(6, counters(100)),
      tokenEvent(7, counters(300)),
      tokenEvent(8, counters(450)),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(450);
    expect(
      result.sessions
        .map((session) => session.totalTokens)
        .sort((a, b) => a - b),
    ).toEqual([150, 300]);
  });

  it("verifies a fork cutoff from ordinals across parent rollout files", async () => {
    const directory = makeTempDir("tokenarena-codex-fork-ordinals-");
    writeFixture(directory, "parent-1", [
      { ...metadata("parent"), ordinal: 0 },
      { ...tokenEvent(1, counters(100)), ordinal: 4 },
    ]);
    writeFixture(directory, "parent-2", [
      { ...metadata("parent"), ordinal: 5 },
      { ...tokenEvent(2, counters(200)), ordinal: 10 },
    ]);
    writeFixture(directory, "child", [
      {
        ...metadata("child", {
          forked_from_id: "parent",
          forked_from_ordinal_exclusive: 11,
        }),
        timestamp: "2026-07-10T03:00:05Z",
        ordinal: 0,
      },
      tokenEvent(6, counters(100)),
      tokenEvent(7, counters(200)),
      tokenEvent(8, counters(300)),
    ]);

    const result = await new CodexParser(directory).parse();
    expect(result.incomplete).not.toBe(true);
    expect(bucketTotal(result)).toBe(300);
    expect(
      result.sessions.map((session) => session.totalTokens).sort(),
    ).toEqual([100, 200]);
  });

  it("does not remove a live child event that matches a future parent snapshot", async () => {
    const directory = makeTempDir("tokenarena-codex-fork-cutoff-");
    writeFixture(directory, "parent", [
      metadata("parent"),
      tokenEvent(1, counters(100)),
      tokenEvent(6, counters(200)),
    ]);
    writeFixture(directory, "child", [
      {
        ...metadata("child", { forked_from_id: "parent" }),
        timestamp: "2026-07-10T03:00:05Z",
      },
      tokenEvent(7, counters(200)),
    ]);
    expect(bucketTotal(await new CodexParser(directory).parse())).toBe(400);
  });

  it("preserves nanosecond fork cutoffs and distinct last-only timestamps", async () => {
    const directory = makeTempDir("tokenarena-codex-nanos-");
    writeFixture(directory, "parent", [
      metadata("parent"),
      {
        ...tokenEvent(1, counters(100)),
        timestamp: "2026-07-10T03:00:01.000000001Z",
      },
      {
        ...tokenEvent(1, counters(200)),
        timestamp: "2026-07-10T03:00:01.000000003Z",
      },
    ]);
    writeFixture(directory, "child", [
      {
        ...metadata("child", { forked_from_id: "parent" }),
        timestamp: "2026-07-10T03:00:01.000000002Z",
      },
      tokenEvent(2, counters(200)),
    ]);
    writeFixture(directory, "last-only", [
      metadata("last-only"),
      {
        ...tokenEvent(3, undefined, counters(10)),
        timestamp: "2026-07-10T03:00:03.000000001Z",
      },
      {
        ...tokenEvent(3, undefined, counters(10)),
        timestamp: "2026-07-10T03:00:03.000000002Z",
      },
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(420);
    expect(
      result.sessions.map((session) => session.messageCount).sort(),
    ).toEqual([1, 2, 2]);
  });

  it("ignores malformed metadata and invalid timestamps", async () => {
    const directory = makeTempDir("tokenarena-codex-malformed-");
    writeFixture(directory, "session", [
      null,
      {
        type: "session_meta",
        payload: { cwd: 123, git: { repository_url: false } },
      },
      tokenEvent(1, counters(100)),
      { ...tokenEvent(2, counters(200)), timestamp: "invalid" },
    ]);
    const result = await new CodexParser(directory).parse();
    expect(bucketTotal(result)).toBe(100);
    expect(result.buckets[0].project).toBe("unknown");
  });

  it("retries a fork on the next parse when its missing parent becomes available", async () => {
    const directory = makeTempDir("tokenarena-codex-pending-");
    writeFixture(directory, "child", [
      {
        ...metadata("child", { forked_from_id: "parent" }),
        timestamp: "2026-07-10T03:00:05Z",
      },
      tokenEvent(6, counters(100)),
      tokenEvent(7, counters(150)),
    ]);
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const parser = new CodexParser(directory);
      const incomplete = await parser.parse();
      expect(bucketTotal(incomplete)).toBe(0);
      expect(incomplete.incomplete).toBe(true);
      expect(warning).toHaveBeenCalledOnce();
      writeFixture(directory, "parent", [
        metadata("parent"),
        tokenEvent(1, counters(100)),
        { type: "turn_context", timestamp: "2026-07-10T03:00:10Z" },
      ]);
      const complete = await parser.parse();
      expect(bucketTotal(complete)).toBe(150);
      expect(complete.incomplete).not.toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  it("defers conflicting parent identities and cycles without importing partial usage", async () => {
    const directory = makeTempDir("tokenarena-codex-parent-conflict-");
    writeFixture(directory, "a", [
      metadata("a", { forked_from_id: "b" }),
      tokenEvent(1, counters(100)),
    ]);
    writeFixture(directory, "b", [
      metadata("b", { forked_from_id: "a" }),
      tokenEvent(2, counters(200)),
    ]);
    writeFixture(directory, "conflict", [
      metadata("conflict", {
        forked_from_id: "a",
        source: { subagent: { thread_spawn: { parent_thread_id: "b" } } },
      }),
      tokenEvent(3, counters(300)),
    ]);
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(bucketTotal(await new CodexParser(directory).parse())).toBe(0);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("clamps cache and reasoning subsets to the corresponding input and output", async () => {
    const directory = makeTempDir("tokenarena-codex-subsets-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, undefined, {
        input_tokens: 100,
        output_tokens: 40,
        cached_input_tokens: 200,
        reasoning_output_tokens: 80,
      }),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 100,
      reasoningTokens: 40,
      totalTokens: 140,
    });
  });

  it("accepts the cache-read field alias", async () => {
    const directory = makeTempDir("tokenarena-codex-cache-alias-");
    writeFixture(directory, "session", [
      metadata("thread-a"),
      tokenEvent(1, undefined, {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
      }),
    ]);
    const result = await new CodexParser(directory).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 20,
      outputTokens: 20,
      cachedTokens: 80,
      totalTokens: 120,
    });
  });
});
