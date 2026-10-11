import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Social achievement checks against a real Postgres.
 *
 * The check that decides whether a follow can award anything counts mutual
 * follows through a relation filter, and social thresholds must be awarded
 * once however often they are re-crossed. Both depend on what the database
 * returns, so they are pinned here rather than against mocks.
 *
 * Skipped unless `VERIFY_DATABASE_URL` points at a **scratch** database; see
 * `lib/usage/ingest-db.test.ts` for setting one up. Run it on its own: like the
 * other database suites it refuses to start while foreign accounts exist.
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
const USER_ID = `verify-social-${RUN}`;
const FRIEND_IDS = [0, 1, 2].map((index) => `verify-friend-${index}-${RUN}`);
const ALL_IDS = [USER_ID, ...FRIEND_IDS];

describe.skipIf(!VERIFY_URL)(
  "social achievements against a real database",
  () => {
    // biome-ignore lint/suspicious/noExplicitAny: resolved from the mocked module
    let prisma: any;
    let queries: typeof import("./queries");

    const awardCount = async (code: string) =>
      (
        await prisma.userAchievement.findUnique({
          where: { userId_code: { userId: USER_ID, code } },
          select: { awardCount: true },
        })
      )?.awardCount ?? 0;

    beforeAll(async () => {
      ({ prisma } = await import("@/lib/prisma"));
      queries = await import("./queries");

      // The only safe target is an empty database.
      const users = await prisma.user.count();
      if (users > 0) {
        throw new Error(
          `Refusing to run: ${users} user account(s) already exist, so this is ` +
            "not a scratch database.",
        );
      }

      await prisma.user.createMany({
        data: ALL_IDS.map((id) => ({
          id,
          name: id,
          username: id.replaceAll("-", "_"),
          email: `${id}@example.invalid`,
        })),
      });
      await prisma.usagePreference.createMany({
        data: ALL_IDS.map((userId) => ({
          userId,
          projectHashSalt: "verify",
          publicProfileEnabled: true,
          timezone: "UTC",
        })),
      });
      // Three mutual follows.
      await prisma.follow.createMany({
        data: FRIEND_IDS.flatMap((friendId) => [
          { followerId: USER_ID, followingId: friendId },
          { followerId: friendId, followingId: USER_ID },
        ]),
      });
    });

    afterAll(async () => {
      if (!prisma?.user) return;
      await prisma.user.deleteMany({ where: { id: { in: ALL_IDS } } });
      await prisma.leaderboardSnapshot.deleteMany({});
      await prisma.leaderboardPeriodResult.deleteMany({});
      await prisma.$disconnect();
    });

    it("awards the mutual threshold that three mutual follows reach", async () => {
      await queries.synchronizeSocialAchievementsIfDue(USER_ID);

      expect(await awardCount("first_follow")).toBe(1);
      expect(await awardCount("first_follower")).toBe(1);
      expect(await awardCount("mutual_3")).toBe(1);
      expect(await awardCount("following_10")).toBe(0);
    });

    it("does not award it again after the follow is dropped and restored", async () => {
      const friendId = FRIEND_IDS[0];
      await prisma.follow.deleteMany({
        where: { followerId: USER_ID, followingId: friendId },
      });
      await queries.synchronizeAchievementsForUser(USER_ID, "social");
      await prisma.follow.create({
        data: { followerId: USER_ID, followingId: friendId },
      });
      await queries.synchronizeSocialAchievementsIfDue(USER_ID);
      await queries.synchronizeAchievementsForUser(USER_ID, "social");

      expect(await awardCount("mutual_3")).toBe(1);
      expect(
        await prisma.achievementAward.count({
          where: { userId: USER_ID, code: "mutual_3" },
        }),
      ).toBe(1);
    });
  },
);
