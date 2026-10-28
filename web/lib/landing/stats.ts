import "server-only";
import { unstable_cache } from "next/cache";
import { Prisma } from "@/generated/prisma/client";
import { resolveLeaderboardWindow } from "@/lib/leaderboard/date";
import { prisma } from "@/lib/prisma";
import { tokenCountToNumber } from "@/lib/token-counts";

export type LandingStats = {
  /** Public profiles with any recorded usage. */
  developers: number;
  totalTokens: number;
  /** Tokens inside the current leaderboard week. */
  weekTokens: number;
  activeSeconds: number;
};

type LandingStatsRow = {
  developers: bigint;
  totalTokens: bigint;
  weekTokens: bigint;
  activeSeconds: bigint;
};

const LANDING_STATS_REVALIDATE_SECONDS = 600;

/**
 * Site-wide totals for the landing page, counted over public profiles only so
 * the page never reveals usage from someone who has opted out of the boards.
 */
export async function computeLandingStats(
  now = new Date(),
): Promise<LandingStats> {
  const week = resolveLeaderboardWindow("week", now);
  const rows = await prisma.$queryRaw<LandingStatsRow[]>(Prisma.sql`
    SELECT
      COUNT(DISTINCT l."userId") AS "developers",
      LEAST(COALESCE(SUM(l."totalTokens"), 0), 9223372036854775807)::bigint AS "totalTokens",
      LEAST(
        COALESCE(
          SUM(l."totalTokens") FILTER (
            WHERE l."statDate" >= ${week.start} AND l."statDate" < ${week.end}
          ),
          0
        ),
        9223372036854775807
      )::bigint AS "weekTokens",
      COALESCE(SUM(l."activeSeconds"), 0)::bigint AS "activeSeconds"
    FROM leaderboard_user_day l
    INNER JOIN "UsagePreference" up ON up."userId" = l."userId"
    WHERE up."publicProfileEnabled" = true
      AND l."totalTokens" > 0
  `);
  const row = rows[0];

  return {
    developers: tokenCountToNumber(row?.developers),
    totalTokens: tokenCountToNumber(row?.totalTokens),
    weekTokens: tokenCountToNumber(row?.weekTokens),
    activeSeconds: tokenCountToNumber(row?.activeSeconds),
  };
}

/** Totals move slowly and every anonymous visit asks for them, so cache. */
export const getLandingStats = unstable_cache(
  () => computeLandingStats(),
  ["landing-stats"],
  { revalidate: LANDING_STATS_REVALIDATE_SECONDS },
);
