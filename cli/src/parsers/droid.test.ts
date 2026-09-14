import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { DroidParser, extractDroidProject } from "./droid";

const makeTempDir = useTempDirs();

describe("extractDroidProject", () => {
  it("uses the final slug segment as the project name", () => {
    expect(extractDroidProject("workspace-tokenarena")).toBe("tokenarena");
  });
});

describe("DroidParser", () => {
  it("parses droid sessions and the paired settings file", async () => {
    const dataDir = makeTempDir("tokenarena-droid-");
    const sessionDir = join(dataDir, "workspace-tokenarena");
    mkdirSync(sessionDir, { recursive: true });

    const sessionPath = join(sessionDir, "session-1.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-26T10:00:00.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-26T10:00:04.000Z",
          message: { role: "assistant" },
        }),
      ].join("\n"),
      "utf-8",
    );

    writeFileSync(
      join(sessionDir, "session-1.settings.json"),
      JSON.stringify({
        model: "droid-v1",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 80,
          cacheReadTokens: 25,
          thinkingTokens: 15,
        },
      }),
      "utf-8",
    );

    const parser = new DroidParser(dataDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "droid",
      model: "droid-v1",
      project: "tokenarena",
      inputTokens: 75,
      outputTokens: 65,
      reasoningTokens: 15,
      cachedTokens: 25,
      totalTokens: 180,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "droid",
      project: "tokenarena",
      durationSeconds: 4,
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 75,
      outputTokens: 65,
      reasoningTokens: 15,
      cachedTokens: 25,
      totalTokens: 180,
      primaryModel: "droid-v1",
    });
  });
});
