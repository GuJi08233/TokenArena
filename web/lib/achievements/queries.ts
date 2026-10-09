import "server-only";

import { ADVISORY_LOCK_NAMESPACE, lockAdvisoryKeys } from "@/lib/advisory-lock";
import { settlePendingLeaderboardPeriods } from "@/lib/leaderboard/finalize";
import { getUserGlobalLeaderboardRanksByTotalTokens } from "@/lib/leaderboard/rank";
import type { PricingCatalog } from "@/lib/pricing/catalog";
import { getPricingCatalog } from "@/lib/pricing/catalog";
import {
  estimateCostUsd,
  resolveOfficialPricingMatch,
} from "@/lib/pricing/resolve";
import { prisma } from "@/lib/prisma";
import { toUtcTimestampLiteral } from "@/lib/sql-timestamp";
import { tokenCountToBigInt, tokenCountToNumber } from "@/lib/token-counts";
import { getTransactionTimeoutMs } from "@/lib/transaction-timeout";
import { resolveDashboardRange } from "@/lib/usage/date-range";
import { formatDateInput } from "@/lib/usage/format";
import { getUsagePreference } from "@/lib/usage/preferences";
import type { UsageShareCardPersona } from "@/lib/usage/share-card";
import { normalizeUsageSource } from "@/lib/usage/sources";
import {
  type AchievementAwardSource,
  Prisma,
} from "../../generated/prisma/client";
import { getArenaLevelFromScore } from "./arena-level";
import { achievementDefinitionMap } from "./catalog";
import {
  type AchievementInputMetrics,
  buildAchievementNotificationData,
  buildAchievementStatuses,
  buildAchievementsPageDataFromStatuses,
} from "./evaluate";
import {
  buildAchievementAwardPlan,
  mergeAchievementRecords,
  type PlannedAchievementAward,
  type StoredAchievementRecord,
} from "./records";
import {
  addTimelineValue,
  finalizeDistinctTimeline,
  finalizeTimeline,
  recordDistinctTimelineKey,
} from "./timeline";
import type {
  AchievementCode,
  AchievementNotificationData,
  AchievementStatus,
  AchievementsPageData,
} from "./types";

function latestIso(values: Array<string | null | undefined>) {
  const timestamps: number[] = [];

  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      timestamps.push(parsed);
    }
  }

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function earliestIso(values: Array<string | null | undefined>) {
  const timestamps: number[] = [];

  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      timestamps.push(parsed);
    }
  }

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.min(...timestamps)).toISOString();
}

function estimateBucketCostUsd(
  bucket: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  },
  catalog: PricingCatalog | null,
) {
  if (!catalog) {
    return 0;
  }

  const match = resolveOfficialPricingMatch(catalog, bucket.model);
  const estimate = estimateCostUsd(
    {
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      reasoningTokens: bucket.reasoningTokens,
      cachedTokens: bucket.cachedTokens,
      cacheCreationTokens: bucket.cacheCreationTokens ?? 0,
    },
    match?.cost,
  );

  return estimate?.totalUsd ?? 0;
}

function resolveCurrentPersona(input: {
  totalTokens: number;
  totalSessions: number;
  reasoningShare: number;
  cacheShare: number;
  topProjectShare: number;
  topModelShare: number;
  modelDiversity: number;
}): UsageShareCardPersona | null {
  if (input.totalTokens <= 0 && input.totalSessions <= 0) {
    return null;
  }

  const averageTokensPerSession =
    input.totalSessions > 0 ? input.totalTokens / input.totalSessions : 0;

  if (input.reasoningShare >= 0.28) {
    return "reasoning_master";
  }

  if (input.cacheShare >= 0.18) {
    return "cache_guardian";
  }

  if (input.topProjectShare >= 0.68) {
    return "project_deep_diver";
  }

  if (input.modelDiversity >= 3 && input.topModelShare <= 0.62) {
    return "model_orchestrator";
  }

  if (input.totalSessions >= 10 && averageTokensPerSession <= 120_000) {
    return "rapid_shipper";
  }

  return "steady_builder";
}

