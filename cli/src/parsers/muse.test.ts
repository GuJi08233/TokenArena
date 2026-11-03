import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import {
  getMuseExportPath,
  MuseParser,
  type MuseUsageRecord,
  museRecordsToEntries,
  parseMuseRecord,
} from "./muse";

const makeTempDir = useTempDirs();

const BASE_TS = 1_793_000_000; // 2026-10-27, arbitrary fixed point

function record(overrides: Partial<MuseUsageRecord> = {}): MuseUsageRecord {
  return {
    ts: BASE_TS,
    messageId: "m1",
    sessionId: "s1",
    agentId: "a1",
    inputTokens: 100,
    outputTokens: 10,
    ...overrides,
  };
}

function writeExport(dir: string, lines: unknown[]): string {
  const filePath = join(dir, "token-usage.jsonl");
  writeFileSync(
    filePath,
    lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n"),
  );
  return filePath;
}

describe("getMuseExportPath", () => {
  it("honours the MUSE_USAGE_DIR override", () => {
    expect(getMuseExportPath({ MUSE_USAGE_DIR: "/tmp/muse-x" })).toBe(
      join("/tmp/muse-x", "token-usage.jsonl"),
    );
  });

  it("falls back to the default share directory", () => {
    expect(getMuseExportPath({})).toMatch(
      /\.local[/\\]share[/\\]muse[/\\]token-usage\.jsonl$/,
    );
  });
});

