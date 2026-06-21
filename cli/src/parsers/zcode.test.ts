import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeParser } from "./zcode";

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

describe("ZCodeParser", () => {
  it("parses ZCode model usage and session metadata from sqlite rows", async () => {
    const dataDir = makeTempDir("tokenarena-zcode-");
    const dbPath = join(dataDir, "db.sqlite");
    writeFileSync(dbPath, "", "utf-8");

    const parser = new ZCodeParser({
      dbPath,
      queryRows: async <TRow>(targetDbPath: string, query: string) => {
        expect(targetDbPath).toBe(dbPath);

        if (query.includes("FROM model_usage")) {
          return [
            {
              sessionId: "sess-1",
              directory: "C:\\work\\TokenArena",
              model: "gpt-5.5",
              startedAt: 1782022744909,
              inputTokens: 100,
              outputTokens: 40,
              reasoningTokens: 10,
              cacheReadInputTokens: 25,
            },
            {
              sessionId: "sess-1",
              directory: "C:\\work\\TokenArena",
              model: "gpt-5.5",
              startedAt: 1782022856087,
              inputTokens: 50,
              outputTokens: 20,
              reasoningTokens: 0,
              cacheReadInputTokens: 5,
            },
          ] as TRow[];
        }

        if (query.includes("FROM session")) {
          return [
            {
              id: "sess-1",
              directory: "C:\\work\\TokenArena",
              timeCreated: 1782022744898,
              timeUpdated: 1782022861329,
            },
          ] as TRow[];
        }

        if (query.includes("FROM message")) {
          return [
            {
              sessionId: "sess-1",
              timeCreated: 1782022744898,
              data: JSON.stringify({
                role: "user",
                time: { created: 1782022744898 },
              }),
            },
            {
              sessionId: "sess-1",
              timeCreated: 1782022744909,
              data: JSON.stringify({
                role: "assistant",
                time: { created: 1782022744909 },
              }),
            },
            {
              sessionId: "sess-1",
              timeCreated: 1782022856080,
              data: JSON.stringify({
                role: "user",
                time: { created: 1782022856080 },
              }),
            },
          ] as TRow[];
        }

        if (query.includes("FROM turn_usage")) {
          return [
            { sessionId: "sess-1", durationMs: 5963 },
            { sessionId: "sess-1", durationMs: 5242 },
          ] as TRow[];
        }

        return [];
      },
    });

    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "zcode",
      model: "gpt-5.5",
      project: "TokenArena",
      inputTokens: 150,
      outputTokens: 60,
      reasoningTokens: 10,
      cachedTokens: 30,
      totalTokens: 250,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "zcode",
      project: "TokenArena",
      durationSeconds: 111,
      activeSeconds: 11,
      messageCount: 3,
      userMessageCount: 2,
      inputTokens: 150,
      outputTokens: 60,
      reasoningTokens: 10,
      cachedTokens: 30,
      totalTokens: 250,
      primaryModel: "gpt-5.5",
    });
  });

  it("returns buckets when session queries fail", async () => {
    const dataDir = makeTempDir("tokenarena-zcode-");
    const dbPath = join(dataDir, "db.sqlite");
    writeFileSync(dbPath, "", "utf-8");

    const parser = new ZCodeParser({
      dbPath,
      queryRows: async <TRow>(_targetDbPath: string, query: string) => {
        if (query.includes("FROM model_usage")) {
          return [
            {
              sessionId: "sess-1",
              directory: "C:\\work\\TokenArena",
              model: "gpt-5.5",
              startedAt: 1782022744909,
              inputTokens: 10,
              outputTokens: 20,
              reasoningTokens: 0,
              cacheReadInputTokens: 5,
            },
          ] as TRow[];
        }

        throw new Error("session table missing");
      },
    });

    const result = await parser.parse();

    expect(result.sessions).toEqual([]);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "zcode",
      model: "gpt-5.5",
      project: "TokenArena",
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 5,
      totalTokens: 35,
    });
  });
});
