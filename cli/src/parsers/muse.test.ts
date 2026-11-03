import { writeFileSync } from "node:fs";
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
      "/tmp/muse-x/token-usage.jsonl",
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

  it("rejects missing ids, bad timestamps and negative counts", () => {
    expect(parseMuseRecord(null)).toBeNull();
    expect(parseMuseRecord({ ts: BASE_TS })).toBeNull();
    expect(
      parseMuseRecord({
        ts: 0,
        messageId: "m",
        sessionId: "s",
        agentId: "a",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toBeNull();
    expect(
      parseMuseRecord({
        ts: BASE_TS,
        messageId: "m",
        sessionId: "s",
        agentId: "a",
        inputTokens: -1,
        outputTokens: 1,
      }),
    ).toBeNull();
  });
});

describe("museRecordsToEntries", () => {
  it("splits growth into fresh input and carried-over cache", () => {
    const entries = museRecordsToEntries([
      record({ messageId: "m1", ts: BASE_TS, inputTokens: 100 }),
      record({ messageId: "m2", ts: BASE_TS + 60, inputTokens: 150 }),
      record({ messageId: "m3", ts: BASE_TS + 120, inputTokens: 140 }),
      record({ messageId: "m4", ts: BASE_TS + 180, inputTokens: 200 }),
    ]);
    expect(entries.map((e) => e.inputTokens)).toEqual([100, 50, 140, 60]);
    expect(entries.map((e) => e.cachedTokens)).toEqual([0, 100, 0, 140]);
    // Conservation: fresh + cached always reproduces the reported input.
    expect(
      entries.reduce((sum, e) => sum + e.inputTokens + e.cachedTokens, 0),
    ).toBe(100 + 150 + 140 + 200);
    expect(entries.every((e) => e.reasoningTokens === 0)).toBe(true);
    expect(entries.every((e) => e.cacheCreationTokens === 0)).toBe(true);
  });

  it("tracks sequences per agent independently", () => {
    const entries = museRecordsToEntries([
      record({ messageId: "m1", agentId: "a1", ts: BASE_TS, inputTokens: 100 }),
      record({ messageId: "m2", agentId: "a2", ts: BASE_TS, inputTokens: 40 }),
      record({
        messageId: "m3",
        agentId: "a1",
        ts: BASE_TS + 60,
        inputTokens: 130,
      }),
      record({
        messageId: "m4",
        agentId: "a2",
        ts: BASE_TS + 60,
        inputTokens: 45,
      }),
    ]);
    const byId = new Map(
      entries.map((e) => [
        `${e.timestamp.getTime()}-${e.inputTokens}`,
        e.cachedTokens,
      ]),
    );
    expect(byId.size).toBe(4);
    const a2Second = entries.find(
      (e) =>
        e.timestamp.getTime() === (BASE_TS + 60) * 1000 &&
        e.cachedTokens === 40,
    );
    expect(a2Second?.inputTokens).toBe(5);
  });

  it("keeps the first of duplicate message ids and sorts by time", () => {
    const entries = museRecordsToEntries([
      record({ messageId: "m2", ts: BASE_TS + 60, inputTokens: 150 }),
      record({ messageId: "m1", ts: BASE_TS, inputTokens: 100 }),
      record({ messageId: "m2", ts: BASE_TS + 60, inputTokens: 999 }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.inputTokens)).toEqual([100, 50]);
  });

  it("falls back to the default model and stamps source and project", () => {
    const [entry] = museRecordsToEntries([record({})]);
    expect(entry?.model).toBe("muse-spark");
    expect(entry?.source).toBe("muse");
    expect(entry?.project).toBe("Muse");
    expect(entry?.sessionId).toBe("s1");
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
    expect(bucket?.inputTokens).toBe(160); // 100 fresh + 60 growth
    expect(bucket?.cachedTokens).toBe(100);
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
    ]);
    const result = await new MuseParser({ filePath }).parse();
    expect(result.partial).toBe(true);
    expect(result.buckets).toHaveLength(1);
    expect(result.sessions).toHaveLength(1);
  });
});
