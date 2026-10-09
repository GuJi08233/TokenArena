import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Achievement synchronization and leaderboard finalization against a real
 * Postgres.
 *
 * Both write award counts and arena summaries with hand-written SQL under
 * advisory locks, and the profile read trusts a summary only when its
 * timestamp matches the counts'. None of that is visible to a mock.
 *
 * Skipped unless `VERIFY_DATABASE_URL` points at a **scratch** database; see
 * `lib/usage/ingest-db.test.ts` for setting one up. Run the two files with
 * `--no-file-parallelism`: each refuses to start while the other's accounts
 * exist.
 */
const VERIFY_URL = process.env.VERIFY_DATABASE_URL;

vi.mock("@/lib/prisma", async () => {
  const url = process.env.VERIFY_DATABASE_URL;

  if (!url) {
    // Suite is skipped; hand back a stub so the import graph still resolves.
    return { prisma: {} };
  }

  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import("@prisma/adapter-pg"),
    import("../../generated/prisma/client"),
  ]);

  return {
    prisma: new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    }),
  };
});

// The real one wraps its fetch in Next's `unstable_cache`, which needs a
// request context this process does not have.
vi.mock("@/lib/pricing/catalog", () => ({
  getPricingCatalog: async () => null,
}));

const RUN = randomUUID().slice(0, 8);
const USER_ID = `verify-ach-${RUN}`;
const RIVAL_ID = `verify-rival-${RUN}`;
// 25B tokens: 2,500 steps of the 10M-token achievement alone, more than two
// award chunks.
const TOTAL_TOKENS = 25_000_000_000;
// Two consecutive Shanghai days, and a moment after the second one closed.
const FIRST_DAY = new Date("2026-03-01T16:00:00.000Z");
const SECOND_DAY = new Date("2026-03-02T16:00:00.000Z");
const FINALIZED_AT = new Date("2026-03-03T21:00:00.000Z");

