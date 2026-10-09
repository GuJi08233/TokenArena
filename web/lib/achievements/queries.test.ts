import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settlePendingLeaderboardPeriods: vi.fn().mockResolvedValue(undefined),
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
    achievementAward: { createMany: vi.fn() },
    userAchievement: { findMany: vi.fn(), findFirst: vi.fn() },
    userArenaSummary: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
  tx: {
    $executeRaw: vi.fn(),
    achievementAward: { createMany: vi.fn() },
    userAchievement: { findMany: vi.fn() },
    userArenaSummary: { upsert: vi.fn() },
  },
}));

vi.mock("@/lib/leaderboard/finalize", () => ({
  settlePendingLeaderboardPeriods: mocks.settlePendingLeaderboardPeriods,
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

import {
  getAchievementNotificationData,
  getAchievementsPageData,
  getArenaSummaryForProfile,
  synchronizeAchievementsForUser,
  synchronizeAchievementsInBackground,
} from "./queries";

function expectReadOnlyProfile() {
  expect(mocks.prisma.usageBucket.findMany).not.toHaveBeenCalled();
  expect(mocks.prisma.usageSession.findMany).not.toHaveBeenCalled();
  expect(mocks.prisma.follow.findMany).not.toHaveBeenCalled();
  expect(
    mocks.getUserGlobalLeaderboardRanksByTotalTokens,
  ).not.toHaveBeenCalled();
  expect(mocks.settlePendingLeaderboardPeriods).not.toHaveBeenCalled();
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

const FIRST_SYNC_AT = new Date("2026-04-01T12:00:00.000Z");

function storedRow(
  code: string,
  awardCount: number,
  state: unknown = null,
): {
  code: string;
  awardCount: number;
  firstAwardedAt: Date | null;
  lastAwardedAt: Date | null;
  state: unknown;
} {
  return {
    code,
    awardCount,
    firstAwardedAt: FIRST_SYNC_AT,
    lastAwardedAt: FIRST_SYNC_AT,
    state,
  };
}

/** Every value bound into one raw statement, flattened. */
function boundValues(call: unknown[]): unknown[] {
  return (call[0] as { values: unknown[] }).values;
}

function rawStatements() {
  return mocks.tx.$executeRaw.mock.calls.map((call) => ({
    sql: (call[0] as { sql: string }).sql,
    values: boundValues(call),
  }));
}

describe("achievement synchronization", () => {
  let storedRows: ReturnType<typeof storedRow>[];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function useUsage(totalTokens: number) {
    mocks.prisma.usageBucket.findMany.mockResolvedValue([
      {
        bucketStart: FIRST_SYNC_AT,
        totalTokens: BigInt(totalTokens),
        inputTokens: BigInt(totalTokens),
        outputTokens: BigInt(0),
        reasoningTokens: BigInt(0),
        cachedTokens: BigInt(0),
        cacheCreationTokens: BigInt(0),
        model: "gpt-5.4",
        source: "codex",
        projectKey: "project-a",
        deviceId: "device-1",
      },
    ]);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    storedRows = [];
    mocks.settlePendingLeaderboardPeriods.mockResolvedValue(undefined);
    mocks.getUserGlobalLeaderboardRanksByTotalTokens.mockResolvedValue({
      day: null,
      week: null,
      month: null,
      all_time: null,
    });
    mocks.getPricingCatalog.mockResolvedValue(null);
    mocks.getUsagePreference.mockResolvedValue({ timezone: "UTC" });
    mocks.prisma.user.findUniqueOrThrow.mockResolvedValue({
      usagePreference: { publicProfileEnabled: false, updatedAt: null },
    });
    useUsage(1_500);
    mocks.prisma.usageSession.findMany.mockResolvedValue([]);
    mocks.prisma.follow.findMany.mockResolvedValue([]);
    mocks.prisma.userAchievement.findMany.mockImplementation(
      async () => storedRows,
    );
    mocks.tx.userAchievement.findMany.mockImplementation(
      async () => storedRows,
    );
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(mocks.tx),
    );
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("takes the user's lock before reading the counts it rewrites", async () => {
    await synchronizeAchievementsForUser("user-1", "ingest");

    const [lock] = rawStatements();
    expect(lock?.sql).toContain("pg_advisory_xact_lock");
    expect(lock?.values).toEqual([1, "user-1"]);
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tx.userAchievement.findMany.mock.invocationCallOrder[0],
    );
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 5_000 },
    );
  });

  it("writes only the counts a pass changed, never the leaderboard badges", async () => {
    storedRows = [storedRow("leaderboard_day_top50", 3)];

    await synchronizeAchievementsForUser("user-1", "ingest");

    const statements = rawStatements();
    expect(statements).toHaveLength(2);
    const upsert = statements[1];
    expect(upsert?.sql).toContain('INSERT INTO "user_achievement"');
    expect(upsert?.values).toContain("first_sync");
    // A finalization can increment this count at any moment; writing back the
    // value read here used to undo it.
    expect(upsert?.values).not.toContain("leaderboard_day_top50");
  });

  it("skips the count write when a pass changes nothing", async () => {
    storedRows = [storedRow("first_sync", 1)];

    await synchronizeAchievementsForUser("user-1", "ingest");

    expect(rawStatements()).toHaveLength(1);
    expect(mocks.prisma.achievementAward.createMany).not.toHaveBeenCalled();
    expect(mocks.tx.userArenaSummary.upsert).toHaveBeenCalledOnce();
  });

  it("stamps the summary with the time the counts were written", async () => {
    await synchronizeAchievementsForUser("user-1", "ingest");

    const upsert = rawStatements()[1];
    const [summaryWrite] = mocks.tx.userArenaSummary.upsert.mock.calls[0] ?? [];
    // Equal timestamps tell a profile view the stored score is current.
    expect(upsert?.values).toContain(
      summaryWrite.update.computedAt.toISOString(),
    );
  });

  it("writes a long backlog of awards in chunks outside the transaction", async () => {
    // 2,500 steps of the 10M-token achievement, plus its larger siblings.
    useUsage(25_000_000_000);

    await synchronizeAchievementsForUser("user-1", "ingest");

    const chunks: Array<{
      data: Array<{ code: string }>;
      skipDuplicates: boolean;
    }> = mocks.prisma.achievementAward.createMany.mock.calls.map(
      ([input]) => input,
    );
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.data.length).toBeLessThanOrEqual(1_000);
      expect(chunk.skipDuplicates).toBe(true);
    }
    expect(
      chunks.reduce(
        (count, chunk) =>
          count +
          chunk.data.filter((award) => award.code === "tokens_100k").length,
        0,
      ),
    ).toBe(2_500);
    // The transaction only adds awards that became due after the draft.
    expect(mocks.tx.achievementAward.createMany).not.toHaveBeenCalled();
  });

  it("adds awards that became due between the draft and the lock", async () => {
    // The draft saw `first_sync` as already awarded; under the lock it is not.
    mocks.prisma.userAchievement.findMany.mockResolvedValueOnce([
      storedRow("first_sync", 1),
    ]);

    await synchronizeAchievementsForUser("user-1", "ingest");

    expect(mocks.tx.achievementAward.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ code: "first_sync" })],
      skipDuplicates: true,
    });
  });

  it("bounds the transaction with TRANSACTION_TIMEOUT", async () => {
    vi.stubEnv("TRANSACTION_TIMEOUT", "30000");

    await synchronizeAchievementsForUser("user-1", "ingest");

    expect(mocks.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 30_000 },
    );
  });

  it("shows stored awards when the page's award pass fails", async () => {
    storedRows = [storedRow("first_sync", 1)];
    mocks.prisma.$transaction.mockRejectedValue(
      new Error("Transaction already closed"),
    );

    const page = await getAchievementsPageData("user-1");

    expect(page.summary.unlockedCount).toBe(1);
    expect(page.summary.score).toBe(10);
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to synchronize achievements for a page view",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("shows stored awards in the notification when the award pass fails", async () => {
    storedRows = [storedRow("first_sync", 1)];
    mocks.prisma.$transaction.mockRejectedValue(new Error("P2028"));

    const notification = await getAchievementNotificationData("user-1");

    expect(notification.score).toBe(10);
    expect(notification.unlockedCount).toBe(1);
  });
});

