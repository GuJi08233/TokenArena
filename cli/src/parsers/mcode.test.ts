import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { getMcodeDbPath, McodeParser } from "./mcode";

const makeTempDir = useTempDirs();

function fixtureParser(rows: unknown[], sessionRows: unknown[] = []) {
  const dbPath = join(makeTempDir("tokenarena-mcode-"), "runtime-state.sqlite");
  writeFileSync(dbPath, "");
  return new McodeParser({
    dbPath,
    queryRows: async <TRow>(_path: string, query: string) =>
      (query.includes("FROM local_runtime_token_usage")
        ? rows
        : sessionRows) as TRow[],
  });
}

describe("McodeParser", () => {
  it("uses MiniMax's native data-directory precedence without sharing MiMoCode storage", () => {
    expect(getMcodeDbPath({})).toBe(
      join(homedir(), ".minimax", "v2", "sqlite", "runtime-state.sqlite"),
    );
    expect(
      getMcodeDbPath({
        MINIMAX_DATA_DIR: "  custom  ",
        MAVIS_DATA_DIR: "legacy",
      }),
    ).toBe(join("custom", "v2", "sqlite", "runtime-state.sqlite"));
    expect(
      getMcodeDbPath({ MINIMAX_DATA_DIR: " ", MAVIS_DATA_DIR: "legacy" }),
    ).toBe(join("legacy", "v2", "sqlite", "runtime-state.sqlite"));
  });

  it("preserves separate native counters and remaining model namespaces", async () => {
    const row = {
      id: 1,
      sessionId: "s1",
      model: "custom_provider:router/vendor/model",
      timestamp: 1774519200000,
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 3,
      cachedTokens: 40,
      cacheCreationTokens: 5,
    };
    const parser = fixtureParser(
      [row, row, { ...row, id: 2 }],
      [{ sessionId: "s1", directory: "C:\\work\\project" }],
    );
    const result = await parser.parse();
    expect(parser.tool).toMatchObject({ id: "mcode", name: "MiniMax Code" });
    expect(result.buckets[0]).toMatchObject({
      source: "mcode",
      model: "vendor/model",
      project: "project",
      inputTokens: 20,
      outputTokens: 40,
      reasoningTokens: 6,
      cachedTokens: 80,
      cacheCreationTokens: 10,
      totalTokens: 156,
    });
    expect(result.sessions[0]).toMatchObject({
      cacheCreationTokens: 10,
      totalTokens: 156,
    });
  });

  it("keeps cache-only rows and ignores empty or invalidly dated rows", async () => {
    const row = {
      id: 1,
      sessionId: "s",
      model: null,
      timestamp: 1774519200000,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 50,
    };
    const result = await fixtureParser([
      row,
      { ...row, id: 2, cacheCreationTokens: 0 },
      { ...row, id: 3, timestamp: "invalid" },
    ]).parse();
    expect(result.buckets[0]).toMatchObject({
      model: "unknown",
      cacheCreationTokens: 50,
      totalTokens: 50,
    });
  });

  it("does not query a missing database", async () => {
    const queryRows = vi.fn();
    const parser = new McodeParser({
      dbPath: join(makeTempDir(), "missing.sqlite"),
      queryRows,
    });
    expect(parser.isInstalled()).toBe(false);
    expect(await parser.parse()).toEqual({ buckets: [], sessions: [] });
    expect(queryRows).not.toHaveBeenCalled();
  });

  it("marks an existing unreadable usage database incomplete", async () => {
    const dbPath = join(
      makeTempDir("tokenarena-mcode-locked-"),
      "runtime-state.sqlite",
    );
    writeFileSync(dbPath, "");
    const result = await new McodeParser({
      dbPath,
      queryRows: async () => {
        throw new Error("database is locked");
      },
    }).parse();
    expect(result).toEqual({ buckets: [], sessions: [], incomplete: true });
  });

  it("marks unreadable session metadata incomplete instead of silently enabling rebuild", async () => {
    const dbPath = join(
      makeTempDir("tokenarena-mcode-meta-locked-"),
      "runtime-state.sqlite",
    );
    writeFileSync(dbPath, "");
    const result = await new McodeParser({
      dbPath,
      queryRows: async <TRow>(_path: string, query: string) => {
        if (query.includes("FROM local_runtime_sessions"))
          throw new Error("database is locked");
        return [] as TRow[];
      },
    }).parse();
    expect(result.incomplete).toBe(true);
  });

  it.skipIf(Number(process.versions.node.split(".")[0]) < 22)(
    "reads a synthetic native SQLite projection",
    async () => {
      const sqliteModule = "node:sqlite";
      const { DatabaseSync } = await import(sqliteModule);
      const dbPath = join(
        makeTempDir("tokenarena-mcode-sql-"),
        "runtime-state.sqlite",
      );
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`CREATE TABLE local_runtime_token_usage (
        id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, ts INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL);
        INSERT INTO local_runtime_token_usage VALUES
        (1, 's1', 'custom_provider:test/model', 1774519200000, 10, 20, 3, 40, 5, 0);`);
      } finally {
        db.close();
      }
      const result = await new McodeParser({ dbPath }).parse();
      expect(result.incomplete).toBeUndefined();
      expect(result.buckets[0]).toMatchObject({
        model: "model",
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 3,
        cachedTokens: 40,
        cacheCreationTokens: 5,
        totalTokens: 78,
      });
    },
  );
});
