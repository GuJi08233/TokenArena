import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    leaderboardPeriodResult: { findMany: vi.fn() },
    leaderboardUserDay: { groupBy: vi.fn() },
    $transaction: vi.fn(),
  },
  tx: {
    $executeRaw: vi.fn(),
    leaderboardPeriodResult: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    leaderboardPeriodEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
    achievementAward: { findMany: vi.fn(), createMany: vi.fn() },
    userArenaSummary: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import {
  buildLeaderboardBadgeAwards,
  finalizePendingLeaderboardPeriods,
  type RankedLeaderboardEntry,
  settlePendingLeaderboardPeriods,
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
  // Monday 20:00 in Shanghai: the latest finished day began 2026-04-05 00:00.
  const now = new Date("2026-04-06T12:00:00.000Z");
  const latestDayStart = new Date("2026-04-04T16:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  let missingDayStarts: Set<number>;

  function rawStatements() {
    return mocks.tx.$executeRaw.mock.calls.map(([statement]) => ({
      sql: (statement as { sql: string }).sql,
      values: (statement as { values: unknown[] }).values,
    }));
  }

  function upsertedWindowStarts() {
    return mocks.tx.leaderboardPeriodResult.upsert.mock.calls.map(([input]) =>
      input.create.windowStart.toISOString(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    missingDayStarts = new Set([latestDayStart.getTime()]);
    // Every week and month window is issued; day windows in the set are not.
    mocks.prisma.leaderboardPeriodResult.findMany.mockImplementation(
      async ({ where }) =>
        where.windowStart.in.flatMap((windowStart: Date) =>
          where.period === "day" && missingDayStarts.has(windowStart.getTime())
            ? []
            : [{ windowStart }],
        ),
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
    mocks.tx.leaderboardPeriodResult.findUnique.mockResolvedValue(null);
    mocks.tx.leaderboardPeriodResult.upsert.mockImplementation(
      async ({ create }) => ({ id: `result-${create.windowStart.getTime()}` }),
    );
    mocks.tx.achievementAward.findMany.mockResolvedValue([]);
    mocks.tx.userArenaSummary.findMany.mockResolvedValue([
      { userId: "user-1", score: 95 },
    ]);
  });

  it("issues a finished day under its window lock and the winners' locks", async () => {
    await finalizePendingLeaderboardPeriods(now);

    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 5_000 },
    );
    const [windowLock, userLock, counts, summary] = rawStatements();
    expect(windowLock?.values).toEqual([2, "day:2026-04-04T16:00:00.000Z"]);
    expect(userLock?.values).toEqual([1, "user-1"]);
    // The issued check runs inside the window lock, and the winners' counts
    // are only written once their locks are held.
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    expect(order(mocks.tx.$executeRaw)).toBeLessThan(
      order(mocks.tx.leaderboardPeriodResult.findUnique),
    );
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      order(mocks.tx.leaderboardPeriodResult.upsert),
    );

    expect(counts?.sql).toContain('"awardCount" + EXCLUDED."awardCount"');
    expect(counts?.values).toEqual(
      expect.arrayContaining(["user-1", "leaderboard_day_top50", 1]),
    );
    // 95 + 10 crosses the 100-point threshold of level 2.
    expect(summary?.sql).toContain('UPDATE "user_arena_summary"');
    expect(summary?.values).toEqual(expect.arrayContaining(["user-1", 105, 2]));
    expect(mocks.tx.leaderboardPeriodResult.update).toHaveBeenCalledWith({
      where: { id: `result-${latestDayStart.getTime()}` },
      data: { badgesIssuedAt: now },
    });
  });

  it("stops when another pass issued the window first", async () => {
    mocks.tx.leaderboardPeriodResult.findUnique.mockResolvedValue({
      badgesIssuedAt: now,
    });

    await finalizePendingLeaderboardPeriods(now);

    expect(rawStatements()).toHaveLength(1);
    expect(mocks.tx.leaderboardPeriodResult.upsert).not.toHaveBeenCalled();
    expect(mocks.tx.achievementAward.createMany).not.toHaveBeenCalled();
    expect(mocks.tx.leaderboardPeriodResult.update).not.toHaveBeenCalled();
  });

  it("issues the days a failed pass missed, oldest first", async () => {
    missingDayStarts = new Set(
      Array.from(
        { length: 7 },
        (_, index) => latestDayStart.getTime() - index * DAY_MS,
      ),
    );

    await finalizePendingLeaderboardPeriods(now);

    expect(upsertedWindowStarts()).toEqual([
      "2026-03-29T16:00:00.000Z",
      "2026-03-30T16:00:00.000Z",
      "2026-03-31T16:00:00.000Z",
      "2026-04-01T16:00:00.000Z",
      "2026-04-02T16:00:00.000Z",
      "2026-04-03T16:00:00.000Z",
      "2026-04-04T16:00:00.000Z",
    ]);
  });

  it("keeps issuing other windows after one fails, then reports it", async () => {
    missingDayStarts = new Set([
      latestDayStart.getTime() - DAY_MS,
      latestDayStart.getTime(),
    ]);
    const failure = new Error("Transaction already closed");
    mocks.prisma.$transaction.mockRejectedValueOnce(failure);

    await expect(finalizePendingLeaderboardPeriods(now)).rejects.toBe(failure);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(upsertedWindowStarts()).toEqual(["2026-04-04T16:00:00.000Z"]);
  });

  it("leaves winners without a summary to the profile fallback", async () => {
    mocks.tx.userArenaSummary.findMany.mockResolvedValue([]);

    await finalizePendingLeaderboardPeriods(now);

    expect(
      rawStatements().some((statement) =>
        statement.sql.includes("user_arena_summary"),
      ),
    ).toBe(false);
  });

  it("issues nothing again for an award that already exists", async () => {
    mocks.tx.achievementAward.findMany.mockResolvedValue([
      {
        dedupeKey:
          "leaderboard:day:2026-04-04T16:00:00.000Z:user-1:leaderboard_day_top50",
      },
    ]);

    await finalizePendingLeaderboardPeriods(now);

    expect(mocks.tx.achievementAward.createMany).not.toHaveBeenCalled();
    expect(rawStatements()).toHaveLength(2);
    expect(mocks.tx.leaderboardPeriodResult.update).toHaveBeenCalledOnce();
  });
});

describe("settlePendingLeaderboardPeriods", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs a failed pass instead of failing the caller", async () => {
    mocks.prisma.leaderboardPeriodResult.findMany.mockRejectedValue(
      new Error("connection reset"),
    );

    await expect(settlePendingLeaderboardPeriods()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to finalize leaderboard periods",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("shares one pass between concurrent callers", async () => {
    let release!: () => void;
    mocks.prisma.leaderboardPeriodResult.findMany.mockImplementation(
      ({ where }) =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              where.windowStart.in.map((windowStart: Date) => ({
                windowStart,
              })),
            );
        }),
    );

    const first = settlePendingLeaderboardPeriods();
    const second = settlePendingLeaderboardPeriods();

    expect(second).toBe(first);
    expect(
      mocks.prisma.leaderboardPeriodResult.findMany,
    ).toHaveBeenCalledOnce();

    mocks.prisma.leaderboardPeriodResult.findMany.mockImplementation(
      async ({ where }) =>
        where.windowStart.in.map((windowStart: Date) => ({ windowStart })),
    );
    release();
    await first;

    // A later call starts a fresh pass.
    await settlePendingLeaderboardPeriods();
    expect(
      mocks.prisma.leaderboardPeriodResult.findMany.mock.calls.length,
    ).toBeGreaterThan(1);
  });
});
