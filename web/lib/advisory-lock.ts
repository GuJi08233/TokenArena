import { Prisma } from "../generated/prisma/client";

/**
 * First key of each two-key advisory lock this app takes. The two-key space
 * does not overlap the single bigint key Prisma Migrate locks on.
 */
export const ADVISORY_LOCK_NAMESPACE = {
  /** One user's award counts and arena summary. */
  achievementState: 1,
  /** One leaderboard window while its badges are issued. */
  leaderboardFinalize: 2,
} as const;

type AdvisoryLockClient = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Take transaction-scoped advisory locks on every name, released at commit.
 *
 * All names are locked in one statement and in ascending key order, so two
 * transactions locking overlapping sets wait for each other instead of
 * deadlocking. Names are hashed to 32 bits; a collision only serializes two
 * unrelated names, it never lets two holders of the same name through.
 */
export async function lockAdvisoryKeys(
  db: AdvisoryLockClient,
  namespace: number,
  names: string[],
) {
  if (names.length === 0) {
    return;
  }

  await db.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(${namespace}::integer, ordered."key")
    FROM (
      SELECT DISTINCT hashtext(requested."name") AS "key"
      FROM (VALUES ${Prisma.join(
        names.map((name) => Prisma.sql`(${name}::text)`),
      )}) AS requested("name")
      ORDER BY "key"
    ) AS ordered
  `);
}
