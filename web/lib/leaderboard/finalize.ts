import { getArenaLevelFromScore } from "@/lib/achievements/arena-level";
import { achievementDefinitionMap } from "@/lib/achievements/catalog";
import type { AchievementCode } from "@/lib/achievements/types";
import { ADVISORY_LOCK_NAMESPACE, lockAdvisoryKeys } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import { toUtcTimestampLiteral } from "@/lib/sql-timestamp";
import { tokenCountToBigInt, tokenCountToNumber } from "@/lib/token-counts";
import { getTransactionTimeoutMs } from "@/lib/transaction-timeout";
import { Prisma } from "../../generated/prisma/client";
import { resolveFinalizableLeaderboardWindows } from "./date";
import type { LeaderboardPeriod } from "./types";

export type RankedLeaderboardEntry = {
  userId: string;
  rank: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  activeSeconds: number;
  sessions: number;
};

type LeaderboardBadgeAward = {
  userId: string;
  code: AchievementCode;
  awardedAt: Date;
  dedupeKey: string;
  pointsAwarded: number;
  progressValue: number;
  thresholdValue: number;
  sourceRef: string;
  context: Prisma.InputJsonValue;
};

function badgeCodeForPeriod(period: LeaderboardPeriod): AchievementCode | null {
  switch (period) {
    case "day":
      return "leaderboard_day_top50";
    case "week":
      return "leaderboard_week_top50";
    case "month":
      return "leaderboard_month_top50";
    default:
      return null;
  }
}

function badgePoints(code: AchievementCode) {
  return achievementDefinitionMap.get(code)?.points ?? 0;
}

export function buildLeaderboardBadgeAwards(input: {
  period: LeaderboardPeriod;
  windowStart: Date | null;
  windowEnd: Date | null;
  finalizedAt: Date;
  entries: RankedLeaderboardEntry[];
}): LeaderboardBadgeAward[] {
  const code = badgeCodeForPeriod(input.period);

  if (!code || !input.windowStart || !input.windowEnd) {
    return [];
  }

  const windowStart = input.windowStart;
  const windowEnd = input.windowEnd;

  return input.entries.reduce<LeaderboardBadgeAward[]>((acc, entry) => {
    if (entry.rank <= 50) {
      acc.push({
        userId: entry.userId,
        code,
        awardedAt: input.finalizedAt,
        dedupeKey: `leaderboard:${input.period}:${windowStart.toISOString()}:${entry.userId}:${code}`,
        pointsAwarded: badgePoints(code),
        progressValue: entry.rank,
        thresholdValue: 50,
        sourceRef: `${input.period}:${windowStart.toISOString()}`,
        context: {
          rank: entry.rank,
          totalTokens: entry.totalTokens,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
        },
      });
    }
    return acc;
  }, []);
}

type FinalizedPeriod = "day" | "week" | "month";

type LeaderboardWindowRange = { start: Date; end: Date };

/**
 * Past windows of each period checked for missing badges on every pass, so a
 * window whose pass failed is issued late rather than never.
 */
const FINALIZE_LOOKBACK_WINDOWS: Record<FinalizedPeriod, number> = {
  day: 7,
  week: 4,
  month: 2,
};

async function rankLeaderboardWindow(
  window: LeaderboardWindowRange,
): Promise<RankedLeaderboardEntry[]> {
  const rows = await prisma.leaderboardUserDay.groupBy({
    by: ["userId"],
    where: {
      statDate: {
        gte: window.start,
        lt: window.end,
      },
      user: {
        usagePreference: {
          is: {
            publicProfileEnabled: true,
          },
        },
      },
    },
    _sum: {
      inputTokens: true,
      outputTokens: true,
      reasoningTokens: true,
      cachedTokens: true,
      cacheCreationTokens: true,
      totalTokens: true,
      activeSeconds: true,
      sessions: true,
    },
    orderBy: [
      {
        _sum: {
          totalTokens: "desc",
        },
      },
      {
        userId: "asc",
      },
    ],
    take: 100,
  });

  return rows.reduce<RankedLeaderboardEntry[]>((acc, row, index) => {
    const totalTokens = tokenCountToNumber(row._sum.totalTokens);
    if (totalTokens > 0) {
      acc.push({
        userId: row.userId,
        rank: index + 1,
        inputTokens: tokenCountToNumber(row._sum.inputTokens),
        outputTokens: tokenCountToNumber(row._sum.outputTokens),
        reasoningTokens: tokenCountToNumber(row._sum.reasoningTokens),
        cachedTokens: tokenCountToNumber(row._sum.cachedTokens),
        cacheCreationTokens: tokenCountToNumber(row._sum.cacheCreationTokens),
        totalTokens,
        activeSeconds: row._sum.activeSeconds ?? 0,
        sessions: row._sum.sessions ?? 0,
      });
    }
    return acc;
  }, []);
}

