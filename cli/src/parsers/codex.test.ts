import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexParser, resolveCodexProject } from "./codex";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(result.sessions[0].modelUsages).toEqual([
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
      reasoningTokens: 12,
      cachedTokens: 25,
      totalTokens: 157,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 40,
      reasoningTokens: 12,
      cachedTokens: 25,
      totalTokens: 157,
    });
    expect(result.sessions[0].modelUsages).toEqual([
      {
        model: "gpt-5-codex",
        inputTokens: 80,
        outputTokens: 40,
        reasoningTokens: 12,
        cachedTokens: 25,
        totalTokens: 157,
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
      payload: { cwd: "/Users/dev/tokenarena" },
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

    expect(result.sessions).toHaveLength(2);
    const sessionTotals = result.sessions
      .map((session) => session.totalTokens)
      .sort((a, b) => a - b);
    expect(sessionTotals).toEqual([400, 420]);
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
