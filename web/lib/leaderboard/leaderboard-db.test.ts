import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Leaderboard reads and snapshot writes against a real Postgres, with one
 * account whose reported totals exceed what the summed columns can hold.
 *
 * Usage is client-reported, so a single account could push its window sums
 * past an `integer` snapshot column or a `::bigint` cast. Both used to fail the
 * statement shared by every viewer; only a database shows whether they still
 * do.
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
const HEAVY_ID = `verify-heavy-${RUN}`;
const VIEWER_ID = `verify-viewer-${RUN}`;
const FILLER_IDS = Array.from(
  { length: 50 },
  (_, index) => `verify-filler-${index}-${RUN}`,
);
const ALL_IDS = [HEAVY_ID, VIEWER_ID, ...FILLER_IDS];

const PG_INTEGER_MAX = 2_147_483_647;
// Each day fits its column; the week's sum does not fit a `bigint`.
const NEAR_BIGINT_MAX = BigInt("9000000000000000000");
// Thursday in the Shanghai week that starts 2026-03-02.
const NOW = new Date("2026-03-05T04:00:00.000Z");
const SHANGHAI_DAYS = [
  new Date("2026-03-02T16:00:00.000Z"),
  new Date("2026-03-03T16:00:00.000Z"),
];

describe.skipIf(!VERIFY_URL)("leaderboards against a real database", () => {
  // biome-ignore lint/suspicious/noExplicitAny: resolved from the mocked module
  let prisma: any;
  let queries: typeof import("./queries");
  let rank: typeof import("./rank");

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    queries = await import("./queries");
    rank = await import("./rank");

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
    await prisma.leaderboardUserDay.createMany({
      data: [
        ...SHANGHAI_DAYS.map((statDate) => ({
          userId: HEAVY_ID,
          statDate,
          totalTokens: NEAR_BIGINT_MAX,
          activeSeconds: PG_INTEGER_MAX,
          sessions: PG_INTEGER_MAX,
        })),
        ...FILLER_IDS.map((userId, index) => ({
          userId,
          statDate: SHANGHAI_DAYS[0],
          totalTokens: BigInt(1_000 + index),
          activeSeconds: 60,
          sessions: 1,
        })),
        {
          userId: VIEWER_ID,
          statDate: SHANGHAI_DAYS[1],
          totalTokens: BigInt(10),
          activeSeconds: 30,
          sessions: 1,
        },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma?.user) return;
    await prisma.leaderboardSnapshot.deleteMany({});
    await prisma.user.deleteMany({ where: { id: { in: ALL_IDS } } });
    await prisma.$disconnect();
  });

  it("builds the week board with saturated sums instead of failing it", async () => {
    const data = await queries.getLeaderboardPageData({
      period: "week",
      metric: "total_tokens",
      now: NOW,
    });

    expect(data.global.entries[0]).toMatchObject({
      userId: HEAVY_ID,
      rank: 1,
      activeSeconds: PG_INTEGER_MAX,
      sessions: PG_INTEGER_MAX,
    });

    const stored = await prisma.leaderboardSnapshotEntry.findFirst({
      where: { userId: HEAVY_ID },
    });
    expect(stored).toMatchObject({
      activeSeconds: PG_INTEGER_MAX,
      sessions: PG_INTEGER_MAX,
    });
  });

  it("ranks a viewer below the board despite an overflowing account", async () => {
    const data = await queries.getLeaderboardPageData({
      period: "week",
      metric: "total_tokens",
      viewerUserId: VIEWER_ID,
      now: NOW,
    });

    expect(data.viewerGlobalEntry).toMatchObject({
      userId: VIEWER_ID,
      rank: ALL_IDS.length,
    });
  });

  it("computes global ranks for achievements without a bigint overflow", async () => {
    const ranks = await rank.getUserGlobalLeaderboardRanksByTotalTokens(
      VIEWER_ID,
      NOW,
    );

    expect(ranks.week).toBe(ALL_IDS.length);
    expect(ranks.all_time).toBe(ALL_IDS.length);
  });
});
