import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";

import { OpenCodeParser } from "./opencode";

describe("OpenCodeParser", () => {
  it.each([
    true,
    false,
  ])("deduplicates SQLite copies only when a native message id is present (hasId=%s)", async (hasId) => {
    const roots = [
      makeTempDir("tokenarena-opencode-copy-"),
      makeTempDir("tokenarena-opencode-copy-"),
    ];
    for (const root of roots) writeFileSync(join(root, "opencode.db"), "");
    const parser = new OpenCodeParser(
      () => roots,
      async (_path, query) => {
        expect(query).toContain("id as messageId");
        return [
          {
            messageId: hasId ? "msg-native" : undefined,
            sessionID: "ses-native",
            role: "assistant",
            created: 1768471200000,
            modelID: "model",
            rootPath: null,
            tokens: JSON.stringify({
              input: 10,
              output: 5,
              reasoning: 4,
              cache: { read: 2, write: 3 },
            }),
          },
        ];
      },
    );
    const result = await parser.parse();
    expect(
      result.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    ).toBe(hasId ? 24 : 48);
  });

  it("deduplicates native JSON message identities across different roots", async () => {
    const roots = [
      makeTempDir("tokenarena-opencode-json-copy-"),
      makeTempDir("tokenarena-opencode-json-copy-"),
    ];
    for (const root of roots) {
      const dir = join(root, "storage", "message", "ses_copy");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "message.json"),
        JSON.stringify({
          id: "msg-copy",
          sessionID: "ses-copy",
          role: "assistant",
          time: { created: 1768471200000 },
          tokens: {
            input: 10,
            output: 5,
            reasoning: 4,
            cache: { read: 2, write: 3 },
          },
        }),
      );
    }
    const result = await new OpenCodeParser(() => roots).parse();
    expect(
      result.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    ).toBe(24);
    expect(result.sessions).toHaveLength(1);
  });

  it("marks unreadable SQLite data incomplete even when legacy fallback has rows", async () => {
    const root = makeTempDir("tokenarena-opencode-read-failure-");
    writeFileSync(join(root, "opencode.db"), "");
    const dir = join(root, "storage", "message", "ses_fallback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "message.json"),
      JSON.stringify({
        id: "msg",
        role: "assistant",
        time: { created: 1768471200000 },
        tokens: { input: 10 },
      }),
    );
    const result = await new OpenCodeParser(
      () => [root],
      async () => {
        throw new Error("database is locked");
      },
    ).parse();
    expect(result.incomplete).toBe(true);
    expect(result.buckets[0].totalTokens).toBe(10);
  });
  const originalOpenCodeDir = process.env.TOKEN_ARENA_OPENCODE_DIR;
  const makeTempDir = useTempDirs();

  afterEach(() => {
    process.env.TOKEN_ARENA_OPENCODE_DIR = originalOpenCodeDir;
  });

  it("ignores malformed negative token usage entries from json storage", async () => {
    const rootDir = makeTempDir("tokenarena-opencode-");

    const sessionDir = join(rootDir, "storage", "message", "ses_1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "msg-1.json"),
      JSON.stringify({
        created: "2026-01-12T14:49:26.154Z",
        modelID: "gemini-claude-opus-4-5-thinking",
        path: {
          root: "E:\\Users\\User\\Desktop\\ParticleSaturn",
        },
        role: "assistant",
        time: {
          created: "2026-01-12T14:49:26.154Z",
        },
        tokens: {
          input: -9053,
          output: 70,
          reasoning: 0,
          cache: {
            read: 12068,
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(sessionDir, "msg-0.json"),
      JSON.stringify({
        created: "2026-01-12T14:49:26.140Z",
        role: "user",
        time: {
          created: "2026-01-12T14:49:26.140Z",
        },
      }),
      "utf-8",
    );

    const parser = new OpenCodeParser(() => [rootDir]);
    const result = await parser.parse();

    expect(result.buckets).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "opencode",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      primaryModel: "",
      modelUsages: [],
    });
  });

  it("parses valid assistant messages from json storage", async () => {
    const rootDir = makeTempDir("tokenarena-opencode-");

    const sessionDir = join(rootDir, "storage", "message", "ses_2");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "msg-0.json"),
      JSON.stringify({
        role: "user",
        time: { created: "2026-01-15T10:00:00.000Z" },
      }),
      "utf-8",
    );
    writeFileSync(
      join(sessionDir, "msg-1.json"),
      JSON.stringify({
        role: "assistant",
        modelID: "gpt-4",
        time: { created: "2026-01-15T10:00:01.000Z" },
        tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 30 } },
        path: { root: "/home/user/my-project" },
      }),
      "utf-8",
    );

    const parser = new OpenCodeParser(() => [rootDir]);
    const result = await parser.parse();

    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets[0].inputTokens).toBe(200);
    expect(result.buckets[0].outputTokens).toBe(100);
    expect(result.buckets[0].reasoningTokens).toBe(20);
    expect(result.buckets[0].cachedTokens).toBe(30);
    expect(result.sessions.length).toBeGreaterThan(0);
  });

  it("returns empty when directory does not exist", async () => {
    const parser = new OpenCodeParser(() => ["/nonexistent/path"]);
    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("skips messages without valid timestamps", async () => {
    const rootDir = makeTempDir("tokenarena-opencode-");

    const sessionDir = join(rootDir, "storage", "message", "ses_3");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "msg-0.json"),
      JSON.stringify({
        role: "assistant",
        modelID: "gpt-4",
        tokens: { input: 100, output: 50 },
        // no time.created or created field
      }),
      "utf-8",
    );

    const parser = new OpenCodeParser(() => [rootDir]);
    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
  });

  it("preserves reported usage without modelID as unknown", async () => {
    const rootDir = makeTempDir("tokenarena-opencode-");

    const sessionDir = join(rootDir, "storage", "message", "ses_4");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "msg-0.json"),
      JSON.stringify({
        role: "assistant",
        time: { created: "2026-01-15T10:00:00.000Z" },
        tokens: { input: 100, output: 50 },
      }),
      "utf-8",
    );

    const parser = new OpenCodeParser(() => [rootDir]);
    const result = await parser.parse();
    expect(result.buckets[0]).toMatchObject({
      model: "unknown",
      totalTokens: 150,
    });
  });

  it("includes cache-write-only and reasoning-only JSON messages", async () => {
    const rootDir = makeTempDir("tokenarena-opencode-cache-");
    const sessionDir = join(rootDir, "storage", "message", "ses_cache");
    mkdirSync(sessionDir, { recursive: true });
    const base = {
      role: "assistant",
      modelID: "gpt-5",
      time: { created: 1768471200000 },
    };
    writeFileSync(
      join(sessionDir, "write.json"),
      JSON.stringify({ ...base, tokens: { cache: { write: 50, read: 30 } } }),
    );
    writeFileSync(
      join(sessionDir, "reasoning.json"),
      JSON.stringify({ ...base, tokens: { reasoning: 20 } }),
    );
    writeFileSync(
      join(sessionDir, "user.json"),
      JSON.stringify({ ...base, role: "user", tokens: { input: 999 } }),
    );
    const result = await new OpenCodeParser(() => [rootDir, rootDir]).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 20,
      cachedTokens: 30,
      cacheCreationTokens: 50,
      totalTokens: 100,
    });
    expect(result.sessions[0]).toMatchObject({
      cacheCreationTokens: 50,
      totalTokens: 100,
    });
  });

  it("uses the same native token categories for SQLite messages", async () => {
    const rootDir = makeTempDir("tokenarena-opencode-sqlite-");
    writeFileSync(join(rootDir, "opencode.db"), "");
    const parser = new OpenCodeParser(
      () => [rootDir],
      async () => [
        {
          sessionID: "sql",
          role: "assistant",
          created: 1768471200000,
          modelID: null,
          tokens: JSON.stringify({
            input: 3272,
            output: 383,
            reasoning: 419,
            cache: { read: 10, write: 40 },
          }),
          rootPath: null,
        },
        {
          sessionID: "sql",
          role: "assistant",
          created: 1768471201000,
          modelID: null,
          tokens: JSON.stringify({ cache: { read: 25, write: 5 } }),
          rootPath: null,
        },
      ],
    );
    const result = await parser.parse();
    expect(result.buckets[0]).toMatchObject({
      model: "unknown",
      inputTokens: 3272,
      outputTokens: 383,
      reasoningTokens: 419,
      cachedTokens: 35,
      cacheCreationTokens: 45,
      totalTokens: 4154,
    });
  });

  it("isInstalled returns true when dir exists", () => {
    const rootDir = makeTempDir("tokenarena-opencode-");
    const parser = new OpenCodeParser(() => [rootDir]);
    expect(parser.isInstalled()).toBe(true);
  });

  it("isInstalled returns false when no dirs exist", () => {
    const parser = new OpenCodeParser(() => ["/nonexistent/path"]);
    expect(parser.isInstalled()).toBe(false);
  });
});
