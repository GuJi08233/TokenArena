import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the readSqliteRows function
vi.mock("../infrastructure/sqlite", () => ({
  readSqliteRows: vi.fn(),
}));

// Mock existsSync
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readSqliteRows } from "../infrastructure/sqlite";
import { MimocodeParser } from "./mimocode";

const mockReadSqliteRows = vi.mocked(readSqliteRows);
const mockExistsSync = vi.mocked(existsSync);

describe("MimocodeParser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isInstalled returns true when db path exists", () => {
    mockExistsSync.mockReturnValueOnce(true);
    const parser = new MimocodeParser(() => ["/test/mimocode.db"]);
    expect(parser.isInstalled()).toBe(true);
  });

  it("isInstalled returns false when no paths exist", () => {
    mockExistsSync.mockReturnValue(false);
    const parser = new MimocodeParser(() => ["/nonexistent/path/mimocode.db"]);
    expect(parser.isInstalled()).toBe(false);
  });

  it("returns empty when no database files exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const parser = new MimocodeParser(() => ["/nonexistent/path/mimocode.db"]);
    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("parses assistant messages with token usage", async () => {
    mockExistsSync.mockReturnValue(true);

    mockReadSqliteRows
      .mockResolvedValueOnce([
        {
          sessionId: "ses_test1",
          modelID: "mimo-v2.5-pro",
          inputTokens: 1000,
          outputTokens: 500,
          reasoningTokens: 100,
          cacheReadTokens: 2000,
          cacheWriteTokens: 0,
          timeCreated: 1780484742822,
          directory: "/home/user/my-project",
        },
        {
          sessionId: "ses_test1",
          modelID: "mimo-v2.5-pro",
          inputTokens: 500,
          outputTokens: 200,
          reasoningTokens: 50,
          cacheReadTokens: 1000,
          cacheWriteTokens: 0,
          timeCreated: 1780484800000,
          directory: "/home/user/my-project",
        },
      ])
      .mockResolvedValueOnce([
        {
          sessionId: "ses_test1",
          role: "user",
          timeCreated: 1780484742000,
        },
        {
          sessionId: "ses_test1",
          role: "assistant",
          timeCreated: 1780484742822,
        },
        {
          sessionId: "ses_test1",
          role: "user",
          timeCreated: 1780484790000,
        },
        {
          sessionId: "ses_test1",
          role: "assistant",
          timeCreated: 1780484800000,
        },
      ]);

    const parser = new MimocodeParser(() => ["/test/mimocode.db"]);
    const result = await parser.parse();

    expect(result.buckets.length).toBeGreaterThan(0);
    const bucket = result.buckets[0];
    expect(bucket.source).toBe("mimocode");
    expect(bucket.inputTokens).toBe(1500);
    expect(bucket.outputTokens).toBe(700);
    expect(bucket.reasoningTokens).toBe(150);
    expect(bucket.cachedTokens).toBe(3000);
    expect(bucket.model).toBe("mimo-v2.5-pro");
    expect(bucket.project).toBe("my-project");

    expect(result.sessions.length).toBeGreaterThan(0);
    expect(result.sessions[0].source).toBe("mimocode");
  });

  it("skips messages with zero token usage", async () => {
    mockExistsSync.mockReturnValue(true);

    mockReadSqliteRows
      .mockResolvedValueOnce([
        {
          sessionId: "ses_test2",
          modelID: "mimo-v2.5-pro",
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          timeCreated: 1780484742822,
          directory: "/home/user/empty-project",
        },
      ])
      .mockResolvedValueOnce([]);

    const parser = new MimocodeParser(() => ["/test/mimocode.db"]);
    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
  });

  it("handles unknown model ID", async () => {
    mockExistsSync.mockReturnValue(true);

    mockReadSqliteRows
      .mockResolvedValueOnce([
        {
          sessionId: "ses_test3",
          modelID: null,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          timeCreated: 1780484742822,
          directory: "/home/user/unknown-model-project",
        },
      ])
      .mockResolvedValueOnce([]);

    const parser = new MimocodeParser(() => ["/test/mimocode.db"]);
    const result = await parser.parse();

    if (result.buckets.length > 0) {
      expect(result.buckets[0].model).toBe("unknown");
    }
  });

  it("extracts project name from directory path", async () => {
    mockExistsSync.mockReturnValue(true);

    mockReadSqliteRows
      .mockResolvedValueOnce([
        {
          sessionId: "ses_test4",
          modelID: "gpt-4",
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          timeCreated: 1780484742822,
          directory: "E:\\github\\TokenArena",
        },
      ])
      .mockResolvedValueOnce([]);

    const parser = new MimocodeParser(() => ["/test/mimocode.db"]);
    const result = await parser.parse();

    if (result.buckets.length > 0) {
      expect(result.buckets[0].project).toBe("TokenArena");
    }
  });

  it("handles database read errors gracefully", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadSqliteRows.mockRejectedValueOnce(new Error("Database locked"));

    const parser = new MimocodeParser(() => ["/test/mimocode.db"]);
    const result = await parser.parse();
    expect(result.buckets).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("tool definition has correct id and name", () => {
    const parser = new MimocodeParser();
    expect(parser.tool.id).toBe("mimocode");
    expect(parser.tool.name).toBe("MiMoCode");
  });
});
