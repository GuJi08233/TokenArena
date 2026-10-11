import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { QwenCodeParser, resolveQwenProject } from "./qwen-code";

const makeTempDir = useTempDirs();

describe("resolveQwenProject", () => {
  it("prefers the cwd leaf when available", () => {
    expect(
      resolveQwenProject(
        "D:\\workspace\\tokenarena",
        "/tmp/ignored/session.jsonl",
      ),
    ).toBe("tokenarena");
  });

  it("falls back to the project directory in ~/.qwen/tmp", () => {
    expect(
      resolveQwenProject(
        undefined,
        "/tmp/qwen/workspace-123/chats/session-1.jsonl",
        "/tmp/qwen",
      ),
    ).toBe("workspace-123");
  });
});

describe("QwenCodeParser", () => {
  it("parses qwen session logs into buckets and sessions", async () => {
    const dataDir = makeTempDir("tokenarena-qwen-");
    const chatsDir = join(dataDir, "workspace-123", "chats");
    mkdirSync(chatsDir, { recursive: true });

    const sessionPath = join(chatsDir, "session-1.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-26T10:00:00.000Z",
          cwd: "/Users/dev/tokenarena",
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-26T10:00:04.000Z",
          cwd: "/Users/dev/tokenarena",
          uuid: "msg-1",
          model: "qwen3-coder-plus",
          usageMetadata: {
            promptTokenCount: 120,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 20,
            thoughtsTokenCount: 5,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new QwenCodeParser(dataDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "qwen-code",
      model: "qwen3-coder-plus",
      project: "tokenarena",
      inputTokens: 100,
      outputTokens: 35,
      reasoningTokens: 5,
      cachedTokens: 20,
      totalTokens: 160,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "qwen-code",
      project: "tokenarena",
      durationSeconds: 4,
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 100,
      outputTokens: 35,
      reasoningTokens: 5,
      cachedTokens: 20,
      totalTokens: 160,
      primaryModel: "qwen3-coder-plus",
      modelUsages: [
        {
          model: "qwen3-coder-plus",
          inputTokens: 100,
          outputTokens: 35,
          reasoningTokens: 5,
          cachedTokens: 20,
          totalTokens: 160,
        },
      ],
    });
  });
});

describe("QwenCodeParser project layout", () => {
  function chatLines(uuidPrefix: string) {
    return [
      JSON.stringify({
        type: "user",
        sessionId: "6b0389ac",
        uuid: `${uuidPrefix}-user`,
        timestamp: "2026-10-01T10:00:00.000Z",
        cwd: "/Users/dev/work",
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "6b0389ac",
        uuid: `${uuidPrefix}-assistant`,
        timestamp: "2026-10-01T10:00:05.000Z",
        cwd: "/Users/dev/work",
        model: "qwen3-coder-plus",
        usageMetadata: {
          promptTokenCount: 2_100,
          candidatesTokenCount: 31,
          cachedContentTokenCount: 0,
          thoughtsTokenCount: 0,
        },
      }),
    ].join("\n");
  }

  it("reads chats that current releases keep under projects/", async () => {
    // Qwen Code 0.25.0 writes `<home>/projects/<cwd>/chats/<session>.jsonl`
    // and nothing under `tmp`.
    const home = makeTempDir("tokenarena-qwen-home-");
    const chatsDir = join(home, "projects", "-Users-dev-work", "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(join(chatsDir, "6b0389ac.jsonl"), chatLines("a"), "utf-8");

    const parser = new QwenCodeParser(join(home, "tmp"));
    const result = await parser.parse();

    expect(parser.isInstalled()).toBe(true);
    expect(result.buckets).toEqual([
      expect.objectContaining({
        project: "work",
        inputTokens: 2_100,
        outputTokens: 31,
        totalTokens: 2_131,
      }),
    ]);
    expect(result.sessions).toHaveLength(1);
  });

  it("counts a chat present in both layouts once", async () => {
    const home = makeTempDir("tokenarena-qwen-home-");
    const oldDir = join(home, "tmp", "caed98fe", "chats");
    const newDir = join(home, "projects", "-Users-dev-work", "chats");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, "session-1.jsonl"), chatLines("a"), "utf-8");
    writeFileSync(join(newDir, "6b0389ac.jsonl"), chatLines("a"), "utf-8");

    const result = await new QwenCodeParser(join(home, "tmp")).parse();

    expect(result.buckets).toEqual([
      expect.objectContaining({ totalTokens: 2_131 }),
    ]);
    expect(result.sessions).toHaveLength(1);
  });
});
