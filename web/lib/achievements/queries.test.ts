import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finalizePendingLeaderboardPeriods: vi.fn().mockResolvedValue(undefined),
  getUserGlobalLeaderboardRanksByTotalTokens: vi.fn().mockResolvedValue({
    day: null,
    week: null,
    month: null,
    all_time: null,
  }),
  getPricingCatalog: vi.fn().mockResolvedValue(null),
  getUsagePreference: vi.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }),
  prisma: {
    $transaction: vi.fn(),
    user: { findUniqueOrThrow: vi.fn() },
    usageBucket: { findMany: vi.fn() },
    usageSession: { findMany: vi.fn() },
    follow: { findMany: vi.fn() },
    userAchievement: { findMany: vi.fn(), findFirst: vi.fn() },
    userArenaSummary: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/leaderboard/finalize", () => ({
  finalizePendingLeaderboardPeriods: mocks.finalizePendingLeaderboardPeriods,
}));
vi.mock("@/lib/leaderboard/rank", () => ({
  getUserGlobalLeaderboardRanksByTotalTokens:
    mocks.getUserGlobalLeaderboardRanksByTotalTokens,
}));
vi.mock("@/lib/pricing/catalog", () => ({
  getPricingCatalog: mocks.getPricingCatalog,
}));
vi.mock("@/lib/usage/preferences", () => ({
  getUsagePreference: mocks.getUsagePreference,
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { getArenaSummaryForProfile } from "./queries";

/** Wire up the mocks an all-time recompute walks through, all empty. */
function stubEmptyHistory() {
  mocks.prisma.user.findUniqueOrThrow.mockResolvedValue({
    usagePreference: { publicProfileEnabled: true, updatedAt: new Date() },
  });
  mocks.prisma.usageBucket.findMany.mockResolvedValue([]);
  mocks.prisma.usageSession.findMany.mockResolvedValue([]);
  mocks.prisma.follow.findMany.mockResolvedValue([]);
  mocks.prisma.userAchievement.findMany.mockResolvedValue([]);
  mocks.prisma.$transaction.mockImplementation(async (callback) =>
    callback({
      achievementAward: { createMany: vi.fn().mockResolvedValue({}) },
      userAchievement: { upsert: vi.fn().mockResolvedValue({}) },
    }),
  );
  mocks.prisma.userArenaSummary.upsert.mockResolvedValue({});
}

describe("getArenaSummaryForProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.userAchievement.findFirst.mockResolvedValue(null);
    mocks.getUsagePreference.mockResolvedValue({ timezone: "Asia/Shanghai" });
    mocks.getPricingCatalog.mockResolvedValue(null);
    mocks.getUserGlobalLeaderboardRanksByTotalTokens.mockResolvedValue({
      day: null,
      week: null,
      month: null,
      all_time: null,
    });
  });

  it("serves the materialized row without replaying usage history", async () => {
    mocks.prisma.userArenaSummary.findUnique.mockResolvedValue({
      userId: "user-1",
      score: 420,
      level: 7,
      totalTokens: BigInt(9_000),
      totalEstimatedCostUsd: 12.5,
      totalActiveSeconds: 3_600,
      totalSessions: 42,
      totalActiveDays: 30,
      computedAt: new Date("2026-04-05T12:00:00.000Z"),
    });

    const summary = await getArenaSummaryForProfile("user-1");

    expect(summary).toEqual({
      score: 420,
      level: 7,
      totalTokens: 9_000,
      totalEstimatedCostUsd: 12.5,
      totalActiveSeconds: 3_600,
      totalSessions: 42,
      totalActiveDays: 30,
    });
    // The whole point of the table: none of the expensive work runs.
    expect(mocks.prisma.usageBucket.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.usageSession.findMany).not.toHaveBeenCalled();
    expect(
      mocks.getUserGlobalLeaderboardRanksByTotalTokens,
    ).not.toHaveBeenCalled();
    expect(mocks.finalizePendingLeaderboardPeriods).not.toHaveBeenCalled();
    expect(mocks.prisma.userArenaSummary.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.userArenaSummary.update).not.toHaveBeenCalled();
  });

  it("repairs an older score from stored achievements without replaying usage", async () => {
    const computedAt = new Date("2026-04-05T12:00:00.000Z");
    const updatedAt = new Date("2026-04-06T12:00:00.000Z");
    mocks.prisma.userArenaSummary.findUnique.mockResolvedValue({
      userId: "user-1",
      score: 90,
      level: 1,
      totalTokens: BigInt(9_000),
      totalEstimatedCostUsd: 12.5,
      totalActiveSeconds: 3_600,
      totalSessions: 42,
      totalActiveDays: 30,
      computedAt,
    });
    mocks.prisma.userAchievement.findFirst.mockResolvedValue({
      code: "leaderboard_day_top50",
    });
    mocks.prisma.userAchievement.findMany.mockResolvedValue([
      { code: "leaderboard_day_top50", awardCount: 10, updatedAt },
    ]);

    const summary = await getArenaSummaryForProfile("user-1");

    expect(summary.score).toBe(100);
    expect(summary.level).toBe(2);
    expect(mocks.prisma.userArenaSummary.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { score: 100, level: 2, computedAt: updatedAt },
    });
    expect(mocks.prisma.usageBucket.findMany).not.toHaveBeenCalled();
    expect(mocks.prisma.usageSession.findMany).not.toHaveBeenCalled();
    expect(
      mocks.getUserGlobalLeaderboardRanksByTotalTokens,
    ).not.toHaveBeenCalled();
  });

  it("recomputes and persists once when no row exists yet", async () => {
    mocks.prisma.userArenaSummary.findUnique.mockResolvedValue(null);
    stubEmptyHistory();

    const summary = await getArenaSummaryForProfile("user-1");

    expect(summary.score).toBe(0);
    expect(mocks.prisma.usageBucket.findMany).toHaveBeenCalled();
    expect(mocks.prisma.userArenaSummary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });
});