export function buildAllTimeMetrics(input: {
  timezone: string;
  buckets: Array<{
    bucketStart: Date;
    totalTokens: number | bigint;
    inputTokens: number | bigint;
    outputTokens: number | bigint;
    reasoningTokens: number | bigint;
    cachedTokens: number | bigint;
    cacheCreationTokens: number | bigint;
    model: string;
    source: string;
    projectKey: string;
    deviceId: string;
  }>;
  sessions: Array<{
    firstMessageAt: Date;
    activeSeconds: number;
    deviceId: string;
  }>;
  following: Array<{ followingId: string; createdAt: Date }>;
  followers: Array<{ followerId: string; createdAt: Date }>;
  publicProfileEnabled: boolean;
  publicProfileUpdatedAt: Date | null;
  leaderboardRanks?: {
    day: number | null;
    week: number | null;
    month: number | null;
    all_time: number | null;
  };
  catalog: PricingCatalog | null;
}): AchievementInputMetrics {
  const leaderboardRanks = input.leaderboardRanks ?? {
    day: null,
    week: null,
    month: null,
    all_time: null,
  };
  const tokenValuesByTimestamp = new Map<string, number>();
  const costValuesByTimestamp = new Map<string, number>();
  const sessionValuesByTimestamp = new Map<string, number>();
  const activeSecondsByTimestamp = new Map<string, number>();
  const firstModelTimestamp = new Map<string, string>();
  const firstToolTimestamp = new Map<string, string>();
  const firstProjectTimestamp = new Map<string, string>();
  const firstDeviceTimestamp = new Map<string, string>();
  const activityDayKeys = new Set<string>();
  let totalTokens = 0;
  let totalActiveSeconds = 0;
  let totalEstimatedCostUsd = 0;

  for (const bucket of input.buckets) {
    const at = bucket.bucketStart.toISOString();
    const normalized = {
      totalTokens: tokenCountToNumber(bucket.totalTokens),
      inputTokens: tokenCountToNumber(bucket.inputTokens),
      outputTokens: tokenCountToNumber(bucket.outputTokens),
      reasoningTokens: tokenCountToNumber(bucket.reasoningTokens),
      cachedTokens: tokenCountToNumber(bucket.cachedTokens),
      cacheCreationTokens: tokenCountToNumber(bucket.cacheCreationTokens),
    };
    const estimatedCostUsd = estimateBucketCostUsd(
      {
        model: bucket.model,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        reasoningTokens: normalized.reasoningTokens,
        cachedTokens: normalized.cachedTokens,
        cacheCreationTokens: normalized.cacheCreationTokens ?? 0,
      },
      input.catalog,
    );

    addTimelineValue(tokenValuesByTimestamp, at, normalized.totalTokens);
    addTimelineValue(costValuesByTimestamp, at, estimatedCostUsd);
    recordDistinctTimelineKey(firstModelTimestamp, bucket.model, at);
    recordDistinctTimelineKey(
      firstToolTimestamp,
      normalizeUsageSource(bucket.source),
      at,
    );
    recordDistinctTimelineKey(firstProjectTimestamp, bucket.projectKey, at);
    recordDistinctTimelineKey(firstDeviceTimestamp, bucket.deviceId, at);
    activityDayKeys.add(formatDateInput(bucket.bucketStart, input.timezone));
    totalTokens += normalized.totalTokens;
    totalEstimatedCostUsd += estimatedCostUsd;
  }

  for (const session of input.sessions) {
    const at = session.firstMessageAt.toISOString();
    addTimelineValue(sessionValuesByTimestamp, at, 1);
    addTimelineValue(activeSecondsByTimestamp, at, session.activeSeconds);
    recordDistinctTimelineKey(firstDeviceTimestamp, session.deviceId, at);
    activityDayKeys.add(
      formatDateInput(session.firstMessageAt, input.timezone),
    );
    totalActiveSeconds += session.activeSeconds;
  }

  const tokenTimeline = finalizeTimeline(tokenValuesByTimestamp);
  const costTimeline = finalizeTimeline(costValuesByTimestamp);
  const sessionTimeline = finalizeTimeline(sessionValuesByTimestamp);
  const activeSecondsTimeline = finalizeTimeline(activeSecondsByTimestamp);
  const modelTimeline = finalizeDistinctTimeline(firstModelTimestamp);
  const toolTimeline = finalizeDistinctTimeline(firstToolTimestamp);
  const projectTimeline = finalizeDistinctTimeline(firstProjectTimestamp);
  const deviceTimeline = finalizeDistinctTimeline(firstDeviceTimestamp);

  tokenValuesByTimestamp.clear();
  costValuesByTimestamp.clear();
  sessionValuesByTimestamp.clear();
  activeSecondsByTimestamp.clear();
  firstModelTimestamp.clear();
  firstToolTimestamp.clear();
  firstProjectTimestamp.clear();
  firstDeviceTimestamp.clear();

  const sortedActivityDayKeys = Array.from(activityDayKeys).sort(
    (left, right) => left.localeCompare(right),
  );

  const now = new Date();
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const followingMap = new Map(
    input.following.map(
      (record) => [record.followingId, record.createdAt] as const,
    ),
  );
  const mutualEffectiveDates = input.followers
    .reduce<string[]>((acc, record) => {
      const followingAt = followingMap.get(record.followerId);

      if (followingAt) {
        acc.push(
          new Date(
            Math.max(followingAt.getTime(), record.createdAt.getTime()),
          ).toISOString(),
        );
      }

      return acc;
    }, [])
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  const recentRange = resolveDashboardRange({
    preset: "30d",
    timezone: input.timezone,
    now,
  });
  const recentTotals = {
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    byProject: new Map<string, number>(),
    byModel: new Map<string, number>(),
  };
  let recentSessionCount = 0;
  let lastRecentBucketAt: string | null = null;
  let lastRecentSessionAt: string | null = null;

  for (const bucket of input.buckets) {
    const timestamp = bucket.bucketStart.getTime();
    if (
      timestamp < recentRange.from.getTime() ||
      timestamp > recentRange.to.getTime()
    ) {
      continue;
    }

    const bucketTotalTokens = tokenCountToNumber(bucket.totalTokens);
    recentTotals.totalTokens += bucketTotalTokens;
    recentTotals.reasoningTokens += tokenCountToNumber(bucket.reasoningTokens);
    recentTotals.cachedTokens += tokenCountToNumber(bucket.cachedTokens);
    recentTotals.cacheCreationTokens += tokenCountToNumber(
      bucket.cacheCreationTokens,
    );
    recentTotals.byProject.set(
      bucket.projectKey,
      (recentTotals.byProject.get(bucket.projectKey) ?? 0) + bucketTotalTokens,
    );
    recentTotals.byModel.set(
      bucket.model,
      (recentTotals.byModel.get(bucket.model) ?? 0) + bucketTotalTokens,
    );
    lastRecentBucketAt = bucket.bucketStart.toISOString();
  }

  for (const session of input.sessions) {
    const timestamp = session.firstMessageAt.getTime();
    if (
      timestamp < recentRange.from.getTime() ||
      timestamp > recentRange.to.getTime()
    ) {
      continue;
    }

    recentSessionCount += 1;
    lastRecentSessionAt = session.firstMessageAt.toISOString();
  }

  const topProjectTokens = Math.max(0, ...recentTotals.byProject.values());
  const topModelTokens = Math.max(0, ...recentTotals.byModel.values());
  const totalTokens30d = recentTotals.totalTokens;
  const reasoningShare30d =
    totalTokens30d > 0 ? recentTotals.reasoningTokens / totalTokens30d : 0;
  const cacheShare30d =
    totalTokens30d > 0 ? recentTotals.cachedTokens / totalTokens30d : 0;
  const topProjectShare30d =
    totalTokens30d > 0 ? topProjectTokens / totalTokens30d : 0;
  const topModelShare30d =
    totalTokens30d > 0 ? topModelTokens / totalTokens30d : 0;
  const currentPersona = resolveCurrentPersona({
    totalTokens: totalTokens30d,
    totalSessions: recentSessionCount,
    reasoningShare: reasoningShare30d,
    cacheShare: cacheShare30d,
    topProjectShare: topProjectShare30d,
    topModelShare: topModelShare30d,
    modelDiversity: recentTotals.byModel.size,
  });

  return {
    timezone: input.timezone,
    firstSyncAt: latestIso([
      tokenTimeline[0]?.at ?? null,
      sessionTimeline[0]?.at ?? null,
    ])
      ? earliestIso([tokenTimeline[0]?.at, sessionTimeline[0]?.at])
      : null,
    publicProfileEnabled: input.publicProfileEnabled,
    publicProfileUpdatedAt: input.publicProfileUpdatedAt?.toISOString() ?? null,
    activeDayKeys: sortedActivityDayKeys,
    todayKey: formatDateInput(now, input.timezone),
    yesterdayKey: formatDateInput(yesterday, input.timezone),
    totalTokens,
    totalSessions: input.sessions.length,
    totalActiveSeconds,
    tokenTimeline,
    costTimeline,
    totalEstimatedCostUsd,
    sessionTimeline,
    activeSecondsTimeline,
    modelTimeline,
    toolTimeline,
    projectTimeline,
    deviceTimeline,
    reasoningShare30d,
    cacheShare30d,
    topProjectShare30d,
    recentWindowUnlockedAt: latestIso([
      lastRecentBucketAt,
      lastRecentSessionAt,
    ]),
    followingCount: input.following.length,
    firstFollowingAt: input.following[0]?.createdAt.toISOString() ?? null,
    followingTimeline: input.following.map((record) =>
      record.createdAt.toISOString(),
    ),
    followerCount: input.followers.length,
    firstFollowerAt: input.followers[0]?.createdAt.toISOString() ?? null,
    followerTimeline: input.followers.map((record) =>
      record.createdAt.toISOString(),
    ),
    mutualCount: mutualEffectiveDates.length,
    mutualReachedAt: mutualEffectiveDates[2] ?? null,
    mutualTimeline: mutualEffectiveDates,
    currentPersona,
    leaderboardDayRank: leaderboardRanks.day,
    leaderboardWeekRank: leaderboardRanks.week,
    leaderboardMonthRank: leaderboardRanks.month,
    leaderboardAllTimeRank: leaderboardRanks.all_time,
  };
}

