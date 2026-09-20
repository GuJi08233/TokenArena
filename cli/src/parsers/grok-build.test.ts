import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { GrokBuildParser, projectFromEncodedCwd } from "./grok-build";

const makeTempDir = useTempDirs();

describe("projectFromEncodedCwd", () => {
  it("decodes URL-encoded cwd and uses the leaf name", () => {
    expect(projectFromEncodedCwd("%2FUsers%2Fphilfan%2Fi%2FTokenArena")).toBe(
      "TokenArena",
    );
  });
});

describe("GrokBuildParser", () => {
  it("keeps distinct anonymous completed turns sharing the same second", async () => {
    const root = makeTempDir("tokenarena-grok-anonymous-");
    const sessionDir = join(root, "%2Fwork%2Fproject", "same-second");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [10, 20]
        .map((inputTokens) =>
          JSON.stringify({
            method: "_x.ai/session/update",
            timestamp: 1784875700,
            params: {
              update: {
                sessionUpdate: "turn_completed",
                usage: { inputTokens },
              },
            },
          }),
        )
        .join("\n"),
    );
    const result = await new GrokBuildParser(root).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 30,
      totalTokens: 30,
    });
    expect(result.sessions[0].messageCount).toBe(2);
  });
  it("replaces the full model breakdown when a completed prompt is replayed", async () => {
    const root = makeTempDir("tokenarena-grok-replay-");
    const sessionDir = join(root, "%2Fwork%2Fproject", "replayed");
    mkdirSync(sessionDir, { recursive: true });
    const event = (model: string, timestamp: number) => ({
      method: "_x.ai/session/update",
      timestamp,
      params: {
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "same-prompt",
          usage: {
            modelUsage: { [model]: { inputTokens: 100, outputTokens: 20 } },
          },
        },
      },
    });
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [
        event("old-model", 1784875700),
        event("new-model", 1784875701),
        event("old-model", 1784875700),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const result = await new GrokBuildParser(root).parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "new-model",
      totalTokens: 120,
    });
  });
  it("counts independent turns once across active and archived copies", async () => {
    const root = makeTempDir("tokenarena-grok-archive-");
    const active = join(root, "sessions");
    const archived = join(root, "archived_sessions");
    const turn = (prompt: string, timestamp: number) => ({
      method: "_x.ai/session/update",
      timestamp,
      params: {
        sessionId: "shared-session",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: prompt,
          usage: {
            modelUsage: {
              "grok-build": {
                inputTokens: 100,
                outputTokens: 30,
                cachedReadTokens: 40,
                reasoningTokens: 20,
              },
            },
          },
        },
      },
    });
    for (const dataDir of [active, archived]) {
      const sessionDir = join(dataDir, "%2Fwork%2Fproject", "shared-session");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, "updates.jsonl"),
        [
          turn("first", 1784875700),
          turn("first", 1784875700),
          turn("second", 1784875701),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
    }
    const result = await new GrokBuildParser(active, archived).parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 120,
      outputTokens: 20,
      reasoningTokens: 40,
      cachedTokens: 80,
      totalTokens: 260,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messageCount).toBe(2);
  });

  it("imports archived-only turns and ignores intermediate snapshots", async () => {
    const root = makeTempDir("tokenarena-grok-archived-only-");
    const active = join(root, "sessions");
    const archived = join(root, "archived_sessions");
    const sessionDir = join(archived, "%2Fwork%2Fproject", "archived");
    mkdirSync(sessionDir, { recursive: true });
    const update = {
      usage: {
        inputTokens: 20,
        outputTokens: 7,
        cachedReadTokens: 5,
        reasoningTokens: 2,
      },
    };
    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [
        {
          timestamp: 1784875700,
          method: "_x.ai/session/update",
          params: {
            update: { ...update, sessionUpdate: "agent_message_chunk" },
          },
        },
        {
          timestamp: 1784875701,
          method: "_x.ai/session/update",
          params: { update },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const parser = new GrokBuildParser(active, archived);
    expect(parser.isInstalled()).toBe(true);
    const result = await parser.parse();
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 15,
      outputTokens: 5,
      reasoningTokens: 2,
      cachedTokens: 5,
      totalTokens: 27,
    });
  });
  it("parses turn_completed usage with modelUsage breakdown", async () => {
    const dataDir = makeTempDir("tokenarena-grok-");
    const sessionDir = join(
      dataDir,
      "%2FUsers%2Fphilfan%2Fi%2FTokenArena",
      "019f92e1-9bce-7f10-9080-effadf368d1c",
    );
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(
      join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: "019f92e1-9bce-7f10-9080-effadf368d1c" },
        current_model_id: "grok-4.5",
      }),
      "utf-8",
    );

    writeFileSync(
      join(sessionDir, "updates.jsonl"),
      [
        JSON.stringify({
          timestamp: 1_784_875_698,
          method: "session/update",
          params: {
            sessionId: "019f92e1-9bce-7f10-9080-effadf368d1c",
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "hello" },
              _meta: { promptId: "prompt-1" },
            },
          },
        }),
        // streaming duplicate of the same user prompt — should count once
        JSON.stringify({
          timestamp: 1_784_875_699,
          method: "session/update",
          params: {
            sessionId: "019f92e1-9bce-7f10-9080-effadf368d1c",
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: " hello" },
              _meta: { promptId: "prompt-1" },
            },
          },
        }),
        JSON.stringify({
          timestamp: 1_784_875_720,
          method: "_x.ai/session/update",
          params: {
            sessionId: "019f92e1-9bce-7f10-9080-effadf368d1c",
            update: {
              sessionUpdate: "turn_completed",
              prompt_id: "prompt-1",
              stop_reason: "end_turn",
              usage: {
                inputTokens: 1000,
                outputTokens: 200,
                totalTokens: 1200,
                cachedReadTokens: 400,
                reasoningTokens: 50,
                modelCalls: 2,
                modelUsage: {
                  "grok-4.5-build-free": {
                    inputTokens: 1000,
                    outputTokens: 200,
                    totalTokens: 1200,
                    cachedReadTokens: 400,
                    reasoningTokens: 50,
                    modelCalls: 2,
                  },
                },
                numTurns: 2,
              },
            },
          },
          _meta: { agentTimestampMs: 1_784_875_720_000 },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new GrokBuildParser(dataDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "grok-build",
      model: "grok-4.5-build-free",
      project: "TokenArena",
      // input excludes cache, output excludes reasoning
      inputTokens: 600,
      outputTokens: 150,
      reasoningTokens: 50,
      cachedTokens: 400,
      totalTokens: 1200,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "grok-build",
      project: "TokenArena",
      userMessageCount: 1,
      messageCount: 2,
      primaryModel: "grok-4.5-build-free",
      totalTokens: 1200,
    });
  });

  it("returns empty when no sessions", async () => {
    const dataDir = makeTempDir("tokenarena-grok-empty-");
    const parser = new GrokBuildParser(dataDir);
    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });
});
