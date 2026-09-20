import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import type { IParser } from "./types";

let copilotTestDir = "";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const os = await import("node:os");
  const nodePath = await import("node:path");

  const realRootDir = nodePath.join(os.homedir(), ".copilot");

  const redirect = (p: string): string => {
    if (copilotTestDir && p.startsWith(realRootDir)) {
      return copilotTestDir + p.slice(realRootDir.length);
    }
    return p;
  };

  return {
    ...actual,
    existsSync: (p: string) => actual.existsSync(redirect(p)),
    readdirSync: (
      p: string | Buffer,
      options?:
        | BufferEncoding
        | { encoding?: BufferEncoding; withFileTypes?: boolean },
    ) => {
      const rp = typeof p === "string" ? redirect(p) : p;
      // Pick a concrete overload per branch: the union matches none of them.
      if (typeof options === "object" && options?.withFileTypes) {
        return actual.readdirSync(rp, { ...options, withFileTypes: true });
      }
      const encoding =
        typeof options === "object" ? options?.encoding : options;
      return actual.readdirSync(rp, encoding);
    },
    readFileSync: (
      p: string | Buffer | URL | number,
      options?: BufferEncoding | { encoding?: BufferEncoding; flag?: string },
    ) => {
      const rp = typeof p === "string" ? redirect(p) : p;
      return actual.readFileSync(rp, options);
    },
  };
});

import { getParser } from "./registry";
import "./copilot-cli";

const makeTempDir = useTempDirs();

function writeEventsFile(sessionDir: string, events: object[]): void {
  const content = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(sessionDir, "events.jsonl"), content, "utf-8");
}

afterEach(() => {
  copilotTestDir = "";
});

