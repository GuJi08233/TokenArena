import { describe, expect, it } from "vitest";

import { aggregateToBuckets } from "./aggregator";

describe("aggregateToBuckets", () => {
  it("counts cache writes separately and rejects invalid write counts", () => {
    const entry = {
      source: "claude-code",
      model: "claude-sonnet-4",
      project: "cache-test",
      timestamp: new Date("2026-09-21T10:00:00Z"),
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cachedTokens: 200,
      cacheCreationTokens: 30,
    };
    const [bucket] = aggregateToBuckets([
      entry,
      { ...entry, cacheCreationTokens: -1 },
      { ...entry, cacheCreationTokens: Number.NaN },
    ]);
    expect(bucket).toMatchObject({
      inputTokens: 100,
      cachedTokens: 200,
      cacheCreationTokens: 30,
      totalTokens: 380,
    });
  });
  it("includes cached and reasoning tokens in totalTokens", () => {
    const [bucket] = aggregateToBuckets([
      {
        source: "codex",
        model: "gpt-5.4",
        project: "tokenarena",
        timestamp: new Date("2026-03-26T10:00:00.000Z"),
        inputTokens: 100,
        outputTokens: 60,
        cachedTokens: 25,
        cacheCreationTokens: 0,
        reasoningTokens: 10,
      },
    ]);

    expect(bucket.outputTokens).toBe(60);
    expect(bucket.reasoningTokens).toBe(10);
    expect(bucket.totalTokens).toBe(195);
  });

  it("skips malformed entries with negative token counts", () => {
    const [bucket] = aggregateToBuckets([
      {
        source: "codex",
        model: "gpt-5.4",
        project: "tokenarena",
        timestamp: new Date("2026-03-26T10:00:00.000Z"),
        inputTokens: 100,
        outputTokens: 60,
        cachedTokens: 25,
        cacheCreationTokens: 0,
        reasoningTokens: 10,
      },
      {
        source: "codex",
        model: "gpt-5.4",
        project: "tokenarena",
        timestamp: new Date("2026-03-26T10:00:10.000Z"),
        inputTokens: -90,
        outputTokens: 40,
        cachedTokens: 120,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    ]);

    expect(bucket.inputTokens).toBe(100);
    expect(bucket.outputTokens).toBe(60);
    expect(bucket.cachedTokens).toBe(25);
    expect(bucket.reasoningTokens).toBe(10);
    expect(bucket.totalTokens).toBe(195);
  });
});