describe.skipIf(!VERIFY_URL)("achievements against a real database", () => {
  // biome-ignore lint/suspicious/noExplicitAny: resolved from the mocked module
  let prisma: any;
  let queries: typeof import("./queries");
  let finalize: typeof import("@/lib/leaderboard/finalize");

  const readCounts = async (userId: string) =>
    new Map<string, { awardCount: number; updatedAt: Date }>(
      (
        await prisma.userAchievement.findMany({
          where: { userId },
          select: { code: true, awardCount: true, updatedAt: true },
        })
      ).map(
        (row: { code: string; awardCount: number; updatedAt: Date }) =>
          [row.code, row] as const,
      ),
    );

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    queries = await import("./queries");
    finalize = await import("@/lib/leaderboard/finalize");

    // The only safe target is an empty database.
    const users = await prisma.user.count();
    if (users > 0) {
      throw new Error(
        `Refusing to run: ${users} user account(s) already exist, so this is ` +
          "not a scratch database.",
      );
    }

    const ids = [USER_ID, RIVAL_ID];
    await prisma.user.createMany({
      data: ids.map((id) => ({
        id,
        name: id,
        username: id.replaceAll("-", "_"),
        email: `${id}@example.invalid`,
      })),
    });
    await prisma.usagePreference.createMany({
      data: ids.map((userId) => ({
        userId,
        projectHashSalt: "verify",
        publicProfileEnabled: true,
        timezone: "UTC",
      })),
    });

    await prisma.usageBucket.create({
      data: {
        userId: USER_ID,
        deviceId: `device-${RUN}`,
        source: "codex",
        model: "gpt-5.4",
        projectKey: "project-a",
        projectLabel: "Project A",
        bucketStart: new Date("2026-03-02T02:00:00.000Z"),
        inputTokens: BigInt(TOTAL_TOKENS),
        outputTokens: BigInt(0),
        cachedTokens: BigInt(0),
        totalTokens: BigInt(TOTAL_TOKENS),
      },
    });
    await prisma.leaderboardUserDay.createMany({
      data: [
        { userId: USER_ID, statDate: FIRST_DAY, totalTokens: BigInt(500) },
        { userId: USER_ID, statDate: SECOND_DAY, totalTokens: BigInt(400) },
        { userId: RIVAL_ID, statDate: SECOND_DAY, totalTokens: BigInt(300) },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma?.user) return;
    await prisma.user.deleteMany({
      where: { id: { in: [USER_ID, RIVAL_ID] } },
    });
    // Period results are global rather than owned by a user.
    await prisma.leaderboardPeriodResult.deleteMany({});
    await prisma.$disconnect();
  });

  it("backfills thousands of awards and stores counts with the summary", async () => {
    await queries.synchronizeAchievementsForUser(USER_ID, "ingest");

    const counts = await readCounts(USER_ID);
    expect(counts.get("tokens_100k")?.awardCount).toBe(2_500);
    expect(
      await prisma.achievementAward.count({
        where: { userId: USER_ID, code: "tokens_100k" },
      }),
    ).toBe(2_500);

    const summary = await prisma.userArenaSummary.findUnique({
      where: { userId: USER_ID },
    });
    expect(summary.totalTokens).toBe(BigInt(TOTAL_TOKENS));
    // The counts carry the summary's timestamp, so a profile view serves the
    // stored score instead of recomputing it.
    expect(
      await prisma.userAchievement.findFirst({
        where: { userId: USER_ID, updatedAt: { gt: summary.computedAt } },
      }),
    ).toBeNull();
    expect(await queries.getArenaSummaryForProfile(USER_ID)).toMatchObject({
      score: summary.score,
      level: summary.level,
    });
  });

  it("rewrites nothing when a later pass changes nothing", async () => {
    const [before, awardsBefore] = await Promise.all([
      readCounts(USER_ID),
      prisma.achievementAward.count({ where: { userId: USER_ID } }),
    ]);

    await queries.synchronizeAchievementsForUser(USER_ID, "ingest");

    const after = await readCounts(USER_ID);
    expect(after.size).toBe(before.size);
    for (const [code, row] of before) {
      expect(after.get(code)).toEqual(row);
    }
    expect(
      await prisma.achievementAward.count({ where: { userId: USER_ID } }),
    ).toBe(awardsBefore);
  });

  it("issues every missed day window once and keeps the scores in step", async () => {
    await finalize.finalizePendingLeaderboardPeriods(FINALIZED_AT);
    await finalize.finalizePendingLeaderboardPeriods(FINALIZED_AT);

    // Both days are still within the lookback, so the earlier one is issued
    // late rather than skipped; the second pass changes nothing.
    expect(
      (await readCounts(USER_ID)).get("leaderboard_day_top50")?.awardCount,
    ).toBe(2);
    expect(
      (await readCounts(RIVAL_ID)).get("leaderboard_day_top50")?.awardCount,
    ).toBe(1);
    expect(
      await prisma.achievementAward.count({
        where: { code: "leaderboard_day_top50" },
      }),
    ).toBe(3);

    // The existing summary took the badge points; the rival has none yet and
    // keeps the profile fallback.
    const [summary, profile] = await Promise.all([
      prisma.userArenaSummary.findUnique({ where: { userId: USER_ID } }),
      queries.getArenaSummaryForProfile(USER_ID),
    ]);
    expect(profile.score).toBe(summary.score);
    expect(
      await prisma.userArenaSummary.findUnique({ where: { userId: RIVAL_ID } }),
    ).toBeNull();
    expect((await queries.getArenaSummaryForProfile(RIVAL_ID)).score).toBe(10);
  });

  it("keeps badges issued between synchronizations", async () => {
    const before = await readCounts(USER_ID);

    await queries.synchronizeAchievementsForUser(USER_ID, "ingest");

    // A pass used to write every stored count back, including badges it does
    // not evaluate; a finalization committed in between was lost.
    expect((await readCounts(USER_ID)).get("leaderboard_day_top50")).toEqual(
      before.get("leaderboard_day_top50"),
    );

    const summary = await prisma.userArenaSummary.findUnique({
      where: { userId: USER_ID },
    });
    const expectedScore = (
      await prisma.achievementAward.findMany({
        where: { userId: USER_ID },
        select: { pointsAwarded: true },
      })
    ).reduce(
      (sum: number, award: { pointsAwarded: number }) =>
        sum + award.pointsAwarded,
      0,
    );
    expect(summary.score).toBe(expectedScore);
  });
});
