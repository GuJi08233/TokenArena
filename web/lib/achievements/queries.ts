import "server-only";

import { finalizePendingLeaderboardPeriods } from "@/lib/leaderboard/finalize";
import { getUserGlobalLeaderboardRanksByTotalTokens } from "@/lib/leaderboard/rank";
import type { PricingCatalog } from "@/lib/pricing/catalog";
import { getPricingCatalog } from "@/lib/pricing/catalog";
import {
  estimateCostUsd,
  resolveOfficialPricingMatch,
} from "@/lib/pricing/resolve";
import { prisma } from "@/lib/prisma";
import { tokenCountToNumber } from "@/lib/token-counts";
import { resolveDashboardRange } from "@/lib/usage/date-range";
import { formatDateInput } from "@/lib/usage/format";
import { getUsagePreference } from "@/lib/usage/preferences";
import type { UsageShareCardPersona } from "@/lib/usage/share-card";
import type { AchievementAwardSource } from "../../generated/prisma/client";
import {
  type AchievementInputMetrics,
  buildAchievementNotificationData,
  buildAchievementStatuses,
  buildAchievementsPageDataFromStatuses,
} from "./evaluate";
import {
  buildAchievementAwardPlan,
  mergeAchievementRecords,
  type StoredAchievementRecord,
} from "./records";
import {
  addTimelineValue,
  finalizeDistinctTimeline,
  finalizeTimeline,
  recordDistinctTimelineKey,
} from "./timeline";
import type {
  AchievementNotificationData,
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

function buildAllTimeMetrics(input: {
  timezone: string;
  buckets: Array<{
    bucketStart: Date;
    totalTokens: number | bigint;
    inputTokens: number | bigint;
    outputTokens: number | bigint;
    reasoningTokens: number | bigint;
    cachedTokens: number | bigint;
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
    };
    const estimatedCostUsd = estimateBucketCostUsd(
      {
        model: bucket.model,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        reasoningTokens: normalized.reasoningTokens,
        cachedTokens: normalized.cachedTokens,
      },
      input.catalog,
    );

    addTimelineValue(tokenValuesByTimestamp, at, normalized.totalTokens);
    addTimelineValue(costValuesByTimestamp, at, estimatedCostUsd);
    recordDistinctTimelineKey(firstModelTimestamp, bucket.model, at);
    recordDistinctTimelineKey(firstToolTimestamp, bucket.source, at);
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

async function synchronizeUserAchievements(input: {
  userId: string;
  metrics: AchievementInputMetrics;
  source: AchievementAwardSource;
}) {
  const existingRows = await prisma.userAchievement.findMany({
    where: {
      userId: input.userId,
    },
  });
  const existingRecords = existingRows.reduce<StoredAchievementRecord[]>(
    (acc, row) => {
      const record = normalizeStoredAchievementRecord(row);
      if (record) acc.push(record);
      return acc;
    },
    [],
  );
  const plan = buildAchievementAwardPlan({
    userId: input.userId,
    evaluatedAt: new Date().toISOString(),
    source: input.source,
    statuses: buildAchievementStatuses(input.metrics),
    records: existingRecords,
  });
  const existingCodes = new Set(existingRecords.map((record) => record.code));

  if (plan.awards.length > 0 || plan.records.size > 0) {
    await prisma.$transaction(async (tx) => {
      if (plan.awards.length > 0) {
        await tx.achievementAward.createMany({
          data: plan.awards.map((award) => ({
            userId: award.userId,
            code: award.code,
            awardedAt: new Date(award.awardedAt),
            source: award.source,
            dedupeKey: award.dedupeKey,
            pointsAwarded: award.pointsAwarded,
            progressValue: award.progressValue,
            thresholdValue: award.thresholdValue,
            context: award.context,
          })),
          skipDuplicates: true,
        });
      }

      await Promise.all(
        Array.from(plan.records.values()).map(async (record) => {
          if (record.awardCount === 0 && !existingCodes.has(record.code)) {
            return;
          }

          await tx.userAchievement.upsert({
            where: {
              userId_code: {
                userId: input.userId,
                code: record.code,
              },
            },
            update: {
              awardCount: record.awardCount,
              firstAwardedAt: record.firstAwardedAt
                ? new Date(record.firstAwardedAt)
                : null,
              lastAwardedAt: record.lastAwardedAt
                ? new Date(record.lastAwardedAt)
                : null,
              ...(record.state ? { state: record.state } : {}),
            },
            create: {
              userId: input.userId,
              code: record.code,
              awardCount: record.awardCount,
              firstAwardedAt: record.firstAwardedAt
                ? new Date(record.firstAwardedAt)
                : null,
              lastAwardedAt: record.lastAwardedAt
                ? new Date(record.lastAwardedAt)
                : null,
              ...(record.state ? { state: record.state } : {}),
            },
          });
        }),
      );
    });
  }

  return plan.records;
}

export async function synchronizeAchievementsForUser(
  userId: string,
  source: AchievementAwardSource = "manual",
) {
  await finalizePendingLeaderboardPeriods();
  const metrics = await loadAchievementMetrics(userId);
  return synchronizeUserAchievements({
    userId,
    metrics,
    source,
  });
}

export async function getAchievementsPageData(
  userId: string,
): Promise<AchievementsPageData> {
  await finalizePendingLeaderboardPeriods();
  const metrics = await loadAchievementMetrics(userId);
  const records = await synchronizeUserAchievements({
    userId,
    metrics,
    source: "manual",
  });
  return buildAchievementsPageDataFromStatuses({
    metrics,
    achievements: mergeAchievementRecords(
      buildAchievementStatuses(metrics),
      records,
    ),
  });
}

export async function getAchievementArenaSummary(userId: string): Promise<{
  score: number;
  level: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
  totalActiveSeconds: number;
  totalSessions: number;
  totalActiveDays: number;
}> {
  await finalizePendingLeaderboardPeriods();
  const metrics = await loadAchievementMetrics(userId);
  const records = await synchronizeUserAchievements({
    userId,
    metrics,
    source: "manual",
  });
  const pageData = buildAchievementsPageDataFromStatuses({
    metrics,
    achievements: mergeAchievementRecords(
      buildAchievementStatuses(metrics),
      records,
    ),
  });
  return {
    score: pageData.summary.score,
    level: pageData.summary.level,
    totalTokens: metrics.totalTokens,
    totalEstimatedCostUsd: metrics.totalEstimatedCostUsd,
    totalActiveSeconds: metrics.totalActiveSeconds,
    totalSessions: metrics.totalSessions,
    totalActiveDays: pageData.summary.totalActiveDays,
  };
}

export async function getAchievementNotificationData(
  userId: string,
): Promise<AchievementNotificationData> {
  await finalizePendingLeaderboardPeriods();
  const metrics = await loadAchievementMetrics(userId);
  const records = await synchronizeUserAchievements({
    userId,
    metrics,
    source: "manual",
  });
  return buildAchievementNotificationData(
    buildAchievementsPageDataFromStatuses({
      metrics,
      achievements: mergeAchievementRecords(
        buildAchievementStatuses(metrics),
        records,
      ),
    }),
  );
}
