import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DATA_DIR = join(homedir(), ".gemini", "tmp");

const fileContents = new Map<string, string>();
const existingPaths = new Set<string>();
const dirEntries = new Map<
  string,
  { name: string; isDirectory(): boolean }[]
>();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync(path: string) {
      if (existingPaths.has(path)) return true;
      return false;
    },
    readdirSync(path: string, opts?: { withFileTypes?: boolean }) {
      const entries = dirEntries.get(path);
      if (entries) {
        return opts?.withFileTypes ? entries : entries.map((e) => e.name);
      }
      // Pick a concrete overload per branch: the union would match none.
      return opts?.withFileTypes
        ? actual.readdirSync(path, { withFileTypes: true })
        : actual.readdirSync(path);
    },
    readFileSync(path: string, encoding: BufferEncoding) {
      const contents = fileContents.get(path);
      if (contents !== undefined) return contents;
      return actual.readFileSync(path, encoding);
    },
  };
});

function addPath(p: string) {
  existingPaths.add(p);
}

function addDir(
  dirPath: string,
  entries: { name: string; isDirectory(): boolean }[],
) {
  existingPaths.add(dirPath);
  dirEntries.set(dirPath, entries);
}

function addFile(path: string, content: string) {
  existingPaths.add(path);
  fileContents.set(path, content);
}

function addSessions(records: unknown[]) {
  const projectDir = join(DATA_DIR, "fixtures");
  const chatsDir = join(projectDir, "chats");
  addDir(DATA_DIR, [{ name: "fixtures", isDirectory: () => true }]);
  addDir(
    chatsDir,
    records.map((_, i) => ({
      name: `session-${i}.json`,
      isDirectory: () => false,
    })),
  );
  records.forEach((record, i) => {
    addFile(join(chatsDir, `session-${i}.json`), JSON.stringify(record));
  });
}

async function getParser() {
  await import("./gemini-cli");
  const { getParser: lookup } = await import("./registry");
  const parser = lookup("gemini-cli");
  if (!parser) throw new Error("gemini-cli parser not found");
  return parser;
}

