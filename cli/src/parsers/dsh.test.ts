import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DshParser } from "./dsh";

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

function writeSessionLog(
  sessionsDir: string,
  projectDir: string,
  sessionDir: string,
  lines: unknown[],
  compression: "none" | "zstd" = "none",
  trailingBytes?: Buffer,
): void {
  const dir = join(sessionsDir, projectDir, sessionDir);
  mkdirSync(dir, { recursive: true });
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  if (compression === "zstd") {
    // dsh writes one independently decodable frame per batch; emulate a
    // header frame plus an event batch frame, optionally with a torn tail.
    const frames = Buffer.concat([
      zlib.zstdCompressSync(`${JSON.stringify(lines[0])}\n`),
      zlib.zstdCompressSync(
        `${lines
          .slice(1)
          .map((line) => JSON.stringify(line))
          .join("\n")}\n`,
      ),
    ]);
    writeFileSync(
      join(dir, "session.jsonl.zstd"),
      trailingBytes ? Buffer.concat([frames, trailingBytes]) : frames,
    );
    return;
  }
  writeFileSync(join(dir, "session.jsonl"), text);
}

const header = {
  type: "session",
  version: 1,
  id: "0198dead-beef-7bed-a0be-1a2b3c4d5e6f",
  createdAt: 1_785_739_543_243,
  cwd: "/home/user/my-project",
  delegationDepth: 0,
};

function event(
  type: string,
  seq: number,
  time: number,
  data: unknown,
): unknown {
  return { type, seq, time, data };
}

const hasZstd = typeof zlib.zstdCompressSync === "function";

