import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../testing/temp-dir";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

type MockLogFile = { path: string; content: string; scanDir?: string };

let projectFiles: MockLogFile[] = [];

vi.mock("../infrastructure/fs/utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infrastructure/fs/utils")>();
  return {
    ...actual,
    findJsonlFiles: vi.fn((dir: string) => {
      return projectFiles
        .filter((file) => (file.scanDir ?? PROJECTS_DIR) === dir)
        .map((file) => file.path);
    }),
    readFileSafe: vi.fn((path: string) => {
      const file = projectFiles.find((f) => f.path === path);
      return file?.content ?? null;
    }),
  };
});

import "./claude-code";
import { getParser } from "./registry";

const parser = getParser("claude-code");
if (!parser) throw new Error("claude-code parser not found");

const makeTempDir = useTempDirs();

afterEach(() => {
  projectFiles = [];
  vi.unstubAllEnvs();
});

function setupMocks(files: MockLogFile[] = []) {
  projectFiles = files;
}

function userLine(uuid: string, timestamp: string): string {
  return JSON.stringify({ type: "user", timestamp, uuid });
}

function assistantLine(
  uuid: string,
  timestamp: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  model = "claude-3",
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    uuid,
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
      },
    },
  });
}

function requestLine({
  uuid = "event-1",
  messageId = "msg-1",
  requestId = "req-1",
  timestamp = "2026-01-01T00:00:01Z",
  stopReason,
  usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 30,
  },
}: {
  uuid?: string;
  messageId?: string;
  requestId?: string | null;
  timestamp?: string;
  stopReason?: string;
  usage?: Record<string, unknown>;
} = {}) {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp,
    ...(requestId === null ? {} : { requestId }),
    message: {
      id: messageId,
      model: "claude-sonnet-4-5",
      usage,
      stop_reason: stopReason,
    },
  });
}

