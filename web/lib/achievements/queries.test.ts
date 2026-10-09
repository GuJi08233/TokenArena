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

function expectReadOnlyProfile() {
  expect(mocks.prisma.usageBucket.findMany).not.toHaveBeenCalled();
  expect(mocks.prisma.usageSession.findMany).not.toHaveBeenCalled();
  expect(mocks.prisma.follow.findMany).not.toHaveBeenCalled();
  expect(
    mocks.getUserGlobalLeaderboardRanksByTotalTokens,
  ).not.toHaveBeenCalled();
  expect(mocks.finalizePendingLeaderboardPeriods).not.toHaveBeenCalled();
  expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  expect(mocks.prisma.userArenaSummary.upsert).not.toHaveBeenCalled();
  expect(mocks.prisma.userArenaSummary.update).not.toHaveBeenCalled();
}

describe("getArenaSummaryForProfile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prisma.userAchievement.findFirst.mockResolvedValue(null);
    mocks.prisma.userAchievement.findMany.mockResolvedValue([]);
    // Profiles must work even when the full synchronization would time out.
    mocks.prisma.$transaction.mockRejectedValue(new Error("P2028"));
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
      totalActiveDays: 30,
    });
    expect(mocks.prisma.userAchievement.findMany).not.toHaveBeenCalled();
    expectReadOnlyProfile();
  });

  it("reads an updated score without overwriting a concurrent synchronization", async () => {
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
    expect(summary.totalActiveDays).toBe(30);
    expectReadOnlyProfile();
  });

  it("reads large award counts without rebuilding a missing summary on repeated views", async () => {
    mocks.prisma.userArenaSummary.findUnique.mockResolvedValue(null);
    mocks.prisma.userAchievement.findMany.mockResolvedValue([
      { code: "leaderboard_day_top50", awardCount: 14_046 },
      { code: "unknown_achievement", awardCount: 10_640 },
    ]);

    for (let view = 0; view < 2; view += 1) {
      expect(await getArenaSummaryForProfile("user-1")).toEqual({
        score: 140_460,
        level: 10,
        totalActiveDays: null,
      });
    }

    expect(mocks.prisma.userAchievement.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      select: { code: true, awardCount: true },
    });
    expect(mocks.prisma.userAchievement.findFirst).not.toHaveBeenCalled();
    expectReadOnlyProfile();
  });

  it("returns the initial level when no achievements have been awarded", async () => {
    mocks.prisma.userArenaSummary.findUnique.mockResolvedValue(null);

    expect(await getArenaSummaryForProfile("user-1")).toEqual({
      score: 0,
      level: 1,
      totalActiveDays: null,
    });
    expectReadOnlyProfile();
  });
});
