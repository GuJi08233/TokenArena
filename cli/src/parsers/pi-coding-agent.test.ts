import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import {
  extractPiProjectFromCwd,
  extractPiProjectFromDir,
  PiCodingAgentParser,
} from "./pi-coding-agent";

const makeTempDir = useTempDirs();

function writeSession(directory: string, name: string, rows: unknown[]) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${name}.jsonl`),
    [
      {
        type: "session",
        id: name,
        cwd: "/work/project",
        timestamp: "2026-03-26T10:00:00Z",
      },
      ...rows,
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
}

describe("pi project resolution", () => {
  it("extracts the cwd leaf when a session header is present", () => {
    expect(extractPiProjectFromCwd("/Users/dev/tokenarena")).toBe("tokenarena");
  });

  it("decodes URI-encoded workspace directories", () => {
    expect(
      extractPiProjectFromDir(
        "/tmp/sessions/%2FUsers%2Fdev%2Ftokenarena/session-1.jsonl",
        "/tmp/sessions",
      ),
    ).toBe("tokenarena");
  });
});

describe("PiCodingAgentParser", () => {
  it("counts reported usage for tool calls, summaries and failed assistant turns", async () => {
    const root = makeTempDir("tokenarena-pi-usage-");
    writeSession(root, "extended", [
      {
        type: "message",
        id: "failed",
        timestamp: 1774519201,
        message: {
          role: "assistant",
          model: "requested",
          responseModel: "actual",
          stopReason: "error",
          usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 30 },
        },
      },
      {
        type: "message",
        id: "tool",
        timestamp: 1774519202000,
        message: {
          role: "toolResult",
          usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
        },
      },
      {
        type: "compaction",
        id: "compact",
        timestamp: "2026-03-26T10:00:03Z",
        usage: { input: 7, output: 8, cacheWrite: 9 },
      },
      {
        type: "branch_summary",
        id: "summary",
        usage: { input: 1, cacheWrite: 2 },
      },
      { type: "message", id: "empty-tool", message: { role: "toolResult" } },
    ]);
    const result = await new PiCodingAgentParser(root).parse();
    expect(
      result.buckets.find((bucket) => bucket.model === "actual"),
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 20,
      cacheCreationTokens: 30,
      totalTokens: 62,
    });
    expect(
      result.buckets.find((bucket) => bucket.model === "unknown"),
    ).toMatchObject({
      inputTokens: 11,
      outputTokens: 12,
      cachedTokens: 5,
      cacheCreationTokens: 17,
      totalTokens: 45,
    });
    expect(result.sessions[0]).toMatchObject({
      cacheCreationTokens: 47,
      totalTokens: 107,
    });
  });

  it("retains cache-write-only aborted usage without adding reasoning twice", async () => {
    const root = makeTempDir("tokenarena-pi-cache-");
    writeSession(root, "aborted", [
      {
        type: "message",
        id: "abort",
        timestamp: "2026-03-26T10:00:01Z",
        message: {
          role: "assistant",
          model: "pi-model",
          stopReason: "aborted",
          usage: { cacheWrite: 75 },
        },
      },
      {
        type: "message",
        id: "reason",
        timestamp: "2026-03-26T10:00:02Z",
        message: {
          role: "assistant",
          model: "pi-model",
          usage: { output: 30, thinkingTokens: 10 },
        },
      },
    ]);
    const result = await new PiCodingAgentParser(root).parse();
    expect(result.buckets[0]).toMatchObject({
      outputTokens: 20,
      reasoningTokens: 10,
      cacheCreationTokens: 75,
      totalTokens: 105,
    });
  });

  it("deduplicates forked entries while retaining reused ids at different timestamps", async () => {
    const root = makeTempDir("tokenarena-pi-forks-");
    const first = {
      type: "message",
      id: "reused",
      timestamp: "2026-03-26T10:00:01Z",
      message: { role: "assistant", model: "pi-model", usage: { input: 10 } },
    };
    const rows = [
      first,
      { ...first, timestamp: "2026-03-26T10:00:02Z" },
      { ...first, id: "separate" },
    ];
    writeSession(root, "original", rows);
    writeSession(root, "fork", rows);
    const result = await new PiCodingAgentParser(root).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 30,
      totalTokens: 30,
    });
  });

  it("deduplicates legacy records semantically without depending on object key order", async () => {
    const root = makeTempDir("tokenarena-pi-legacy-");
    writeSession(root, "original", [
      {
        type: "message",
        timestamp: "2026-03-26T10:00:01Z",
        message: {
          role: "assistant",
          model: "pi-model",
          content: [{ type: "text", text: "answer" }],
          usage: { input: 10, output: 5 },
        },
      },
    ]);
    writeSession(root, "copy", [
      {
        type: "message",
        timestamp: "2026-03-26T10:00:01Z",
        message: {
          content: [{ text: "answer", type: "text" }],
          usage: { output: 5, input: 10 },
          model: "pi-model",
          role: "assistant",
        },
      },
    ]);
    const result = await new PiCodingAgentParser(root).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });
  it("parses pi coding agent sessions and ignores toolResult messages", async () => {
    const sessionsDir = makeTempDir("tokenarena-pi-");
    const sessionFileDir = join(sessionsDir, "workspace-tokenarena");
    mkdirSync(sessionFileDir, { recursive: true });

    const sessionPath = join(sessionFileDir, "20260326_sess-1.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          id: "sess-1",
          cwd: "/Users/dev/tokenarena",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-26T10:00:00.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "msg-1",
          timestamp: "2026-03-26T10:00:04.000Z",
          message: {
            role: "assistant",
            model: "gpt-5.4",
            usage: {
              input: 100,
              output: 30,
              cacheRead: 20,
            },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-26T10:00:05.000Z",
          message: { role: "toolResult" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new PiCodingAgentParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "pi-coding-agent",
      model: "gpt-5.4",
      project: "tokenarena",
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 0,
      cachedTokens: 20,
      totalTokens: 150,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "pi-coding-agent",
      project: "tokenarena",
      durationSeconds: 4,
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 0,
      cachedTokens: 20,
      totalTokens: 150,
      primaryModel: "gpt-5.4",
    });
  });
});