describe("parseMuseRecord", () => {
  it("accepts a well-formed record and trims the model", () => {
    expect(
      parseMuseRecord({
        ts: BASE_TS,
        messageId: "m1",
        sessionId: "s1",
        agentId: "a1",
        model: " muse-spark ",
        inputTokens: 5,
        outputTokens: 2,
      }),
    ).toEqual({
      ts: BASE_TS,
      messageId: "m1",
      sessionId: "s1",
      agentId: "a1",
      model: "muse-spark",
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  it("rejects records whose ids are missing or empty", () => {
    const base = { ts: BASE_TS, inputTokens: 1, outputTokens: 1 };
    expect(parseMuseRecord({ ...base })).toBeNull();
    expect(
      parseMuseRecord({ ...base, messageId: "", sessionId: "s", agentId: "a" }),
    ).toBeNull();
    expect(
      parseMuseRecord({ ...base, messageId: "m", sessionId: "s" }),
    ).toBeNull();
  });

  it("rejects non-number and negative token counts", () => {
    const base = {
      ts: BASE_TS,
      messageId: "m",
      sessionId: "s",
      agentId: "a",
      outputTokens: 1,
    };
    expect(parseMuseRecord({ ...base, inputTokens: null })).toBeNull();
    expect(parseMuseRecord({ ...base, inputTokens: true })).toBeNull();
    expect(parseMuseRecord({ ...base, inputTokens: "100" })).toBeNull();
    expect(parseMuseRecord({ ...base, inputTokens: -1 })).toBeNull();
    expect(parseMuseRecord({ ...base, inputTokens: 1.5 })).toBeNull();
  });

  it("rejects timestamps outside the accepted range", () => {
    const base = {
      messageId: "m",
      sessionId: "s",
      agentId: "a",
      inputTokens: 1,
      outputTokens: 1,
    };
    // Millisecond and microsecond units, pre-2020, far future, non-number.
    expect(parseMuseRecord({ ...base, ts: BASE_TS * 1000 })).toBeNull();
    expect(parseMuseRecord({ ...base, ts: BASE_TS * 1_000_000 })).toBeNull();
    expect(parseMuseRecord({ ...base, ts: 1_500_000_000 })).toBeNull();
    expect(parseMuseRecord({ ...base, ts: true })).toBeNull();
    expect(parseMuseRecord({ ...base, ts: "now" })).toBeNull();
  });
});

describe("museRecordsToEntries", () => {
  it("stores the reported full prompt as input, with no fabricated cache", () => {
    const entries = museRecordsToEntries([
      record({
        messageId: "m1",
        ts: BASE_TS,
        inputTokens: 100,
        outputTokens: 10,
      }),
      record({
        messageId: "m2",
        ts: BASE_TS + 60,
        inputTokens: 150,
        outputTokens: 12,
      }),
    ]);
    expect(entries.map((e) => e.inputTokens)).toEqual([100, 150]);
    expect(entries.map((e) => e.outputTokens)).toEqual([10, 12]);
    expect(entries.every((e) => e.cachedTokens === 0)).toBe(true);
    expect(entries.every((e) => e.reasoningTokens === 0)).toBe(true);
    expect(entries.every((e) => e.cacheCreationTokens === 0)).toBe(true);
  });

  it("dedupes by session and message, keeping the first record", () => {
    const entries = museRecordsToEntries([
      record({ messageId: "m1", sessionId: "s1", inputTokens: 100 }),
      record({ messageId: "m1", sessionId: "s1", inputTokens: 999 }),
      record({ messageId: "m1", sessionId: "s2", inputTokens: 40 }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.inputTokens)).toEqual([100, 40]);
  });

  it("does not conflate ids that only differ across the session/message boundary", () => {
    const entries = museRecordsToEntries([
      record({ sessionId: "ab", messageId: "c", inputTokens: 1 }),
      record({ sessionId: "a", messageId: "bc", inputTokens: 2 }),
    ]);
    expect(entries.map((e) => e.inputTokens)).toEqual([1, 2]);
  });

  it("normalizes internal model ids and falls back to the default model", () => {
    const [leaked, kept, missing] = museRecordsToEntries([
      record({ messageId: "m1", model: "ipnext/avocado-5.17-v1" }),
      record({ messageId: "m2", model: "muse-spark-2" }),
      record({ messageId: "m3" }),
    ]);
    expect(leaked?.model).toBe("muse-spark");
    expect(kept?.model).toBe("muse-spark-2");
    expect(missing?.model).toBe("muse-spark");
  });

  it("stamps source, project and session on every entry", () => {
    const [entry] = museRecordsToEntries([record({})]);
    expect(entry?.source).toBe("muse");
    expect(entry?.project).toBe("Muse");
    expect(entry?.sessionId).toBe("s1");
    expect(entry?.timestamp.getTime()).toBe(BASE_TS * 1000);
  });
});

describe("MuseParser", () => {
  it("is not installed and parses empty without an export file", async () => {
    const parser = new MuseParser({
      filePath: join(makeTempDir(), "token-usage.jsonl"),
    });
    expect(parser.isInstalled()).toBe(false);
    expect(parser.listSourceFiles()).toEqual([]);
    await expect(parser.parse()).resolves.toEqual({
      buckets: [],
      sessions: [],
    });
  });

  it("reports incomplete when the export path exists but cannot be read", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "token-usage.jsonl");
    mkdirSync(filePath); // A directory: exists, but readFileSync fails.
    const parser = new MuseParser({ filePath });
    expect(parser.isInstalled()).toBe(true);
    await expect(parser.parse()).resolves.toEqual({
      buckets: [],
      sessions: [],
      incomplete: true,
    });
  });

  it("aggregates buckets and sessions from a real export", async () => {
    const dir = makeTempDir();
    const filePath = writeExport(dir, [
      record({
        messageId: "m1",
        ts: BASE_TS,
        inputTokens: 100,
        outputTokens: 10,
      }),
      record({
        messageId: "m2",
        ts: BASE_TS + 120,
        inputTokens: 160,
        outputTokens: 20,
      }),
    ]);
    const parser = new MuseParser({ filePath });
    expect(parser.isInstalled()).toBe(true);
    expect(parser.listSourceFiles()).toEqual([filePath]);

    const result = await parser.parse();
    expect(result.partial).toBeUndefined();
    expect(result.buckets).toHaveLength(1);
    const bucket = result.buckets[0];
    expect(bucket?.source).toBe("muse");
    expect(bucket?.inputTokens).toBe(260);
    expect(bucket?.cachedTokens).toBe(0);
    expect(bucket?.outputTokens).toBe(30);
    expect(bucket?.totalTokens).toBe(290);

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session?.messageCount).toBe(2);
    expect(session?.userMessageCount).toBe(0);
    expect(session?.totalTokens).toBe(290);
    expect(session?.primaryModel).toBe("muse-spark");
  });

  it("flags partial when a line cannot be used, keeping the rest", async () => {
    const dir = makeTempDir();
    const filePath = writeExport(dir, [
      record({ messageId: "m1" }),
      "{not json",
      { ts: "nope" },
      // A millisecond timestamp is malformed, not a far-future bucket.
      record({ messageId: "m2", ts: BASE_TS * 1000 }),
      // A null count is malformed, not zero.
      {
        ts: BASE_TS,
        messageId: "m3",
        sessionId: "s1",
        agentId: "a1",
        inputTokens: null,
        outputTokens: 5,
      },
    ]);
    const result = await new MuseParser({ filePath }).parse();
    expect(result.partial).toBe(true);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.inputTokens).toBe(100);
    expect(result.sessions).toHaveLength(1);
  });
});