describe("GeminiCliParser", () => {
  beforeEach(() => {
    fileContents.clear();
    existingPaths.clear();
    dirEntries.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves native output when thoughts exceed candidate output", async () => {
    addSessions([
      {
        sessionId: "native",
        messages: [
          {
            id: "g1",
            type: "gemini",
            timestamp: "2026-01-01T00:00:00Z",
            tokens: { input: 8522, output: 29, cached: 3138, thoughts: 405 },
          },
        ],
      },
    ]);
    const result = await (await getParser()).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 5384,
      outputTokens: 29,
      reasoningTokens: 405,
      cachedTokens: 3138,
      totalTokens: 8956,
    });
  });

  it.each([
    false,
    true,
  ])("selects the newest copied snapshot regardless of file order (reverse=%s)", async (reverse) => {
    const newer = {
      sessionId: "copied",
      messages: [
        {
          id: "msg",
          type: "gemini",
          timestamp: "2026-01-01T00:00:02Z",
          tokens: { input: 100 },
        },
      ],
    };
    const older = {
      sessionId: "copied",
      messages: [
        {
          id: "msg",
          type: "gemini",
          timestamp: "2026-01-01T00:00:01Z",
          tokens: { input: 10 },
        },
      ],
    };
    addSessions(reverse ? [older, newer] : [newer, older]);
    const result = await (await getParser()).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 100,
      totalTokens: 100,
    });
    expect(result.sessions[0].firstMessageAt).toBe("2026-01-01T00:00:02.000Z");
  });

  it("keeps complete usage when equal-time or empty copies follow it", async () => {
    const message = {
      id: "msg",
      type: "gemini",
      timestamp: "2026-01-01T00:00:01Z",
      tokens: { input: 100, output: 20, thoughts: 5 },
    };
    addSessions([
      { sessionId: "copied", messages: [message] },
      {
        sessionId: "copied",
        messages: [
          { ...message, tokens: { input: 10 } },
          { ...message, timestamp: "2026-01-01T00:00:02Z", tokens: {} },
        ],
      },
    ]);
    const result = await (await getParser()).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 125,
    });
  });

  it("retains cache-only usage and excludes usage attached to user messages", async () => {
    addSessions([
      {
        messages: [
          {
            type: "user",
            timestamp: "2026-01-01T00:00:00Z",
            tokens: { input: 999 },
          },
          {
            type: "gemini",
            timestamp: "2026-01-01T00:00:01Z",
            tokens: { input: 0, output: 0, cached: 5000 },
          },
        ],
      },
    ]);
    const result = await (await getParser()).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 0,
      cachedTokens: 5000,
      totalTokens: 5000,
    });
  });

  it("deduplicates copied session messages while retaining distinct identical turns", async () => {
    const message = {
      id: "g1",
      type: "gemini",
      timestamp: "2026-01-01T00:00:00Z",
      tokens: { input: 10, output: 5, thoughts: 2 },
    };
    addSessions([
      { sessionId: "same", messages: [message] },
      { sessionId: "same", messages: [message, { ...message, id: "g2" }] },
    ]);
    const result = await (await getParser()).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 34,
    });
    expect(result.sessions[0].messageCount).toBe(2);
  });

  it("uses totalTokenCount when candidate usage is absent without counting thoughts twice", async () => {
    addSessions([
      {
        messages: [
          {
            type: "gemini",
            timestamp: "2026-01-01T00:00:00Z",
            usageMetadata: {
              promptTokenCount: 100,
              totalTokenCount: 160,
              thoughtsTokenCount: 40,
              cachedContentTokenCount: 20,
            },
          },
        ],
      },
    ]);
    const result = await (await getParser()).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 80,
      outputTokens: 20,
      reasoningTokens: 40,
      cachedTokens: 20,
      totalTokens: 160,
    });
  });

  it("returns empty when no data dir", async () => {
    // Don't set up DATA_DIR, so existsSync returns false
    const parser = await getParser();
    const result = await parser.parse();

    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("parses messages with tokens field", async () => {
    const subDir = join(DATA_DIR, "abc123");
    const chatsDir = join(subDir, "chats");
    const sessionFile = join(chatsDir, "session-001.json");

    addPath(DATA_DIR);
    addDir(DATA_DIR, [{ name: "abc123", isDirectory: () => true }]);
    addPath(chatsDir);
    addDir(chatsDir, [{ name: "session-001.json", isDirectory: () => false }]);
    addFile(
      sessionFile,
      JSON.stringify({
        messages: [
          { role: "user", timestamp: "2026-01-01T00:00:00Z" },
          {
            role: "assistant",
            timestamp: "2026-01-01T00:00:01Z",
            model: "gemini-pro",
            tokens: { input: 100, output: 50, cached: 10, thoughts: 5 },
          },
        ],
      }),
    );

    const parser = await getParser();
    const result = await parser.parse();

    expect(result.buckets.length).toBeGreaterThanOrEqual(1);

    const bucket = result.buckets.find((b) => b.model === "gemini-pro");
    expect(bucket).toMatchObject({
      source: "gemini-cli",
      model: "gemini-pro",
      project: "unknown",
      inputTokens: 90, // 100 - 10 cached
      outputTokens: 50,
      reasoningTokens: 5,
      cachedTokens: 10,
    });

    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("parses messages with usage field", async () => {
    const subDir = join(DATA_DIR, "def456");
    const chatsDir = join(subDir, "chats");
    const sessionFile = join(chatsDir, "session-002.json");

    addPath(DATA_DIR);
    addDir(DATA_DIR, [{ name: "def456", isDirectory: () => true }]);
    addPath(chatsDir);
    addDir(chatsDir, [{ name: "session-002.json", isDirectory: () => false }]);
    addFile(
      sessionFile,
      JSON.stringify({
        messages: [
          { role: "user", timestamp: "2026-01-02T00:00:00Z" },
          {
            role: "assistant",
            timestamp: "2026-01-02T00:00:01Z",
            model: "gemini-2.5-flash",
            usage: {
              promptTokenCount: 200,
              candidatesTokenCount: 80,
              cachedContentTokenCount: 20,
              thoughtsTokenCount: 10,
            },
          },
        ],
      }),
    );

    const parser = await getParser();
    const result = await parser.parse();

    expect(result.buckets.length).toBeGreaterThanOrEqual(1);

    const bucket = result.buckets.find((b) => b.model === "gemini-2.5-flash");
    expect(bucket).toMatchObject({
      source: "gemini-cli",
      model: "gemini-2.5-flash",
      project: "unknown",
      inputTokens: 180, // 200 - 20 cached
      outputTokens: 80,
      reasoningTokens: 10,
      cachedTokens: 20,
    });
  });

  it("ignores non-user/assistant roles", async () => {
    const subDir = join(DATA_DIR, "ghi789");
    const chatsDir = join(subDir, "chats");
    const sessionFile = join(chatsDir, "session-003.json");

    addPath(DATA_DIR);
    addDir(DATA_DIR, [{ name: "ghi789", isDirectory: () => true }]);
    addPath(chatsDir);
    addDir(chatsDir, [{ name: "session-003.json", isDirectory: () => false }]);
    addFile(
      sessionFile,
      JSON.stringify({
        messages: [
          { role: "system", timestamp: "2026-01-03T00:00:00Z" },
          {
            role: "tool",
            timestamp: "2026-01-03T00:00:01Z",
            model: "gemini-pro",
            tokens: { input: 50, output: 25 },
          },
          { role: "user", timestamp: "2026-01-03T00:00:02Z" },
        ],
      }),
    );

    const parser = await getParser();
    const result = await parser.parse();

    // system and tool roles are ignored; only user produces a session event
    // but user has no tokens field, so no token buckets
    expect(result.buckets).toEqual([]);
    // There should be at least one session from the user message
    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    for (const session of result.sessions) {
      for (const mu of session.modelUsages) {
        expect(mu.totalTokens).toBe(0);
      }
    }
  });

  it("handles invalid JSON files", async () => {
    const badSubDir = join(DATA_DIR, "jkl012");
    const badChatsDir = join(badSubDir, "chats");
    const badFile = join(badChatsDir, "session-bad.json");

    const goodSubDir = join(DATA_DIR, "good");
    const goodChatsDir = join(goodSubDir, "chats");
    const goodFile = join(goodChatsDir, "session-good.json");

    addPath(DATA_DIR);
    addDir(DATA_DIR, [
      { name: "jkl012", isDirectory: () => true },
      { name: "good", isDirectory: () => true },
    ]);

    addPath(badChatsDir);
    addDir(badChatsDir, [
      { name: "session-bad.json", isDirectory: () => false },
    ]);
    addFile(badFile, "this is not valid json{{{");

    addPath(goodChatsDir);
    addDir(goodChatsDir, [
      { name: "session-good.json", isDirectory: () => false },
    ]);
    addFile(
      goodFile,
      JSON.stringify({
        messages: [
          { role: "user", timestamp: "2026-01-04T00:00:00Z" },
          {
            role: "assistant",
            timestamp: "2026-01-04T00:00:01Z",
            model: "gemini-pro",
            tokens: { input: 30, output: 15 },
          },
        ],
      }),
    );

    const parser = await getParser();
    const result = await parser.parse();

    // Should have parsed the good file and skipped the bad one
    const bucket = result.buckets.find((b) => b.model === "gemini-pro");
    expect(bucket).toMatchObject({
      source: "gemini-cli",
      model: "gemini-pro",
      inputTokens: 30,
      outputTokens: 15,
    });
  });

  it("parses .jsonl with type:'gemini' and project from directories", async () => {
    const subDir = join(DATA_DIR, "mno345");
    const chatsDir = join(subDir, "chats");
    const sessionFile = join(chatsDir, "session-aaa-bbb.jsonl");

    addPath(DATA_DIR);
    addDir(DATA_DIR, [{ name: "mno345", isDirectory: () => true }]);
    addPath(chatsDir);
    addDir(chatsDir, [
      { name: "session-aaa-bbb.jsonl", isDirectory: () => false },
    ]);
    const lines = [
      JSON.stringify({
        sessionId: "aaa-bbb",
        directories: ["/Users/me/01-Develop/MyProject"],
        createTime: "2026-01-05T00:00:00Z",
      }),
      JSON.stringify({ type: "user", timestamp: "2026-01-05T00:00:00Z" }),
      JSON.stringify({
        type: "gemini",
        timestamp: "2026-01-05T00:00:01Z",
        model: "gemini-2.5-pro",
        tokens: { input: 120, output: 60, cached: 15, thoughts: 8 },
      }),
    ];
    addFile(sessionFile, lines.join("\n"));

    const parser = await getParser();
    const result = await parser.parse();

    const bucket = result.buckets.find((b) => b.model === "gemini-2.5-pro");
    expect(bucket).toMatchObject({
      source: "gemini-cli",
      model: "gemini-2.5-pro",
      project: "MyProject",
      inputTokens: 105, // 120 - 15 cached
      outputTokens: 60,
      reasoningTokens: 8,
      cachedTokens: 15,
    });
    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("recurses into subagent chats/<parent>/<sub>.jsonl files", async () => {
    const subDir = join(DATA_DIR, "pqr678");
    const chatsDir = join(subDir, "chats");
    const parentDir = join(chatsDir, "parent-1");
    const subFile = join(parentDir, "sub-a.jsonl");

    addPath(DATA_DIR);
    addDir(DATA_DIR, [{ name: "pqr678", isDirectory: () => true }]);
    addPath(chatsDir);
    addDir(chatsDir, [{ name: "parent-1", isDirectory: () => true }]);
    addPath(parentDir);
    addDir(parentDir, [{ name: "sub-a.jsonl", isDirectory: () => false }]);
    const lines = [
      JSON.stringify({ directories: ["/proj/SubAgentRoot"] }),
      JSON.stringify({
        type: "gemini",
        timestamp: "2026-01-06T00:00:00Z",
        model: "gemini-pro",
        tokens: { input: 10, output: 5 },
      }),
    ];
    addFile(subFile, lines.join("\n"));

    const parser = await getParser();
    const result = await parser.parse();

    const bucket = result.buckets.find((b) => b.project === "SubAgentRoot");
    expect(bucket).toMatchObject({
      source: "gemini-cli",
      model: "gemini-pro",
      project: "SubAgentRoot",
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});