describe("ClaudeCodeParser", () => {
  it("returns empty results when no files found", async () => {
    setupMocks([]);

    const result = await parser.parse();

    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("parses assistant messages with token usage", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: assistantLine("uuid-1", "2026-01-01T00:00:01Z", 100, 50, 10),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "claude-code",
      model: "claude-3",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
    });
  });

  it("ignores user messages (no token entries)", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: [
          userLine("uuid-user-1", "2026-01-01T00:00:00Z"),
          assistantLine("uuid-asst-1", "2026-01-01T00:00:01Z", 200, 100),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].inputTokens).toBe(200);
    expect(result.buckets[0].outputTokens).toBe(100);
  });

  it("handles malformed JSON lines gracefully", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: [
          "this is not json",
          assistantLine("uuid-1", "2026-01-01T00:00:01Z", 100, 50),
          "{broken json",
          "",
          "  ",
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].inputTokens).toBe(100);
    expect(result.buckets[0].outputTokens).toBe(50);
  });

  it("deduplicates by uuid", async () => {
    const file1 = join(makeTempDir("cc-test-"), "session-1.jsonl");
    const file2 = join(makeTempDir("cc-test-"), "session-2.jsonl");
    const content = assistantLine("same-uuid", "2026-01-01T00:00:01Z", 100, 50);

    setupMocks([
      { path: file1, content },
      { path: file2, content },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].inputTokens).toBe(100);
  });

  it("extracts session events for user and assistant messages", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: [
          userLine("uuid-user-1", "2026-01-01T00:00:00Z"),
          assistantLine("uuid-asst-1", "2026-01-01T00:00:01Z", 100, 50),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();

    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    const session = result.sessions[0];
    expect(session.messageCount).toBeGreaterThanOrEqual(2);
    expect(session.source).toBe("claude-code");
  });

  it("extracts project name from file path under projects dir", async () => {
    const projectDir = "my-host-my-project";
    const filePath = join(PROJECTS_DIR, projectDir, "session-xyz.jsonl");

    setupMocks([
      {
        path: filePath,
        content: assistantLine("uuid-1", "2026-01-01T00:00:01Z", 100, 50),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    // extractProject takes the last segment when splitting by "-"
    expect(result.buckets[0].project).toBe("project");
  });

  it("defaults project to unknown for files outside projects dir", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: assistantLine("uuid-1", "2026-01-01T00:00:01Z", 100, 50),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets[0].project).toBe("unknown");
  });

  it("skips lines without a timestamp", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: [
          JSON.stringify({ type: "assistant", uuid: "no-ts" }),
          assistantLine("uuid-1", "2026-01-01T00:00:01Z", 100, 50),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].inputTokens).toBe(100);
  });

  it("skips assistant messages without usage data", async () => {
    const filePath = join(makeTempDir("cc-test-"), "session-abc123.jsonl");
    setupMocks([
      {
        path: filePath,
        content: [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-01-01T00:00:01Z",
            uuid: "no-usage",
            message: { model: "claude-3" },
          }),
          assistantLine("uuid-1", "2026-01-01T00:00:02Z", 100, 50),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].inputTokens).toBe(100);
  });

  it("counts cache creation separately in buckets and session model usage", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: requestLine({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 30,
            cache_creation: {
              ephemeral_5m_input_tokens: 20,
              ephemeral_1h_input_tokens: 10,
            },
          },
        }),
      },
    ]);

    const result = await parser.parse();
    const expected = {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 200,
      cacheCreationTokens: 30,
      totalTokens: 380,
    };

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject(expected);
    expect(result.sessions[0]).toMatchObject(expected);
    expect(result.sessions[0].modelUsages[0]).toMatchObject(expected);
  });

  it.each([
    { total: undefined, fiveMinutes: 20, oneHour: 10, expected: 30 },
    { total: null, fiveMinutes: 20, oneHour: 10, expected: 30 },
    { total: undefined, fiveMinutes: undefined, oneHour: 10, expected: 10 },
    { total: 0, fiveMinutes: 20, oneHour: 10, expected: 0 },
    { total: 7, fiveMinutes: 20, oneHour: 10, expected: 7 },
  ])("uses cache creation total or the TTL fallback: %j", async (fixture) => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: requestLine({
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: fixture.total,
            cache_creation: {
              ephemeral_5m_input_tokens: fixture.fiveMinutes,
              ephemeral_1h_input_tokens: fixture.oneHour,
            },
          },
        }),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 1,
      cacheCreationTokens: fixture.expected,
      totalTokens: fixture.expected + 1,
    });
  });

  it("imports cache-only requests without input or output fields", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: requestLine({
          usage: {
            cache_read_input_tokens: 12,
            cache_creation_input_tokens: 8,
          },
        }),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 12,
      cacheCreationTokens: 8,
      totalTokens: 20,
    });
  });

  it.each([
    false,
    true,
  ])("selects the completed stream snapshot regardless of file order (%s)", async (reverse) => {
    const snapshots = [
      requestLine({
        uuid: "partial",
        timestamp: "2026-01-01T00:00:01Z",
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 30,
        },
      }),
      requestLine({
        uuid: "final",
        timestamp: "2026-01-01T00:31:00Z",
        stopReason: "end_turn",
      }),
    ];
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: (reverse ? snapshots.reverse() : snapshots).join("\n"),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 200,
      cacheCreationTokens: 30,
      totalTokens: 380,
    });
    expect(result.sessions[0].totalTokens).toBe(380);
  });

  it("uses the largest incomplete snapshot and refreshes it on later parses", async () => {
    const file = {
      path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
      content: requestLine({ usage: { input_tokens: 100, output_tokens: 1 } }),
    };
    setupMocks([file]);
    expect((await parser.parse()).buckets[0].totalTokens).toBe(101);

    file.content += `\n${requestLine({
      uuid: "later",
      usage: { input_tokens: 100, output_tokens: 50 },
    })}`;
    expect((await parser.parse()).buckets[0].totalTokens).toBe(150);
  });

  it("keeps requests with reused message IDs separate", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: [
          requestLine({ uuid: "first", requestId: "request-a" }),
          requestLine({ uuid: "second", requestId: "request-b" }),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets[0].totalTokens).toBe(760);
  });

  it("merges a missing request ID only when its message has one known request", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: [
          requestLine({
            uuid: "partial",
            requestId: null,
            usage: { input_tokens: 100, output_tokens: 1 },
          }),
          requestLine({ uuid: "final", stopReason: "end_turn" }),
        ].join("\n"),
      },
    ]);

    expect((await parser.parse()).buckets[0].totalTokens).toBe(380);
  });

  it("deduplicates cross-file message snapshots without merging independent messages", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: requestLine(),
      },
      {
        path: join(PROJECTS_DIR, "project", "session-2.jsonl"),
        content: [
          requestLine({ uuid: "copied-event", stopReason: "end_turn" }),
          requestLine({
            uuid: "independent",
            messageId: "msg-2",
            requestId: "req-2",
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets[0].totalTokens).toBe(400);
    expect(
      result.sessions.map((session) => session.totalTokens).sort(),
    ).toEqual([20, 380]);
  });

  it("deduplicates timing events even when they contain no usage", async () => {
    const user = userLine("user-1", "2026-01-01T00:00:00Z");
    const assistant = JSON.stringify({
      type: "assistant",
      uuid: "without-usage",
      timestamp: "2026-01-01T00:00:01Z",
      message: { id: "msg-without-usage" },
    });
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: [user, user, assistant, assistant, requestLine()].join("\n"),
      },
    ]);

    expect((await parser.parse()).sessions[0]).toMatchObject({
      messageCount: 3,
      userMessageCount: 1,
      totalTokens: 380,
    });
  });

  it("merges same-path files from all roots without losing appended requests", async () => {
    const customRoot = makeTempDir("cc-custom-");
    vi.stubEnv("CLAUDE_CONFIG_DIR", customRoot);
    const relativePath = join("project", "session-1.jsonl");
    const firstRequest = requestLine();
    const user = userLine("user-1", "2026-01-01T00:00:00Z");
    setupMocks([
      {
        path: join(PROJECTS_DIR, relativePath),
        content: [user, firstRequest].join("\n"),
      },
      {
        path: join(customRoot, "projects", relativePath),
        scanDir: join(customRoot, "projects"),
        content: [
          user,
          firstRequest,
          requestLine({
            uuid: "new-event",
            messageId: "new-msg",
            requestId: "new-req",
          }),
        ].join("\n"),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets[0].totalTokens).toBe(760);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      messageCount: 3,
      userMessageCount: 1,
    });
  });

  it("includes normal and workflow subagent usage as independent requests", async () => {
    const sessionDir = join(PROJECTS_DIR, "project", "main-session");
    setupMocks([
      {
        path: `${sessionDir}.jsonl`,
        content: requestLine({
          messageId: "main-msg",
          requestId: "main-request",
        }),
      },
      {
        path: join(sessionDir, "subagents", "agent-a.jsonl"),
        content: requestLine({
          uuid: "agent-a",
          messageId: "agent-msg",
          requestId: "agent-request",
        }),
      },
      {
        path: join(
          sessionDir,
          "subagents",
          "workflows",
          "wf-1",
          "agent-b.jsonl",
        ),
        content: requestLine({
          uuid: "agent-b",
          messageId: "workflow-msg",
          requestId: "workflow-request",
        }),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets[0].totalTokens).toBe(1140);
    expect(result.sessions).toHaveLength(3);
    expect(
      result.sessions.every((session) => session.totalTokens === 380),
    ).toBe(true);
  });

  it("rejects invalid cache counters without suppressing a valid snapshot", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: [
          requestLine({
            usage: { input_tokens: 100, cache_creation_input_tokens: -1 },
          }),
          requestLine({ stopReason: "end_turn" }),
        ].join("\n"),
      },
    ]);

    expect((await parser.parse()).buckets[0].totalTokens).toBe(380);
  });

  it("does not merge ambiguous snapshots into one of several request IDs", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: [
          requestLine({ uuid: "unknown", requestId: null }),
          requestLine({ uuid: "first", requestId: "request-a" }),
          requestLine({ uuid: "second", requestId: "request-b" }),
        ].join("\n"),
      },
    ]);

    expect((await parser.parse()).buckets[0].totalTokens).toBe(1140);
  });

  it("prefers a completed snapshot over a larger unfinished one", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: [
          requestLine({ stopReason: "end_turn" }),
          requestLine({
            uuid: "unfinished",
            usage: { input_tokens: 100, output_tokens: 1000 },
          }),
        ].join("\n"),
      },
    ]);

    expect((await parser.parse()).buckets[0].totalTokens).toBe(380);
  });

  it("keeps usage with its original timing event when a later copy adds usage", async () => {
    const withoutUsage = JSON.parse(requestLine());
    delete withoutUsage.message.usage;
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: JSON.stringify(withoutUsage),
      },
      {
        path: join(PROJECTS_DIR, "project", "session-2.jsonl"),
        content: requestLine(),
      },
    ]);

    const result = await parser.parse();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      totalTokens: 380,
      messageCount: 1,
    });
  });

  it("rejects an invalid TTL component instead of cancelling it against another", async () => {
    setupMocks([
      {
        path: join(PROJECTS_DIR, "project", "session-1.jsonl"),
        content: requestLine({
          usage: {
            input_tokens: 100,
            cache_creation: {
              ephemeral_5m_input_tokens: -1,
              ephemeral_1h_input_tokens: 10,
            },
          },
        }),
      },
    ]);

    expect((await parser.parse()).buckets).toEqual([]);
  });

  it("preserves transcript-only sessions and merges their timing events across roots", async () => {
    const customRoot = makeTempDir("cc-transcripts-");
    vi.stubEnv("CLAUDE_CONFIG_DIR", customRoot);
    const transcriptDir = join(homedir(), ".claude", "transcripts");
    const customTranscriptDir = join(customRoot, "transcripts");
    const user = userLine("user-1", "2026-01-01T00:00:00Z");
    setupMocks([
      {
        path: join(transcriptDir, "session-1.jsonl"),
        scanDir: transcriptDir,
        content: user,
      },
      {
        path: join(customTranscriptDir, "session-1.jsonl"),
        scanDir: customTranscriptDir,
        content: [user, requestLine()].join("\n"),
      },
    ]);

    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      messageCount: 2,
      userMessageCount: 1,
    });
  });

  it("isInstalled returns true when data dirs exist", () => {
    // ~/.claude/projects exists on this machine
    if (existsSync(join(homedir(), ".claude", "projects"))) {
      expect(parser.isInstalled?.()).toBe(true);
    } else {
      expect(parser.isInstalled?.()).toBe(false);
    }
  });
});