/** Add the new badges to each winner's count in one statement. */
async function incrementBadgeCounts(
  tx: Prisma.TransactionClient,
  awards: LeaderboardBadgeAward[],
  now: Date,
) {
  const counts = new Map<
    string,
    { userId: string; code: AchievementCode; count: number; awardedAt: Date }
  >();

  // `ON CONFLICT` cannot touch one row twice, so awards for the same user and
  // code collapse first.
  for (const award of awards) {
    const key = `${award.userId}:${award.code}`;
    counts.set(key, {
      userId: award.userId,
      code: award.code,
      count: (counts.get(key)?.count ?? 0) + 1,
      awardedAt: award.awardedAt,
    });
  }

  const nowLiteral = toUtcTimestampLiteral(now);
  const rows = Array.from(counts.values()).map(
    (row) => Prisma.sql`(
      ${row.userId}::text,
      ${row.code}::text,
      ${row.count}::integer,
      ${toUtcTimestampLiteral(row.awardedAt)}::timestamp(3)
    )`,
  );

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "user_achievement" (
      "userId", "code", "awardCount", "firstAwardedAt", "lastAwardedAt",
      "createdAt", "updatedAt"
    )
    SELECT
      v."userId", v."code", v."awards", v."awardedAt", v."awardedAt",
      ${nowLiteral}::timestamp(3), ${nowLiteral}::timestamp(3)
    FROM (VALUES ${Prisma.join(rows)}) AS v(
      "userId", "code", "awards", "awardedAt"
    )
    ON CONFLICT ("userId", "code") DO UPDATE SET
      "awardCount" = "user_achievement"."awardCount" + EXCLUDED."awardCount",
      "lastAwardedAt" = EXCLUDED."lastAwardedAt",
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

/**
 * Keep existing profile summaries in step with the new badges. A user without
 * a summary yet keeps the profile fallback until their next synchronization.
 */
async function addBadgePointsToSummaries(
  tx: Prisma.TransactionClient,
  awards: LeaderboardBadgeAward[],
  now: Date,
) {
  const pointsByUser = new Map<string, number>();
  for (const award of awards) {
    pointsByUser.set(
      award.userId,
      (pointsByUser.get(award.userId) ?? 0) + award.pointsAwarded,
    );
  }

  const summaries = await tx.userArenaSummary.findMany({
    where: { userId: { in: Array.from(pointsByUser.keys()) } },
    select: { userId: true, score: true },
  });

  if (summaries.length === 0) {
    return;
  }

  const rows = summaries.map((summary) => {
    const score = summary.score + (pointsByUser.get(summary.userId) ?? 0);
    return Prisma.sql`(
      ${summary.userId}::text,
      ${score}::integer,
      ${getArenaLevelFromScore(score)}::integer
    )`;
  });

  await tx.$executeRaw(Prisma.sql`
    UPDATE "user_arena_summary" AS summary
    SET
      "score" = v."score",
      "level" = v."level",
      "updatedAt" = ${toUtcTimestampLiteral(now)}::timestamp(3)
    FROM (VALUES ${Prisma.join(rows)}) AS v("userId", "score", "level")
    WHERE summary."userId" = v."userId"
  `);
}

async function finalizeLeaderboardWindow(
  period: FinalizedPeriod,
  window: LeaderboardWindowRange,
  now: Date,
) {
  const entries = await rankLeaderboardWindow(window);
  const awards = buildLeaderboardBadgeAwards({
    period,
    windowStart: window.start,
    windowEnd: window.end,
    finalizedAt: now,
    entries,
  });
  const resultKey = {
    period,
    windowStart: window.start,
    windowEnd: window.end,
  };

  await prisma.$transaction(
    async (tx) => {
      // Two passes for one window used to race on the result row; the second
      // now waits here and then finds the badges already issued.
      await lockAdvisoryKeys(tx, ADVISORY_LOCK_NAMESPACE.leaderboardFinalize, [
        `${period}:${window.start.toISOString()}`,
      ]);
      const existing = await tx.leaderboardPeriodResult.findUnique({
        where: { period_windowStart_windowEnd: resultKey },
        select: { badgesIssuedAt: true },
      });

      if (existing?.badgesIssuedAt) {
        return;
      }

      // Achievement synchronization rewrites these counts and scores under
      // the same per-user lock.
      // react-doctor-disable-next-line react-doctor/async-parallel -- the winners are locked only once the window is known to need issuing
      await lockAdvisoryKeys(
        tx,
        ADVISORY_LOCK_NAMESPACE.achievementState,
        awards.map((award) => award.userId),
      );

      const result = await tx.leaderboardPeriodResult.upsert({
        where: { period_windowStart_windowEnd: resultKey },
        update: {
          finalizedAt: now,
          timezone: "Asia/Shanghai",
        },
        create: {
          ...resultKey,
          timezone: "Asia/Shanghai",
          finalizedAt: now,
        },
      });

      await tx.leaderboardPeriodEntry.deleteMany({
        where: {
          resultId: result.id,
        },
      });

      if (entries.length > 0) {
        await tx.leaderboardPeriodEntry.createMany({
          data: entries.map((entry) => ({
            resultId: result.id,
            userId: entry.userId,
            rank: entry.rank,
            inputTokens: tokenCountToBigInt(entry.inputTokens),
            outputTokens: tokenCountToBigInt(entry.outputTokens),
            reasoningTokens: tokenCountToBigInt(entry.reasoningTokens),
            cachedTokens: tokenCountToBigInt(entry.cachedTokens),
            cacheCreationTokens: tokenCountToBigInt(entry.cacheCreationTokens),
            totalTokens: tokenCountToBigInt(entry.totalTokens),
            activeSeconds: entry.activeSeconds,
            sessions: entry.sessions,
          })),
        });
      }

      if (awards.length > 0) {
        const existingAwards = await tx.achievementAward.findMany({
          where: {
            dedupeKey: {
              in: awards.map((award) => award.dedupeKey),
            },
          },
          select: {
            dedupeKey: true,
          },
        });
        const existingKeys = new Set(
          existingAwards.map((award) => award.dedupeKey),
        );
        const nextAwards = awards.filter(
          (award) => !existingKeys.has(award.dedupeKey),
        );

        if (nextAwards.length > 0) {
          // react-doctor-disable-next-line react-doctor/async-parallel -- statements in one transaction run one at a time regardless
          await tx.achievementAward.createMany({
            data: nextAwards.map((award) => ({
              userId: award.userId,
              code: award.code,
              awardedAt: award.awardedAt,
              source: "leaderboard",
              sourceRef: award.sourceRef,
              dedupeKey: award.dedupeKey,
              pointsAwarded: award.pointsAwarded,
              progressValue: award.progressValue,
              thresholdValue: award.thresholdValue,
              context: award.context,
            })),
          });
          await incrementBadgeCounts(tx, nextAwards, now);
          await addBadgePointsToSummaries(tx, nextAwards, now);
        }
      }

      await tx.leaderboardPeriodResult.update({
        where: {
          id: result.id,
        },
        data: {
          badgesIssuedAt: now,
        },
      });
    },
    { timeout: getTransactionTimeoutMs() },
  );
}

/**
 * Issue badges for every finalizable window that has not had them yet.
 *
 * Windows run one at a time, oldest first, so a pass holds at most one
 * connection. A failed window does not stop the others; the first error is
 * rethrown once every window has been tried.
 */
export async function finalizePendingLeaderboardPeriods(now = new Date()) {
  let firstError: unknown = null;

  for (const period of ["day", "week", "month"] as const) {
    const windows = resolveFinalizableLeaderboardWindows(
      period,
      now,
      FINALIZE_LOOKBACK_WINDOWS[period],
    );

    if (windows.length === 0) {
      continue;
    }

    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- periods run one at a time so a pass holds at most one connection
    const issued = await prisma.leaderboardPeriodResult.findMany({
      where: {
        period,
        windowStart: { in: windows.map((window) => window.start) },
        badgesIssuedAt: { not: null },
      },
      select: { windowStart: true },
    });
    const issuedStarts = new Set(
      issued.map((result) => result.windowStart?.getTime()),
    );

    for (const window of windows) {
      if (issuedStarts.has(window.start.getTime())) {
        continue;
      }

      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- windows are issued oldest first, one transaction at a time
        await finalizeLeaderboardWindow(period, window, now);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  if (firstError) {
    throw firstError;
  }
}

let pendingSettlement: Promise<void> | null = null;

/**
 * Finalize pending periods without failing the caller.
 *
 * Badge issuance is a side effect of whatever request reaches it first; it
 * must not fail that request or block the page that triggered it. Concurrent
 * calls in this process share one pass, and a failure is logged and retried by
 * the next call.
 */
export function settlePendingLeaderboardPeriods(): Promise<void> {
  pendingSettlement ??= finalizePendingLeaderboardPeriods()
    .catch((error: unknown) => {
      console.error("Failed to finalize leaderboard periods", { error });
    })
    .finally(() => {
      pendingSettlement = null;
    });

  return pendingSettlement;
}
