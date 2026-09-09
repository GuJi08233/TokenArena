import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KimiCodeParser } from "./kimi-code";

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

describe("KimiCodeParser", () => {
  it("parses new format (usage.record) with workspaces.json", async () => {
    const rootDir = makeTempDir("tokenarena-kimi-new-");
    const sessionsDir = join(rootDir, "sessions");
    const wireDir = join(
      sessionsDir,
      "wd_test_abc123",
      "session-1",
      "agents",
      "main",
    );
    mkdirSync(wireDir, { recursive: true });

    writeFileSync(
      join(rootDir, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: {
          wd_test_abc123: {
            root: "/Users/dev/my-project",
            name: "my-project",
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(wireDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "turn.prompt",
          payload: {
            timestamp: "2026-07-17T10:00:00.000Z",
          },
        }),
        JSON.stringify({
          type: "usage.record",
          model: "moonshot-cn/kimi-k3",
          usage: {
            inputOther: 2000,
            output: 500,
            inputCacheRead: 15000,
            inputCacheCreation: 0,
          },
          usageScope: "turn",
          time: 1784233181220,
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new KimiCodeParser({
      sessionsDir,
      configPath: join(rootDir, "workspaces.json"),
    });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "kimi-code",
      model: "moonshot-cn/kimi-k3",
      project: "my-project",
      inputTokens: 2000,
      outputTokens: 500,
      reasoningTokens: 0,
      cachedTokens: 15000,
      totalTokens: 17500,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "kimi-code",
      project: "my-project",
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 2000,
      outputTokens: 500,
      reasoningTokens: 0,
      cachedTokens: 15000,
      totalTokens: 17500,
      primaryModel: "moonshot-cn/kimi-k3",
    });
  });

  it("parses legacy format (StatusUpdate) with kimi.json", async () => {
    const rootDir = makeTempDir("tokenarena-kimi-legacy-");
    const sessionsDir = join(rootDir, "sessions");
    const wireDir = join(sessionsDir, "workspace-hash", "session-1");
    mkdirSync(wireDir, { recursive: true });

    writeFileSync(
      join(rootDir, "kimi.json"),
      JSON.stringify({
        workspaces: {
          "workspace-hash": "/Users/dev/tokenarena",
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(wireDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "UserMessage",
          payload: {
            timestamp: "2026-03-26T10:00:00.000Z",
          },
        }),
        JSON.stringify({
          type: "StatusUpdate",
          payload: {
            timestamp: "2026-03-26T10:00:03.000Z",
            model: "kimi-k2.5",
            message_id: "msg-1",
            token_usage: {
              input_other: 90,
              output: 40,
              input_cache_read: 10,
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new KimiCodeParser({
      sessionsDir,
      configPath: join(rootDir, "kimi.json"),
    });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "kimi-code",
      model: "kimi-k2.5",
      project: "tokenarena",
      inputTokens: 90,
      outputTokens: 40,
      reasoningTokens: 0,
      cachedTokens: 10,
      totalTokens: 140,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "kimi-code",
      project: "tokenarena",
      durationSeconds: 3,
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 90,
      outputTokens: 40,
      reasoningTokens: 0,
      cachedTokens: 10,
      totalTokens: 140,
      primaryModel: "kimi-k2.5",
    });
  });

  it("uses workDirHash as fallback when workspace not found in config", async () => {
    const rootDir = makeTempDir("tokenarena-kimi-fallback-");
    const sessionsDir = join(rootDir, "sessions");
    const wireDir = join(
      sessionsDir,
      "wd_unknown_xyz789",
      "session-1",
      "agents",
      "main",
    );
    mkdirSync(wireDir, { recursive: true });

    writeFileSync(
      join(wireDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "usage.record",
          model: "kimi-k3",
          time: 1784233181220,
          usage: {
            inputOther: 100,
            output: 50,
            inputCacheRead: 0,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new KimiCodeParser({ sessionsDir });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "kimi-code",
      project: "wd_unknown_xyz789",
    });
  });

  it("returns empty result when sessions directory does not exist", async () => {
    const parser = new KimiCodeParser({
      sessionsDir: "/nonexistent/path",
    });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(0);
    expect(result.sessions).toHaveLength(0);
  });

  it("resolves placeholder model from preceding llm.request", async () => {
    const rootDir = makeTempDir("tokenarena-kimi-alias-");
    const sessionsDir = join(rootDir, "sessions");
    const wireDir = join(
      sessionsDir,
      "wd_alias_test",
      "session-1",
      "agents",
      "main",
    );
    mkdirSync(wireDir, { recursive: true });

    writeFileSync(
      join(rootDir, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: {
          wd_alias_test: {
            root: "/Users/dev/alias-project",
            name: "alias-project",
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(wireDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "llm.request",
          model: "kimi-k3",
          modelAlias: "__kimi_env_model__",
          time: 1788972902502,
        }),
        JSON.stringify({
          type: "usage.record",
          model: "__kimi_env_model__",
          usage: {
            inputOther: 7170,
            output: 119,
            inputCacheRead: 17232,
          },
          usageScope: "turn",
          time: 1788972916867,
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new KimiCodeParser({
      sessionsDir,
      configPath: join(rootDir, "workspaces.json"),
    });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "kimi-code",
      model: "kimi-k3",
      project: "alias-project",
      inputTokens: 7170,
      outputTokens: 119,
      cachedTokens: 17232,
    });

    expect(result.sessions[0]).toMatchObject({
      primaryModel: "kimi-k3",
    });
  });

  it("keeps real model in usage.record when no placeholder is used", async () => {
    const rootDir = makeTempDir("tokenarena-kimi-real-");
    const sessionsDir = join(rootDir, "sessions");
    const wireDir = join(
      sessionsDir,
      "wd_real_test",
      "session-1",
      "agents",
      "main",
    );
    mkdirSync(wireDir, { recursive: true });

    writeFileSync(
      join(rootDir, "workspaces.json"),
      JSON.stringify({
        version: 1,
        workspaces: {
          wd_real_test: {
            root: "/Users/dev/real-project",
            name: "real-project",
          },
        },
      }),
      "utf-8",
    );

    writeFileSync(
      join(wireDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "llm.request",
          model: "kimi-k3",
          time: 1788972902502,
        }),
        JSON.stringify({
          type: "usage.record",
          model: "moonshot-cn/kimi-k3",
          usage: {
            inputOther: 500,
            output: 100,
            inputCacheRead: 2000,
          },
          usageScope: "turn",
          time: 1788972916867,
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new KimiCodeParser({
      sessionsDir,
      configPath: join(rootDir, "workspaces.json"),
    });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "moonshot-cn/kimi-k3",
    });
  });

  it("falls back to unknown when usage.record has placeholder but no preceding llm.request", async () => {
    const rootDir = makeTempDir("tokenarena-kimi-noalias-");
    const sessionsDir = join(rootDir, "sessions");
    const wireDir = join(
      sessionsDir,
      "wd_noalias_test",
      "session-1",
      "agents",
      "main",
    );
    mkdirSync(wireDir, { recursive: true });

    writeFileSync(
      join(wireDir, "wire.jsonl"),
      [
        JSON.stringify({
          type: "usage.record",
          model: "__kimi_env_model__",
          usage: {
            inputOther: 100,
            output: 50,
            inputCacheRead: 0,
          },
          usageScope: "turn",
          time: 1788972916867,
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new KimiCodeParser({ sessionsDir });
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      model: "unknown",
    });
  });
});