function normalizeStoredAchievementRecord(row: {
  code: string;
  awardCount: number;
  firstAwardedAt: Date | null;
  lastAwardedAt: Date | null;
  state: unknown;
}): StoredAchievementRecord | null {
  return {
    code: row.code as StoredAchievementRecord["code"],
    awardCount: row.awardCount,
    firstAwardedAt: row.firstAwardedAt?.toISOString() ?? null,
    lastAwardedAt: row.lastAwardedAt?.toISOString() ?? null,
    state:
      row.state && typeof row.state === "object"
        ? (row.state as StoredAchievementRecord["state"])
        : null,
  };
}

async function loadAchievementMetrics(userId: string) {
  const [preference, user, buckets, sessions, following, followers, catalog] =
    await Promise.all([
      getUsagePreference(userId),
      prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          usagePreference: {
            select: {
              publicProfileEnabled: true,
              updatedAt: true,
            },
          },
        },
      }),
      prisma.usageBucket.findMany({
        where: { userId },
        select: {
          bucketStart: true,
          totalTokens: true,
          inputTokens: true,
          outputTokens: true,
          reasoningTokens: true,
          cachedTokens: true,
          cacheCreationTokens: true,
          model: true,
          source: true,
          projectKey: true,
          deviceId: true,
        },
        orderBy: { bucketStart: "asc" },
      }),
      prisma.usageSession.findMany({
        where: { userId },
        select: {
          firstMessageAt: true,
          activeSeconds: true,
          deviceId: true,
        },
        orderBy: { firstMessageAt: "asc" },
      }),
      prisma.follow.findMany({
        where: { followerId: userId },
        select: {
          followingId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.follow.findMany({
        where: { followingId: userId },
        select: {
          followerId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      getPricingCatalog(),
    ]);
  const publicProfileEnabled =
    user.usagePreference?.publicProfileEnabled ?? false;
  const leaderboardRanks =
    await getUserGlobalLeaderboardRanksByTotalTokens(userId);

  return buildAllTimeMetrics({
    timezone: preference.timezone,
    buckets,
    sessions,
    following,
    followers,
    publicProfileEnabled,
    publicProfileUpdatedAt: user.usagePreference?.updatedAt ?? null,
    leaderboardRanks,
    catalog,
  });
}

function toStoredAchievementRecords(
  rows: Parameters<typeof normalizeStoredAchievementRecord>[0][],
) {
  return rows.reduce<StoredAchievementRecord[]>((acc, row) => {
    const record = normalizeStoredAchievementRecord(row);
    if (record) acc.push(record);
    return acc;
  }, []);
}

function toAchievementAwardRow(award: PlannedAchievementAward) {
  return {
    userId: award.userId,
    code: award.code,
    awardedAt: new Date(award.awardedAt),
    source: award.source,
    dedupeKey: award.dedupeKey,
    pointsAwarded: award.pointsAwarded,
    progressValue: award.progressValue,
    thresholdValue: award.thresholdValue,
    context: award.context,
  };
}

const AWARD_INSERT_CHUNK_SIZE = 1_000;

/**
 * Write planned awards to the ledger ahead of the counter transaction.
 *
 * A first synchronization of a long history can plan thousands of awards.
 * Inside the transaction they could push it past its timeout, after which
 * nothing was recorded and every later attempt planned the same backlog. The
 * ledger is keyed by `dedupeKey`, so autocommit chunks are idempotent: a retry,
 * or a concurrent pass for the same user, only skips existing rows.
 */
async function insertAchievementAwards(awards: PlannedAchievementAward[]) {
  for (let start = 0; start < awards.length; start += AWARD_INSERT_CHUNK_SIZE) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one chunk at a time, so a backfill cannot take every pooled connection
    await prisma.achievementAward.createMany({
      data: awards
        .slice(start, start + AWARD_INSERT_CHUNK_SIZE)
        .map(toAchievementAwardRow),
      skipDuplicates: true,
    });
  }
}

function isSameAchievementRecord(
  next: StoredAchievementRecord,
  stored: StoredAchievementRecord,
) {
  return (
    next.awardCount === stored.awardCount &&
    next.firstAwardedAt === stored.firstAwardedAt &&
    next.lastAwardedAt === stored.lastAwardedAt &&
    // A plan without state leaves the stored state alone.
    (next.state === null ||
      next.state.lastQualified === stored.state?.lastQualified)
  );
}

/**
 * Records the plan actually changed.
 *
 * The plan carries every stored record, including leaderboard badges it never
 * evaluates. Writing those back used to overwrite an increment a concurrent
 * finalization had just made; only changed rows are written now. A code that
 * was never awarded still gets no row.
 */
function listChangedAchievementRecords(
  planned: Map<AchievementCode, StoredAchievementRecord>,
  stored: StoredAchievementRecord[],
) {
  const storedByCode = new Map(stored.map((record) => [record.code, record]));

  return Array.from(planned.values()).filter((record) => {
    const existing = storedByCode.get(record.code);

    return existing
      ? !isSameAchievementRecord(record, existing)
      : record.awardCount > 0;
  });
}

/** Upsert changed award counts in one statement instead of one per code. */
async function upsertAchievementRecords(
  tx: Prisma.TransactionClient,
  userId: string,
  records: StoredAchievementRecord[],
  now: Date,
) {
  const nowLiteral = toUtcTimestampLiteral(now);
  const rows = records.map(
    (record) => Prisma.sql`(
      ${record.code}::text,
      ${record.awardCount}::integer,
      ${record.firstAwardedAt === null ? null : toUtcTimestampLiteral(record.firstAwardedAt)}::timestamp(3),
      ${record.lastAwardedAt === null ? null : toUtcTimestampLiteral(record.lastAwardedAt)}::timestamp(3),
      ${record.state === null ? null : JSON.stringify(record.state)}::jsonb
    )`,
  );

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "user_achievement" (
      "userId", "code", "awardCount", "firstAwardedAt", "lastAwardedAt",
      "state", "createdAt", "updatedAt"
    )
    SELECT
      ${userId}::text, v."code", v."awardCount", v."firstAwardedAt",
      v."lastAwardedAt", v."state", ${nowLiteral}::timestamp(3),
      ${nowLiteral}::timestamp(3)
    FROM (VALUES ${Prisma.join(rows)}) AS v(
      "code", "awardCount", "firstAwardedAt", "lastAwardedAt", "state"
    )
    ON CONFLICT ("userId", "code") DO UPDATE SET
      "awardCount" = EXCLUDED."awardCount",
      "firstAwardedAt" = EXCLUDED."firstAwardedAt",
      "lastAwardedAt" = EXCLUDED."lastAwardedAt",
      -- A record without state keeps the stored one, as the Prisma upsert did.
      "state" = COALESCE(EXCLUDED."state", "user_achievement"."state"),
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

/**
 * Re-plan under the user's lock, then write counts and the summary together.
 *
 * Leaderboard finalization increments the same counts and score while holding
 * the same lock, so neither side can write values computed before the other
 * committed. The summary shares the counts' timestamp, which tells a profile
 * view the stored score is current.
 */
async function writeAchievementState(input: {
  userId: string;
  metrics: AchievementInputMetrics;
  statuses: AchievementStatus[];
  source: AchievementAwardSource;
  evaluatedAt: string;
  insertedAwardKeys: Set<string>;
}) {
  const now = new Date();

  return prisma.$transaction(
    async (tx) => {
      await lockAdvisoryKeys(tx, ADVISORY_LOCK_NAMESPACE.achievementState, [
        input.userId,
      ]);
      const stored = toStoredAchievementRecords(
        await tx.userAchievement.findMany({ where: { userId: input.userId } }),
      );
      const plan = buildAchievementAwardPlan({
        userId: input.userId,
        evaluatedAt: input.evaluatedAt,
        source: input.source,
        statuses: input.statuses,
        records: stored,
      });
      // Usually empty: only awards a concurrent change made newly due.
      const lateAwards = plan.awards.filter(
        (award) => !input.insertedAwardKeys.has(award.dedupeKey),
      );

      if (lateAwards.length > 0) {
        await tx.achievementAward.createMany({
          data: lateAwards.map(toAchievementAwardRow),
          skipDuplicates: true,
        });
      }

      const changed = listChangedAchievementRecords(plan.records, stored);
      if (changed.length > 0) {
        await upsertAchievementRecords(tx, input.userId, changed, now);
      }

      const pageData = buildAchievementsPageDataFromStatuses({
        metrics: input.metrics,
        achievements: mergeAchievementRecords(input.statuses, plan.records),
      });
      const summary = {
        score: pageData.summary.score,
        level: pageData.summary.level,
        totalTokens: tokenCountToBigInt(input.metrics.totalTokens),
        totalEstimatedCostUsd: input.metrics.totalEstimatedCostUsd,
        totalActiveSeconds: input.metrics.totalActiveSeconds,
        totalSessions: input.metrics.totalSessions,
        totalActiveDays: pageData.summary.totalActiveDays,
        computedAt: now,
      };

      await tx.userArenaSummary.upsert({
        where: { userId: input.userId },
        update: summary,
        create: { userId: input.userId, ...summary },
      });

      return { records: plan.records, pageData };
    },
    { timeout: getTransactionTimeoutMs() },
  );
}

async function synchronizeUserAchievements(input: {
  userId: string;
  metrics: AchievementInputMetrics;
  source: AchievementAwardSource;
}) {
  const evaluatedAt = new Date().toISOString();
  const statuses = buildAchievementStatuses(input.metrics);
  const draft = buildAchievementAwardPlan({
    userId: input.userId,
    evaluatedAt,
    source: input.source,
    statuses,
    records: toStoredAchievementRecords(
      await prisma.userAchievement.findMany({
        where: { userId: input.userId },
      }),
    ),
  });

  await insertAchievementAwards(draft.awards);

  return writeAchievementState({
    userId: input.userId,
    metrics: input.metrics,
    statuses,
    source: input.source,
    evaluatedAt,
    insertedAwardKeys: new Set(draft.awards.map((award) => award.dedupeKey)),
  });
}

/**
 * Re-evaluate every achievement for a user and persist the results.
 *
 * This is the expensive path: it replays the user's whole bucket and session
 * history and runs four global rank queries, so it only belongs after writes
 * (ingest, follow) and on the owner's own pages — never on a public profile
 * view. It refreshes `UserArenaSummary` so those views can read a row instead.
 */
async function refreshUserAchievements(
  userId: string,
  source: AchievementAwardSource,
) {
  await settlePendingLeaderboardPeriods();
  const metrics = await loadAchievementMetrics(userId);
  return synchronizeUserAchievements({ userId, metrics, source });
}

export async function synchronizeAchievementsForUser(
  userId: string,
  source: AchievementAwardSource = "manual",
) {
  const { records } = await refreshUserAchievements(userId, source);
  return records;
}

type BackgroundAchievementSync = {
  source: AchievementAwardSource;
  rerun: boolean;
  done: Promise<void>;
};

const backgroundAchievementSyncs = new Map<string, BackgroundAchievementSync>();

async function runBackgroundAchievementSync(
  userId: string,
  sync: BackgroundAchievementSync,
) {
  try {
    do {
      sync.rerun = false;
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a rerun has to see what the previous pass wrote
        await synchronizeAchievementsForUser(userId, sync.source);
      } catch (error) {
        console.error("Failed to synchronize achievements", {
          userId,
          source: sync.source,
          error,
        });
      }
    } while (sync.rerun);
  } finally {
    backgroundAchievementSyncs.delete(userId);
  }
}

/**
 * Synchronize a user's achievements once the triggering response is sent.
 *
 * Callers have already committed the change that made achievements stale, so a
 * failure is logged instead of thrown: an upload or a follow must not be
 * reported as failed because the award pass behind it timed out. A call for a
 * user whose pass is still running folds into one more pass after it, so
 * repeated triggers cannot stack full-history replays.
 */
export function synchronizeAchievementsInBackground(
  userId: string,
  source: AchievementAwardSource,
): Promise<void> {
  const running = backgroundAchievementSyncs.get(userId);

  if (running) {
    running.source = source;
    running.rerun = true;
    return running.done;
  }

  const sync: BackgroundAchievementSync = {
    source,
    rerun: false,
    done: Promise.resolve(),
  };
  backgroundAchievementSyncs.set(userId, sync);
  sync.done = runBackgroundAchievementSync(userId, sync);
  return sync.done;
}

/**
 * Page data for the owner's achievement views.
 *
 * Awards are issued here too, but a failed award pass falls back to the awards
 * already stored instead of failing the page: the owner still sees current
 * progress, and the next upload or visit retries the pass.
 */
async function loadAchievementsPageData(
  userId: string,
): Promise<AchievementsPageData> {
  await settlePendingLeaderboardPeriods();
  const metrics = await loadAchievementMetrics(userId);

  try {
    const { pageData } = await synchronizeUserAchievements({
      userId,
      metrics,
      source: "manual",
    });
    return pageData;
  } catch (error) {
    console.error("Failed to synchronize achievements for a page view", {
      userId,
      error,
    });
  }

  const stored = toStoredAchievementRecords(
    await prisma.userAchievement.findMany({ where: { userId } }),
  );

  return buildAchievementsPageDataFromStatuses({
    metrics,
    achievements: mergeAchievementRecords(
      buildAchievementStatuses(metrics),
      new Map(stored.map((record) => [record.code, record])),
    ),
  });
}

export async function getAchievementsPageData(
  userId: string,
): Promise<AchievementsPageData> {
  return loadAchievementsPageData(userId);
}

type ProfileArenaSummary = {
  score: number;
  level: number;
  totalActiveDays: number | null;
};

/**
 * Read a profile's score without issuing awards or replaying usage history.
 * Missing or older summaries use the per-code achievement counts, whose size
 * does not grow with the award ledger. Only achievement synchronization writes
 * the summary; a public read must not overwrite a concurrent synchronization.
 */
export async function getArenaSummaryForProfile(
  userId: string,
): Promise<ProfileArenaSummary> {
  const stored = await prisma.userArenaSummary.findUnique({
    where: { userId },
  });

  let score = stored?.score ?? 0;
  let level = stored?.level ?? getArenaLevelFromScore(score);
  const hasNewAchievement = stored
    ? await prisma.userAchievement.findFirst({
        where: { userId, updatedAt: { gt: stored.computedAt } },
        select: { code: true },
      })
    : null;

  if (!stored || hasNewAchievement) {
    const achievements = await prisma.userAchievement.findMany({
      where: { userId },
      select: { code: true, awardCount: true },
    });
    score = achievements.reduce(
      (sum, achievement) =>
        sum +
        (achievementDefinitionMap.get(achievement.code as AchievementCode)
          ?.points ?? 0) *
          achievement.awardCount,
      0,
    );
    level = getArenaLevelFromScore(score);
  }

  return {
    score,
    level,
    totalActiveDays: stored?.totalActiveDays ?? null,
  };
}

export async function getAchievementNotificationData(
  userId: string,
): Promise<AchievementNotificationData> {
  return buildAchievementNotificationData(
    await loadAchievementsPageData(userId),
  );
}
