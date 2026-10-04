import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { DshParser, getSessionLogGeneration } from "./dsh";

const makeTempDir = useTempDirs();

function writeSessionLog(
  sessionsDir: string,
  projectDir: string,
  sessionDir: string,
  lines: unknown[],
  compression: "none" | "zstd" = "none",
  trailingBytes?: Buffer,
  fileName?: string,
): void {
  const dir = join(sessionsDir, projectDir, sessionDir);
  mkdirSync(dir, { recursive: true });
  const name =
    fileName ??
    (compression === "zstd" ? "session.jsonl.zstd" : "session.jsonl");
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
      join(dir, name),
      trailingBytes ? Buffer.concat([frames, trailingBytes]) : frames,
    );
    return;
  }
  writeFileSync(join(dir, name), text);
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
    // 输入、缓存读取、缓存写入分别计数，拆分后总量保持一致。
    expect(bucket.inputTokens).toBe(42);
    // reasoning is a subset of dsh's outputTokens, so it is split out here
    expect(bucket.outputTokens).toBe(57);
    expect(bucket.cachedTokens).toBe(14_720);
    expect(bucket.cacheCreationTokens).toBe(8);
    expect(bucket.reasoningTokens).toBe(12);
    expect(bucket.totalTokens).toBe(14_839);

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.source).toBe("dsh");
    expect(session.primaryModel).toBe("deepseek-chat");
    expect(session.inputTokens).toBe(42);
    expect(session.outputTokens).toBe(57);
    expect(session.cachedTokens).toBe(14_720);
    expect(session.cacheCreationTokens).toBe(8);
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

  describe("storage generations", () => {
    /**
     * dsh appends `vN` from v1 onward and documents that later versions use the
     * same scheme. Matching only the v0 names found nothing on any released
     * generation, so the source silently contributed zero.
     */
    it("recognises the v0 name and every later generation", () => {
      expect(getSessionLogGeneration("session.jsonl")).toBe(0);
      expect(getSessionLogGeneration("session.jsonl.zstd")).toBe(0);
      expect(getSessionLogGeneration("session.v1.jsonl")).toBe(1);
      expect(getSessionLogGeneration("session.v1.jsonl.zstd")).toBe(1);
      expect(getSessionLogGeneration("session.v3.jsonl.zstd")).toBe(3);
      expect(getSessionLogGeneration("session.v4.jsonl.zstd")).toBe(4);
      // a generation that does not exist yet must still be read
      expect(getSessionLogGeneration("session.v12.jsonl.zstd")).toBe(12);
    });

    it("ignores files that are not session logs", () => {
      for (const name of [
        "session.txt",
        "session.jsonl.gz",
        "sessions.v1.jsonl",
        "other.v1.jsonl.zstd",
        "session.v.jsonl",
      ]) {
        expect(getSessionLogGeneration(name)).toBeNull();
      }
    });

    it.each([
      "session.jsonl",
      "session.jsonl.zstd",
      "session.v3.jsonl",
      "session.v3.jsonl.zstd",
      "session.v4.jsonl.zstd",
    ])("parses a %s log", async (fileName) => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      const compression = fileName.endsWith(".zstd") ? "zstd" : "none";
      writeSessionLog(
        sessionsDir,
        "--home-user-my-project--",
        "sess-gen",
        [
          header,
          event("request/context", 1, 1_785_739_543_301, {
            provider: "deepseek",
            model: "deepseek-chat",
          }),
          event("assistant/message", 2, 1_785_739_545_000, {
            turn: 1,
            step: 1,
            message: {
              role: "assistant",
              content: [],
              source: { kind: "model", model: "deepseek-chat" },
            },
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
        ],
        compression,
        undefined,
        fileName,
      );

      const result = await new DshParser(sessionsDir).parse();

      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].inputTokens).toBe(10);
      expect(result.buckets[0].totalTokens).toBe(15);
      expect(result.sessions).toHaveLength(1);
    });

    it("reads only the newest generation when an upgraded session left both", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      const projectDir = "--home-user-my-project--";
      const sessionDir = "sess-upgrade";
      // v3 is the superseded generation; v4 supersedes it and must win.
      writeSessionLog(
        sessionsDir,
        projectDir,
        sessionDir,
        [
          header,
          event("assistant/message", 1, 1_785_739_545_000, {
            turn: 1,
            step: 1,
            message: { role: "assistant", content: [] },
            usage: { inputTokens: 100, outputTokens: 100 },
          }),
        ],
        "none",
        undefined,
        "session.v3.jsonl",
      );
      writeSessionLog(
        sessionsDir,
        projectDir,
        sessionDir,
        [
          header,
          event("assistant/message", 1, 1_785_739_545_000, {
            turn: 1,
            step: 1,
            message: { role: "assistant", content: [] },
            usage: { inputTokens: 1, outputTokens: 2 },
          }),
        ],
        "none",
        undefined,
        "session.v4.jsonl",
      );

      const parser = new DshParser(sessionsDir);
      const result = await parser.parse();

      // Only the v4 log is billed; the v3 one must not double count it.
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].inputTokens).toBe(1);
      expect(result.buckets[0].totalTokens).toBe(3);
      expect(parser.listSourceFiles()).toHaveLength(1);
      expect(parser.listSourceFiles()[0].endsWith("session.v4.jsonl")).toBe(
        true,
      );
    });

    it("prefers the compressed root when both encodings of one generation exist", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      const projectDir = "--home-user-my-project--";
      const sessionDir = "sess-both";
      const lines = [
        header,
        event("assistant/message", 1, 1_785_739_545_000, {
          turn: 1,
          step: 1,
          message: { role: "assistant", content: [] },
          usage: { inputTokens: 7, outputTokens: 3 },
        }),
      ];
      writeSessionLog(
        sessionsDir,
        projectDir,
        sessionDir,
        lines,
        "none",
        undefined,
        "session.v3.jsonl",
      );
      writeSessionLog(
        sessionsDir,
        projectDir,
        sessionDir,
        lines,
        "zstd",
        undefined,
        "session.v3.jsonl.zstd",
      );

      const parser = new DshParser(sessionsDir);
      const result = await parser.parse();

      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].totalTokens).toBe(10);
      expect(parser.listSourceFiles()).toHaveLength(1);
    });
  });

  describe("listSourceFiles", () => {
    /** The parse cache replays a result only when this list is exhaustive. */
    it("lists every log parse() reads, and only those", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      writeSessionLog(
        sessionsDir,
        "--home-user-a--",
        "s1",
        [
          header,
          event("user/message", 1, 1_785_739_543_281, {
            source: { kind: "user" },
          }),
        ],
        "none",
        undefined,
        "session.jsonl",
      );
      writeSessionLog(
        sessionsDir,
        "--home-user-b--",
        "s2",
        [
          header,
          event("user/message", 1, 1_785_739_543_281, {
            source: { kind: "user" },
          }),
        ],
        "zstd",
        undefined,
        "session.v3.jsonl.zstd",
      );

      const parser = new DshParser(sessionsDir);
      const files = parser.listSourceFiles();

      expect(files).toHaveLength(2);
      expect(files.some((file) => file.endsWith("session.jsonl"))).toBe(true);
      expect(files.some((file) => file.endsWith("session.v3.jsonl.zstd"))).toBe(
        true,
      );
      await parser.parse();
    });

    it("returns nothing for a missing directory", () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      const parser = new DshParser(join(sessionsDir, "nope"));
      expect(parser.listSourceFiles()).toEqual([]);
    });

    /**
     * A log that is discovered but not selected must not be listed either:
     * otherwise an upgraded session looks changed while contributing nothing.
     */
    it("omits a superseded generation it will not read", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      writeSessionLog(
        sessionsDir,
        "--home-user-a--",
        "s1",
        [header, event("user/message", 1, 1, { source: { kind: "user" } })],
        "none",
        undefined,
        "session.v2.jsonl",
      );
      writeSessionLog(
        sessionsDir,
        "--home-user-a--",
        "s1",
        [header, event("user/message", 1, 1, { source: { kind: "user" } })],
        "none",
        undefined,
        "session.v3.jsonl",
      );

      const parser = new DshParser(sessionsDir);
      const files = parser.listSourceFiles();

      expect(files).toHaveLength(1);
      expect(files[0].endsWith("session.v3.jsonl")).toBe(true);
    });
  });

  describe("model attribution", () => {
    /**
     * Newer logs stamp the model that actually served each call. Reading only
     * `request/context` billed every call after a mid-session switch to the old
     * model.
     */
    it("bills each call to its own model when the session switches route", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      writeSessionLog(sessionsDir, "--home-user-my-project--", "sess-switch", [
        header,
        event("request/context", 1, 1_785_739_543_301, {
          provider: "deepseek",
          model: "deepseek-chat",
        }),
        event("assistant/message", 2, 1_785_739_545_000, {
          turn: 1,
          step: 1,
          message: {
            role: "assistant",
            content: [],
            source: { kind: "model", model: "deepseek-chat" },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
        event("assistant/message", 3, 1_785_739_546_000, {
          turn: 1,
          step: 2,
          message: {
            role: "assistant",
            content: [],
            source: { kind: "model", model: "deepseek-reasoner" },
          },
          usage: { inputTokens: 20, outputTokens: 9, reasoningTokens: 4 },
        }),
      ]);

      const result = await new DshParser(sessionsDir).parse();

      const byModel = new Map(
        result.buckets.map((bucket) => [bucket.model, bucket]),
      );
      expect(byModel.get("deepseek-chat")?.inputTokens).toBe(10);
      expect(byModel.get("deepseek-reasoner")?.inputTokens).toBe(20);
      expect(byModel.get("deepseek-reasoner")?.reasoningTokens).toBe(4);
      expect(byModel.get("deepseek-reasoner")?.outputTokens).toBe(5);
      // the session reports both models rather than collapsing onto one
      expect(result.sessions[0].modelUsages.map((u) => u.model).sort()).toEqual(
        ["deepseek-chat", "deepseek-reasoner"],
      );
    });

    it("falls back to the routed model when a call declares none", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      writeSessionLog(
        sessionsDir,
        "--home-user-my-project--",
        "sess-fallback",
        [
          header,
          event("request/context", 1, 1_785_739_543_301, {
            provider: "deepseek",
            model: "deepseek-chat",
          }),
          event("assistant/message", 2, 1_785_739_545_000, {
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
      );

      const result = await new DshParser(sessionsDir).parse();

      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].model).toBe("deepseek-chat");
    });
  });

  describe("damaged logs", () => {
    /**
     * A structurally complete frame the decoder refuses means committed usage
     * is missing. The upload replaces the device snapshot, so the source has to
     * defer instead of publishing a short total.
     */
    it("defers when a committed frame cannot be decompressed", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      const dir = join(sessionsDir, "--home-user-my-project--", "sess-bad");
      mkdirSync(dir, { recursive: true });
      // Single-segment descriptor declaring an empty content size, so the
      // scanner admits the frame but zstd rejects the size mismatch.
      const magic = Buffer.alloc(4);
      magic.writeUInt32LE(0xfd2fb528, 0);
      const blockHeader = Buffer.alloc(3);
      blockHeader.writeUIntLE(1 | (2 << 1) | (64 << 3), 0, 3);
      const corrupt = Buffer.concat([
        magic,
        Buffer.from([0x20, 0x00]),
        blockHeader,
        Buffer.alloc(64, 0xff),
      ]);
      writeFileSync(
        join(dir, "session.v4.jsonl.zstd"),
        Buffer.concat([
          zlib.zstdCompressSync(
            `${JSON.stringify({ ...header, version: 4 })}\n`,
          ),
          corrupt,
        ]),
      );

      const result = await new DshParser(sessionsDir).parse();

      expect(result.incomplete).toBe(true);
      expect(result.buckets).toEqual([]);
    });

    it("still reads a crash-truncated tail frame", async () => {
      const sessionsDir = makeTempDir("tokenarena-dsh-");
      writeSessionLog(
        sessionsDir,
        "--home-user-my-project--",
        "sess-torn",
        [
          header,
          event("assistant/message", 1, 1_785_739_545_000, {
            turn: 1,
            step: 1,
            message: { role: "assistant", content: [] },
            usage: { inputTokens: 4, outputTokens: 6 },
          }),
        ],
        "zstd",
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]),
      );

      const result = await new DshParser(sessionsDir).parse();

      // A torn final frame is the documented crash shape, not corruption.
      expect(result.incomplete).toBeUndefined();
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].totalTokens).toBe(10);
    });
  });
});
