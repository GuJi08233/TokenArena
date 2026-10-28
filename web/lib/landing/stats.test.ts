import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw },
}));

import { computeLandingStats } from "./stats";

function sqlText(call: unknown[]) {
  const [query] = call as [{ sql: string; values: unknown[] }];
  return query;
}

describe("computeLandingStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts the aggregate row to plain numbers", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        developers: BigInt(12),
        totalTokens: BigInt(9_876_543_210),
        weekTokens: BigInt(123_456),
        activeSeconds: BigInt(7200),
      },
    ]);

    await expect(computeLandingStats()).resolves.toEqual({
      developers: 12,
      totalTokens: 9_876_543_210,
      weekTokens: 123_456,
      activeSeconds: 7200,
    });
  });

  it("counts public profiles only, with the leaderboard week as the window", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    // Wednesday 2026-10-28, Shanghai time; the board week starts Monday.
    await computeLandingStats(new Date("2026-10-28T04:00:00.000Z"));

    const query = sqlText(mocks.queryRaw.mock.calls[0] ?? []);
    expect(query.sql).toContain(`up."publicProfileEnabled" = true`);
    expect(query.values).toEqual([
      new Date("2026-10-25T16:00:00.000Z"),
      new Date("2026-11-01T16:00:00.000Z"),
    ]);
  });

  it("reports zeros when nothing has been synced", async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(computeLandingStats()).resolves.toEqual({
      developers: 0,
      totalTokens: 0,
      weekTokens: 0,
      activeSeconds: 0,
    });
  });
});