describe("synchronizeAchievementsInBackground", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getUsagePreference.mockResolvedValue({ timezone: "UTC" });
    mocks.getUserGlobalLeaderboardRanksByTotalTokens.mockResolvedValue({
      day: null,
      week: null,
      month: null,
      all_time: null,
    });
    mocks.prisma.user.findUniqueOrThrow.mockResolvedValue({
      usagePreference: { publicProfileEnabled: false, updatedAt: null },
    });
    mocks.prisma.usageBucket.findMany.mockResolvedValue([]);
    mocks.prisma.usageSession.findMany.mockResolvedValue([]);
    mocks.prisma.follow.findMany.mockResolvedValue([]);
    mocks.prisma.userAchievement.findMany.mockResolvedValue([]);
    mocks.tx.userAchievement.findMany.mockResolvedValue([]);
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(mocks.tx),
    );
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("logs a failed pass instead of rejecting", async () => {
    mocks.settlePendingLeaderboardPeriods.mockResolvedValue(undefined);
    mocks.prisma.$transaction.mockRejectedValue(new Error("P2028"));

    await expect(
      synchronizeAchievementsInBackground("user-1", "ingest"),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to synchronize achievements",
      expect.objectContaining({ userId: "user-1", source: "ingest" }),
    );
  });

  it("folds calls made during a pass into a single later pass", async () => {
    let releaseFirstPass!: () => void;
    mocks.settlePendingLeaderboardPeriods
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const first = synchronizeAchievementsInBackground("user-1", "ingest");
    const second = synchronizeAchievementsInBackground("user-1", "social");
    const third = synchronizeAchievementsInBackground("user-1", "social");

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mocks.settlePendingLeaderboardPeriods).toHaveBeenCalledOnce();

    releaseFirstPass();
    await first;

    // One pass for the first call and one more for everything after it.
    expect(mocks.settlePendingLeaderboardPeriods).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(
      mocks.tx.userArenaSummary.upsert.mock.calls.map(
        ([input]) => input.where.userId,
      ),
    ).toEqual(["user-1", "user-1"]);
  });

  it("runs separate users independently", async () => {
    mocks.settlePendingLeaderboardPeriods.mockResolvedValue(undefined);

    const first = synchronizeAchievementsInBackground("user-1", "social");
    const second = synchronizeAchievementsInBackground("user-2", "social");

    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
