import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    leaderboardPeriodResult: { findUnique: vi.fn() },
    leaderboardUserDay: { groupBy: vi.fn() },
    $transaction: vi.fn(),
  },
  tx: {
    leaderboardPeriodResult: { upsert: vi.fn(), update: vi.fn() },
    leaderboardPeriodEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
    achievementAward: { findMany: vi.fn(), createMany: vi.fn() },
    userAchievement: { upsert: vi.fn() },
    userArenaSummary: { updateManyAndReturn: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import {
  buildLeaderboardBadgeAwards,
  finalizePendingLeaderboardPeriods,
  type RankedLeaderboardEntry,
} from "./finalize";

function createEntry(
  overrides: Partial<RankedLeaderboardEntry> &
    Pick<RankedLeaderboardEntry, "userId" | "rank">,
): RankedLeaderboardEntry {
  const { userId, rank, ...rest } = overrides;
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 100,
    activeSeconds: 60,
    sessions: 1,
    userId,
    rank,
    ...rest,
  };
}

describe("buildLeaderboardBadgeAwards", () => {
  it("emits repeatable badge awards for the top 50 users in a finalized weekly window", () => {
    const awards = buildLeaderboardBadgeAwards({
      period: "week",
      windowStart: new Date("2026-03-29T16:00:00.000Z"),
      windowEnd: new Date("2026-04-05T16:00:00.000Z"),
      finalizedAt: new Date("2026-04-05T20:00:00.000Z"),
      entries: [
        createEntry({ userId: "user_1", rank: 1 }),
        createEntry({ userId: "user_2", rank: 50 }),
        createEntry({ userId: "user_3", rank: 51 }),
      ],
    });

    expect(awards).toHaveLength(2);
    expect(awards.map((award) => award.code)).toEqual([
      "leaderboard_week_top50",
      "leaderboard_week_top50",
    ]);
    expect(awards.map((award) => award.userId)).toEqual(["user_1", "user_2"]);
    expect(awards[0]?.dedupeKey).toBe(
      "leaderboard:week:2026-03-29T16:00:00.000Z:user_1:leaderboard_week_top50",
    );
  });

  it("skips all-time snapshots because only day/week/month are settled periodically", () => {
    const awards = buildLeaderboardBadgeAwards({
      period: "all_time",
      windowStart: null,
      windowEnd: null,
      finalizedAt: new Date("2026-04-05T20:00:00.000Z"),
      entries: [createEntry({ userId: "user_1", rank: 1 })],
    });

    expect(awards).toEqual([]);
  });
});

describe("finalizePendingLeaderboardPeriods", () => {
  const now = new Date("2026-04-06T12:00:00.000Z");
  let dayFinalized = false;

  beforeEach(() => {
    vi.clearAllMocks();
    dayFinalized = false;
    mocks.prisma.leaderboardPeriodResult.findUnique.mockImplementation(
      async (query) => ({
        id: "result-1",
        badgesIssuedAt:
          query.where.period_windowStart_windowEnd.period === "day" &&
          !dayFinalized
            ? null
            : now,
      }),
    );
    mocks.prisma.leaderboardUserDay.groupBy.mockResolvedValue([
      {
        userId: "user-1",
        _sum: {
          inputTokens: BigInt(100),
          outputTokens: BigInt(0),
          reasoningTokens: BigInt(0),
          cachedTokens: BigInt(0),
          cacheCreationTokens: BigInt(0),
          totalTokens: BigInt(100),
          activeSeconds: 60,
          sessions: 1,
        },
      },
    ]);
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(mocks.tx),
    );
    mocks.tx.leaderboardPeriodResult.upsert.mockResolvedValue({
      id: "result-1",
    });
    mocks.tx.leaderboardPeriodResult.update.mockImplementation(async () => {
      dayFinalized = true;
    });
    mocks.tx.achievementAward.findMany.mockResolvedValue([]);
    mocks.tx.userArenaSummary.updateManyAndReturn.mockResolvedValue([
      { score: 100 },
    ]);
  });

  it("updates a materialized score and level in the award transaction only once", async () => {
    await finalizePendingLeaderboardPeriods(now);

    expect(mocks.tx.userAchievement.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_code: { userId: "user-1", code: "leaderboard_day_top50" },
        },
      }),
    );
    expect(mocks.tx.userArenaSummary.updateManyAndReturn).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { score: { increment: 10 } },
      select: { score: true },
    });
    expect(mocks.tx.userArenaSummary.update).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { level: 2 },
    });

    await finalizePendingLeaderboardPeriods(now);
    expect(mocks.tx.userArenaSummary.updateManyAndReturn).toHaveBeenCalledTimes(
      1,
    );
  });
});