describe("CopilotCliParser", () => {
  let parser: IParser;
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("tokenarena-copilot-");
    copilotTestDir = testDir;
    parser = getParser("copilot-cli") ?? (undefined as never); // guaranteed by module import
  });

  it("returns empty when no data dir", async () => {
    copilotTestDir = "/nonexistent/path/for/test";

    const result = await parser.parse();

    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("parses session with model metrics", async () => {
    const sessionDir = join(testDir, "session-abc");
    mkdirSync(sessionDir);

    writeEventsFile(sessionDir, [
      {
        type: "session.start",
        timestamp: "2026-01-01T00:00:00Z",
        data: { context: {} },
      },
      { type: "user.message", timestamp: "2026-01-01T00:00:01Z" },
      { type: "assistant.message", timestamp: "2026-01-01T00:00:02Z" },
      {
        type: "session.shutdown",
        timestamp: "2026-01-01T00:00:03Z",
        data: {
          modelMetrics: {
            "gpt-4": {
              usage: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 20,
              },
            },
          },
        },
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    const bucket = result.buckets[0];
    expect(bucket.source).toBe("copilot-cli");
    expect(bucket.model).toBe("gpt-4");
    expect(bucket.inputTokens).toBe(70);
    expect(bucket.outputTokens).toBe(50);
    expect(bucket.cachedTokens).toBe(10);
    expect(bucket.cacheCreationTokens).toBe(20);
    expect(bucket.totalTokens).toBe(150);

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.source).toBe("copilot-cli");
    expect(session.messageCount).toBe(2);
    expect(session.userMessageCount).toBe(1);
    expect(session.primaryModel).toBe("gpt-4");
  });

  it("counts only new usage when resumed sessions emit cumulative shutdown snapshots", async () => {
    const sessionDir = join(testDir, "session-resumed");
    mkdirSync(sessionDir);
    const shutdown = (timestamp: string, usage: object) => ({
      type: "session.shutdown",
      timestamp,
      data: { modelMetrics: { "claude-sonnet": { usage } } },
    });
    const firstUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 20,
    };
    const finalUsage = {
      inputTokens: 160,
      outputTokens: 80,
      cacheReadTokens: 30,
      cacheWriteTokens: 30,
    };
    writeEventsFile(sessionDir, [
      { type: "user.message", timestamp: "2026-01-01T00:00:00Z" },
      { type: "assistant.message", timestamp: "2026-01-01T00:00:01Z" },
      shutdown("2026-01-01T00:01:00Z", firstUsage),
      { type: "session.resume", timestamp: "2026-01-01T00:30:00Z" },
      shutdown("2026-01-01T00:31:00Z", finalUsage),
      shutdown("2026-01-01T00:32:00Z", finalUsage),
      shutdown("2026-01-01T00:33:00Z", firstUsage),
      shutdown("2026-01-01T00:34:00Z", finalUsage),
    ]);

    const result = await parser.parse();
    expect(result.buckets.map((bucket) => bucket.totalTokens)).toEqual([
      150, 90,
    ]);
    expect(result.sessions[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 80,
      cachedTokens: 30,
      cacheCreationTokens: 30,
      totalTokens: 240,
    });
  });

  it("retains cache-write-only usage", async () => {
    const sessionDir = join(testDir, "session-cache-write");
    mkdirSync(sessionDir);
    writeEventsFile(sessionDir, [
      {
        type: "session.shutdown",
        timestamp: "2026-01-01T00:00:03Z",
        data: {
          modelMetrics: {
            "claude-sonnet": {
              usage: { inputTokens: 20, cacheWriteTokens: 20 },
            },
          },
        },
      },
    ]);

    expect((await parser.parse()).buckets[0]).toMatchObject({
      inputTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 20,
      totalTokens: 20,
    });
  });

  it("ignores zero-usage entries", async () => {
    const sessionDir = join(testDir, "session-xyz");
    mkdirSync(sessionDir);

    writeEventsFile(sessionDir, [
      { type: "session.start", timestamp: "2026-01-01T00:00:00Z" },
      {
        type: "session.shutdown",
        timestamp: "2026-01-01T00:00:01Z",
        data: {
          modelMetrics: {
            "gpt-4": {
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
            },
          },
        },
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("extracts project from gitRoot context", async () => {
    const sessionDir = join(testDir, "session-proj");
    mkdirSync(sessionDir);

    writeEventsFile(sessionDir, [
      {
        type: "session.start",
        timestamp: "2026-01-01T00:00:00Z",
        data: { context: { gitRoot: "/home/user/my-project" } },
      },
      { type: "user.message", timestamp: "2026-01-01T00:00:01Z" },
      { type: "assistant.message", timestamp: "2026-01-01T00:00:02Z" },
      {
        type: "session.shutdown",
        timestamp: "2026-01-01T00:00:03Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              usage: {
                inputTokens: 200,
                outputTokens: 100,
                cacheReadTokens: 0,
              },
            },
          },
        },
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].project).toBe("my-project");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].project).toBe("my-project");
  });

  it("handles malformed lines", async () => {
    const sessionDir = join(testDir, "session-malformed");
    mkdirSync(sessionDir);

    const lines = [
      "{not valid json",
      JSON.stringify({
        type: "session.start",
        timestamp: "2026-01-01T00:00:00Z",
      }),
      "",
      "  ",
      JSON.stringify({
        type: "user.message",
        timestamp: "2026-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "assistant.message",
        timestamp: "2026-01-01T00:00:02Z",
      }),
      "{another bad line",
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-01-01T00:00:03Z",
        data: {
          modelMetrics: {
            "claude-sonnet-4.5": {
              usage: {
                inputTokens: 500,
                outputTokens: 250,
                cacheReadTokens: 50,
              },
            },
          },
        },
      }),
    ];
    writeFileSync(join(sessionDir, "events.jsonl"), lines.join("\n"), "utf-8");

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].model).toBe("claude-sonnet-4.5");
    expect(result.buckets[0].inputTokens).toBe(450);
    expect(result.buckets[0].outputTokens).toBe(250);
    expect(result.buckets[0].cachedTokens).toBe(50);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messageCount).toBe(2);
  });
});