describe("DshParser", () => {
  it("parses usage entries and session events from a plain jsonl log", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-1", [
      header,
      event("turn/start", 0, 1_785_739_543_300, { turn: 1 }),
      event("request/context", 1, 1_785_739_543_301, {
        provider: "deepseek",
        model: "deepseek-chat",
      }),
      event("user/message", 2, 1_785_739_543_281, {
        role: "user",
        content: [],
        source: { kind: "user" },
      }),
      event("assistant/message", 3, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: {
          inputTokens: 42,
          outputTokens: 69,
          cacheReadTokens: 14720,
          cacheWriteTokens: 8,
          reasoningTokens: 12,
        },
      }),
      event("turn/end", 4, 1_785_739_545_100, {
        turn: 1,
        reason: { kind: "completed" },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    const bucket = result.buckets[0];
    expect(bucket.source).toBe("dsh");
    expect(bucket.model).toBe("deepseek-chat");
    expect(bucket.project).toBe("my-project");
    // dsh usage counts are disjoint: input excludes cached, cache = read + write
    expect(bucket.inputTokens).toBe(42);
    // reasoning is a subset of dsh's outputTokens, so it is split out here
    expect(bucket.outputTokens).toBe(57);
    expect(bucket.cachedTokens).toBe(14_728);
    expect(bucket.reasoningTokens).toBe(12);
    expect(bucket.totalTokens).toBe(14_839);

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.source).toBe("dsh");
    expect(session.primaryModel).toBe("deepseek-chat");
    expect(session.inputTokens).toBe(42);
    expect(session.outputTokens).toBe(57);
    expect(session.cachedTokens).toBe(14_728);
    expect(session.messageCount).toBe(2);
    expect(session.userMessageCount).toBe(1);
  });

  it("counts a compaction summary as its own call under the summarizing model", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-6", [
      header,
      event("request/context", 1, 1_785_739_543_301, {
        provider: "deepseek",
        model: "deepseek-chat",
      }),
      event("assistant/message", 2, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      event("compaction/summary", 3, 1_785_739_546_000, {
        compactionId: "c-1",
        summary: [],
        provider: "deepseek",
        model: "deepseek-summarizer",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 64 },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    const summaryBucket = result.buckets.find(
      (candidate) => candidate.model === "deepseek-summarizer",
    );
    expect(summaryBucket?.inputTokens).toBe(900);
    expect(summaryBucket?.outputTokens).toBe(40);
    expect(summaryBucket?.cachedTokens).toBe(64);
    // the summary is a billed call, not a conversation turn
    expect(result.sessions[0].messageCount).toBe(1);
  });

  it("ignores duplicate usage carried on streaming assistant chunks", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-7", [
      header,
      event("assistant/chunk", 1, 1_785_739_544_000, {
        turn: 1,
        step: 1,
        chunk: { usage: { inputTokens: 10, outputTokens: 5 } },
      }),
      event("assistant/message", 2, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].totalTokens).toBe(15);
  });

  it.runIf(hasZstd)(
    "parses a zstd-compressed log with a torn trailing frame",
    async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      writeSessionLog(
        sessionsDir,
        "--home-user-my-project--",
        "sess-1",
        [
          header,
          event("request/context", 1, 1_785_739_543_301, {
            provider: "deepseek",
            model: "deepseek-reasoner",
          }),
          event("assistant/message", 3, 1_785_739_545_000, {
            turn: 1,
            step: 1,
            message: {
              role: "assistant",
              content: [],
              source: { kind: "model" },
            },
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        ],
        "zstd",
        // crash-truncated final frame: valid magic, incomplete body
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]),
      );

      const parser = new DshParser(sessionsDir);
      const result = await parser.parse();

      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].model).toBe("deepseek-reasoner");
      expect(result.buckets[0].inputTokens).toBe(10);
      expect(result.buckets[0].outputTokens).toBe(5);
      expect(result.sessions).toHaveLength(1);
    },
  );

  it("takes the model from request/header when no request/context exists", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-2", [
      header,
      event("request/header", 1, 1_785_739_543_301, {
        header: {
          config: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
        reason: "initial",
      }),
      event("assistant/message", 2, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: { inputTokens: 7, outputTokens: 3 },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].model).toBe("deepseek-v4-flash");
  });

  it("ignores injected plugin context and packed chunk rows", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-3", [
      header,
      event("user/message", 1, 1_785_739_543_281, {
        role: "user",
        content: [],
        source: { kind: "plugin", plugin: "fs" },
      }),
      event("user/message", 2, 1_785_739_543_290, {
        role: "user",
        content: [],
        source: { kind: "user" },
      }),
      event("text-chunks", 3, 1_785_739_544_000, {
        seq0: 3,
        time0: 1_785_739_544_000,
        data: { deltas: ["Hel", "lo"] },
      }),
      event("assistant/message", 4, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: { inputTokens: 9, outputTokens: 2 },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messageCount).toBe(2);
    expect(result.sessions[0].userMessageCount).toBe(1);
    expect(result.buckets).toHaveLength(1);
  });

  it("falls back to the project directory name when the header has no cwd", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--E-github-fallback--", "sess-4", [
      { ...header, cwd: undefined },
      event("assistant/message", 1, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].project).toBe("fallback");
  });

  it("skips assistant messages without usage for buckets but keeps the session", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-5", [
      header,
      event("user/message", 1, 1_785_739_543_281, {
        role: "user",
        content: [],
        source: { kind: "user" },
      }),
      event("assistant/message", 2, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(0);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messageCount).toBe(2);
  });

  it("keeps a prompt-only session with no assistant reply", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-8", [
      header,
      event("user/message", 1, 1_785_739_543_281, {
        role: "user",
        content: [],
        source: { kind: "user" },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(0);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].userMessageCount).toBe(1);
    expect(result.sessions[0].primaryModel).toBe("");
  });

  it("decodes escaped characters in the fallback project name", async () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    // projectKey("/home/u/my project") escapes the space as ~0020
    writeSessionLog(sessionsDir, "--home-u-my~0020project--", "sess-9", [
      { ...header, cwd: undefined },
      event("assistant/message", 1, 1_785_739_545_000, {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [], source: { kind: "model" } },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ]);

    const parser = new DshParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets[0].project).toBe("my project");
  });

  it("reports not installed when dir is missing", () => {
    const sessionsDir = makeTempDir("tokenarena-dsh-");
    const parser = new DshParser(join(sessionsDir, "nope"));
    expect(parser.isInstalled()).toBe(false);
  });

  it("uses default sessions dir when constructed without argument", () => {
    const parser = new DshParser();
    expect(parser.tool.id).toBe("dsh");
    expect(parser.tool.name).toBe("DeepSeek Harness");
    expect(parser.tool.dataDir.endsWith(join(".dsh", "sessions"))).toBe(true);
  });
});
