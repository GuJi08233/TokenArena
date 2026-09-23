import { randomUUID } from "node:crypto";
import { synchronizeAchievementsForUser } from "@/lib/achievements/queries";
import {
  collectAffectedLeaderboardDates,
  findExistingSessionStartDates,
  invalidateLeaderboardSnapshots,
  recomputeLeaderboardUserDays,
} from "@/lib/leaderboard/aggregates";
import { getPricingCatalog } from "@/lib/pricing/catalog";
import {
  estimateCostUsd,
  resolveOfficialPricingMatch,
} from "@/lib/pricing/resolve";
import { prisma } from "@/lib/prisma";
import { tokenCountToBigInt } from "@/lib/token-counts";
import { Prisma } from "../../generated/prisma/client";
import type { ingestRequestSchema } from "./contracts";

type IngestPayload = ReturnType<typeof ingestRequestSchema.parse>;
type UsageWriteClient = Pick<
  typeof prisma,
  | "$executeRaw"
  | "device"
  | "usageApiKey"
  | "usageBucket"
  | "usageSession"
  | "leaderboardUserDay"
  | "leaderboardSnapshot"
>;

type UpsertDeviceInput = {
  userId: string;
  apiKeyId?: string | null;
  device: IngestPayload["device"];
  seenAt: Date;
};

type IngestUsagePayloadInput = {
  userId: string;
  apiKeyId?: string | null;
  payload: IngestPayload;
};

type DeleteUsageDeviceSnapshotInput = {
  userId: string;
  deviceId: string;
};

type NormalizedSessionUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  primaryModel: string;
  estimatedCostUsd: number | null;
};

/**
 * Keep the last write for each conflict target.
 *
 * Row-at-a-time upserts let a later duplicate overwrite an earlier one. A single
 * `ON CONFLICT` statement cannot touch the same row twice, so the same
 * last-one-wins collapse has to happen before the statement is built.
 */
function dedupeByConflictKey<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();

  for (const item of items) {
    byKey.set(key(item), item);
  }

  return Array.from(byKey.values());
}

/**
 * Bind a timestamp as an explicit UTC literal.
 *
 * `DateTime` lives in a `timestamp(3)` column — no time zone — holding the UTC
 * wall-clock value, and `::timestamp` ignores any offset in its input rather
 * than applying it. An ISO string therefore casts to exactly the value Prisma
 * writes. A bound `Date` lands on the same value today because the adapter
 * serializes via `getUTC*`, but that is its internal detail; spelling the
 * intent out keeps these statements correct regardless.
 */
function toUtcTimestampLiteral(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function buildUsageSessionWriteInput(input: NormalizedSessionUsage) {
  return {
    inputTokens: tokenCountToBigInt(input.inputTokens),
    outputTokens: tokenCountToBigInt(input.outputTokens),
    reasoningTokens: tokenCountToBigInt(input.reasoningTokens),
    cachedTokens: tokenCountToBigInt(input.cachedTokens),
    cacheCreationTokens: tokenCountToBigInt(input.cacheCreationTokens),
    totalTokens: tokenCountToBigInt(input.totalTokens),
    primaryModel: input.primaryModel,
    estimatedCostUsd: input.estimatedCostUsd,
  };
}

function buildUsageBucketWriteInput(bucket: IngestPayload["buckets"][number]) {
  return {
    projectLabel: bucket.projectLabel,
    inputTokens: tokenCountToBigInt(bucket.inputTokens),
    outputTokens: tokenCountToBigInt(bucket.outputTokens),
    reasoningTokens: tokenCountToBigInt(bucket.reasoningTokens),
    cachedTokens: tokenCountToBigInt(bucket.cachedTokens),
    cacheCreationTokens: tokenCountToBigInt(bucket.cacheCreationTokens),
    totalTokens:
      tokenCountToBigInt(bucket.inputTokens) +
      tokenCountToBigInt(bucket.outputTokens) +
      tokenCountToBigInt(bucket.reasoningTokens) +
      tokenCountToBigInt(bucket.cachedTokens) +
      tokenCountToBigInt(bucket.cacheCreationTokens),
  };
}

function normalizeSessionUsage(
  session: IngestPayload["sessions"][number],
  catalog: Awaited<ReturnType<typeof getPricingCatalog>>,
): NormalizedSessionUsage | null {
  const modelUsages = session.modelUsages?.length
    ? session.modelUsages
    : undefined;
  const aggregatedFromModels = modelUsages?.reduce(
    (result, modelUsage) => {
      const modelTotalTokens =
        modelUsage.inputTokens +
        modelUsage.outputTokens +
        modelUsage.reasoningTokens +
        modelUsage.cachedTokens +
        (modelUsage.cacheCreationTokens ?? 0);

      result.inputTokens += modelUsage.inputTokens;
      result.outputTokens += modelUsage.outputTokens;
      result.reasoningTokens += modelUsage.reasoningTokens;
      result.cachedTokens += modelUsage.cachedTokens;
      result.cacheCreationTokens += modelUsage.cacheCreationTokens ?? 0;
      result.totalTokens += modelTotalTokens;

      const match = resolveOfficialPricingMatch(catalog, modelUsage.model);
      const estimate = estimateCostUsd(
        {
          inputTokens: modelUsage.inputTokens,
          outputTokens: modelUsage.outputTokens,
          reasoningTokens: modelUsage.reasoningTokens,
          cachedTokens: modelUsage.cachedTokens,
          cacheCreationTokens: modelUsage.cacheCreationTokens ?? 0,
        },
        match?.cost,
      );

      if (estimate) {
        result.estimatedCostUsd += estimate.totalUsd;
        result.hasPricedModel = true;
      }

      return result;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      hasPricedModel: false,
    },
  );

  const hasExplicitUsage =
    session.inputTokens !== undefined ||
    session.outputTokens !== undefined ||
    session.reasoningTokens !== undefined ||
    session.cachedTokens !== undefined ||
    session.cacheCreationTokens !== undefined ||
    session.totalTokens !== undefined;

  if (!aggregatedFromModels && !hasExplicitUsage) {
    return null;
  }

  if (aggregatedFromModels) {
    return {
      inputTokens: aggregatedFromModels.inputTokens,
      outputTokens: aggregatedFromModels.outputTokens,
      reasoningTokens: aggregatedFromModels.reasoningTokens,
      cachedTokens: aggregatedFromModels.cachedTokens,
      cacheCreationTokens: aggregatedFromModels.cacheCreationTokens ?? 0,
      totalTokens: aggregatedFromModels.totalTokens,
      primaryModel:
        session.primaryModel ?? session.modelUsages?.[0]?.model ?? "",
      estimatedCostUsd: aggregatedFromModels.hasPricedModel
        ? aggregatedFromModels.estimatedCostUsd
        : null,
    };
  }

  const inputTokens = session.inputTokens ?? 0;
  const outputTokens = session.outputTokens ?? 0;
  const reasoningTokens = session.reasoningTokens ?? 0;
  const cachedTokens = session.cachedTokens ?? 0;
  const cacheCreationTokens = session.cacheCreationTokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheCreationTokens,
    totalTokens:
      session.totalTokens ??
      inputTokens +
        outputTokens +
        reasoningTokens +
        cachedTokens +
        cacheCreationTokens,
    primaryModel: session.primaryModel ?? "",
    estimatedCostUsd: null,
  };
}

async function upsertDevice(db: UsageWriteClient, input: UpsertDeviceInput) {
  return db.device.upsert({
    where: {
      userId_deviceId: {
        userId: input.userId,
        deviceId: input.device.deviceId,
      },
    },
    update: {
      hostname: input.device.hostname,
      lastSeenAt: input.seenAt,
      lastApiKeyId: input.apiKeyId ?? undefined,
    },
    create: {
      userId: input.userId,
      deviceId: input.device.deviceId,
      hostname: input.device.hostname,
      lastSeenAt: input.seenAt,
      lastApiKeyId: input.apiKeyId ?? undefined,
    },
  });
}

/**
 * Write every bucket in the payload with one `INSERT ... ON CONFLICT`.
 *
 * Prisma serializes interactive-transaction queries onto a single connection,
 * so a per-row upsert cost one round trip each — a full batch spent hundreds of
 * them inside the transaction timeout.
 */
async function upsertBuckets(
  db: UsageWriteClient,
  input: IngestUsagePayloadInput,
) {
  const buckets = dedupeByConflictKey(
    input.payload.buckets,
    (bucket) =>
      `${bucket.source}\u0000${bucket.model}\u0000${bucket.projectKey}\u0000${new Date(
        bucket.bucketStart,
      ).toISOString()}`,
  );

  if (buckets.length === 0) {
    return;
  }

  const nowLiteral = toUtcTimestampLiteral(new Date());
  const apiKeyId = input.apiKeyId ?? null;
  const rows = buckets.map((bucket) => {
    const write = buildUsageBucketWriteInput(bucket);

    return Prisma.sql`(
      ${randomUUID()}::text,
      ${bucket.source}::text,
      ${bucket.model}::text,
      ${bucket.projectKey}::text,
      ${write.projectLabel}::text,
      ${toUtcTimestampLiteral(bucket.bucketStart)}::timestamp(3),
      ${write.inputTokens}::bigint,
      ${write.outputTokens}::bigint,
      ${write.reasoningTokens}::bigint,
      ${write.cachedTokens}::bigint,
      ${write.cacheCreationTokens}::bigint,
      ${write.totalTokens}::bigint
    )`;
  });

  await db.$executeRaw(Prisma.sql`
    INSERT INTO "UsageBucket" (
      "id", "userId", "apiKeyId", "deviceId", "source", "model", "projectKey",
      "projectLabel", "bucketStart", "inputTokens", "outputTokens",
      "reasoningTokens", "cachedTokens", "cacheCreationTokens", "totalTokens",
      "createdAt", "updatedAt"
    )
    SELECT
      v."id",
      ${input.userId}::text,
      ${apiKeyId}::text,
      ${input.payload.device.deviceId}::text,
      v."source", v."model", v."projectKey", v."projectLabel", v."bucketStart",
      v."inputTokens", v."outputTokens", v."reasoningTokens", v."cachedTokens",
      v."cacheCreationTokens", v."totalTokens",
      ${nowLiteral}::timestamp(3), ${nowLiteral}::timestamp(3)
    FROM (VALUES ${Prisma.join(rows)}) AS v(
      "id", "source", "model", "projectKey", "projectLabel", "bucketStart",
      "inputTokens", "outputTokens", "reasoningTokens", "cachedTokens",
      "cacheCreationTokens", "totalTokens"
    )
    ON CONFLICT ("userId", "deviceId", "source", "model", "projectKey", "bucketStart")
    DO UPDATE SET
      -- Matches the previous \`apiKeyId: input.apiKeyId ?? undefined\`, which
      -- left the stored key untouched when the request carried none.
      "apiKeyId" = COALESCE(EXCLUDED."apiKeyId", "UsageBucket"."apiKeyId"),
      "projectLabel" = EXCLUDED."projectLabel",
      "inputTokens" = EXCLUDED."inputTokens",
      "outputTokens" = EXCLUDED."outputTokens",
      "reasoningTokens" = EXCLUDED."reasoningTokens",
      "cachedTokens" = EXCLUDED."cachedTokens",
      "cacheCreationTokens" = EXCLUDED."cacheCreationTokens",
      "totalTokens" = EXCLUDED."totalTokens",
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

const EMPTY_SESSION_USAGE = {
  inputTokens: tokenCountToBigInt(0),
  outputTokens: tokenCountToBigInt(0),
  reasoningTokens: tokenCountToBigInt(0),
  cachedTokens: tokenCountToBigInt(0),
  cacheCreationTokens: tokenCountToBigInt(0),
  totalTokens: tokenCountToBigInt(0),
  primaryModel: "",
  estimatedCostUsd: null,
} as const;

/**
 * Write one group of sessions with a single `INSERT ... ON CONFLICT`.
 *
 * `withUsage` selects the update shape. A session that carries no usage must
 * refresh only its metadata and leave the stored token counts alone — the
 * per-row upsert expressed that by omitting the fields, which a statement
 * shared with usage-carrying rows cannot do.
 */
async function upsertSessionGroup(
  db: UsageWriteClient,
  input: IngestUsagePayloadInput,
  sessions: Array<{
    session: IngestPayload["sessions"][number];
    usage: ReturnType<typeof buildUsageSessionWriteInput> | null;
  }>,
  withUsage: boolean,
) {
  if (sessions.length === 0) {
    return;
  }

  const nowLiteral = toUtcTimestampLiteral(new Date());
  const apiKeyId = input.apiKeyId ?? null;
  const rows = sessions.map(({ session, usage }) => {
    const write = usage ?? EMPTY_SESSION_USAGE;

    return Prisma.sql`(
      ${randomUUID()}::text,
      ${session.source}::text,
      ${session.projectKey}::text,
      ${session.projectLabel}::text,
      ${session.sessionHash}::text,
      ${toUtcTimestampLiteral(session.firstMessageAt)}::timestamp(3),
      ${toUtcTimestampLiteral(session.lastMessageAt)}::timestamp(3),
      ${session.durationSeconds}::integer,
      ${session.activeSeconds}::integer,
      ${session.messageCount}::integer,
      ${session.userMessageCount}::integer,
      ${write.inputTokens}::bigint,
      ${write.outputTokens}::bigint,
      ${write.reasoningTokens}::bigint,
      ${write.cachedTokens}::bigint,
      ${write.cacheCreationTokens}::bigint,
      ${write.totalTokens}::bigint,
      ${write.primaryModel}::text,
      ${write.estimatedCostUsd}::double precision
    )`;
  });

  const usageUpdates = withUsage
    ? Prisma.sql`,
      "inputTokens" = EXCLUDED."inputTokens",
      "outputTokens" = EXCLUDED."outputTokens",
      "reasoningTokens" = EXCLUDED."reasoningTokens",
      "cachedTokens" = EXCLUDED."cachedTokens",
      "cacheCreationTokens" = EXCLUDED."cacheCreationTokens",
      "totalTokens" = EXCLUDED."totalTokens",
      "primaryModel" = EXCLUDED."primaryModel",
      "estimatedCostUsd" = EXCLUDED."estimatedCostUsd"`
    : Prisma.empty;

  await db.$executeRaw(Prisma.sql`
    INSERT INTO "UsageSession" (
      "id", "userId", "apiKeyId", "deviceId", "source", "projectKey",
      "projectLabel", "sessionHash", "firstMessageAt", "lastMessageAt",
      "durationSeconds", "activeSeconds", "messageCount", "userMessageCount",
      "inputTokens", "outputTokens", "reasoningTokens", "cachedTokens",
      "cacheCreationTokens", "totalTokens", "primaryModel", "estimatedCostUsd",
      "createdAt", "updatedAt"
    )
    SELECT
      v."id",
      ${input.userId}::text,
      ${apiKeyId}::text,
      ${input.payload.device.deviceId}::text,
      v."source", v."projectKey", v."projectLabel", v."sessionHash",
      v."firstMessageAt", v."lastMessageAt", v."durationSeconds",
      v."activeSeconds", v."messageCount", v."userMessageCount",
      v."inputTokens", v."outputTokens", v."reasoningTokens", v."cachedTokens",
      v."cacheCreationTokens", v."totalTokens", v."primaryModel",
      v."estimatedCostUsd",
      ${nowLiteral}::timestamp(3), ${nowLiteral}::timestamp(3)
    FROM (VALUES ${Prisma.join(rows)}) AS v(
      "id", "source", "projectKey", "projectLabel", "sessionHash",
      "firstMessageAt", "lastMessageAt", "durationSeconds", "activeSeconds",
      "messageCount", "userMessageCount", "inputTokens", "outputTokens",
      "reasoningTokens", "cachedTokens", "cacheCreationTokens", "totalTokens",
      "primaryModel", "estimatedCostUsd"
    )
    ON CONFLICT ("userId", "deviceId", "source", "sessionHash")
    DO UPDATE SET
      "apiKeyId" = COALESCE(EXCLUDED."apiKeyId", "UsageSession"."apiKeyId"),
      "projectKey" = EXCLUDED."projectKey",
      "projectLabel" = EXCLUDED."projectLabel",
      "firstMessageAt" = EXCLUDED."firstMessageAt",
      "lastMessageAt" = EXCLUDED."lastMessageAt",
      "durationSeconds" = EXCLUDED."durationSeconds",
      "activeSeconds" = EXCLUDED."activeSeconds",
      "messageCount" = EXCLUDED."messageCount",
      "userMessageCount" = EXCLUDED."userMessageCount",
      "updatedAt" = EXCLUDED."updatedAt"${usageUpdates}
  `);
}

async function upsertSessions(
  db: UsageWriteClient,
  input: IngestUsagePayloadInput,
  catalog: Awaited<ReturnType<typeof getPricingCatalog>>,
) {
  const byKey = new Map<
    string,
    {
      session: IngestPayload["sessions"][number];
      usage: ReturnType<typeof buildUsageSessionWriteInput> | null;
    }
  >();

  for (const session of input.payload.sessions) {
    const key = `${session.source}\u0000${session.sessionHash}`;
    const normalizedUsage = normalizeSessionUsage(session, catalog);
    const usage =
      normalizedUsage == null
        ? null
        : buildUsageSessionWriteInput(normalizedUsage);

    // 逐行 upsert 总是更新元数据；无 usage 的行不会覆盖先前的 token 字段。
    byKey.set(key, {
      session,
      usage: usage ?? byKey.get(key)?.usage ?? null,
    });
  }

  const sessions = Array.from(byKey.values());

  await upsertSessionGroup(
    db,
    input,
    sessions.filter((row) => row.usage !== null),
    true,
  );
  await upsertSessionGroup(
    db,
    input,
    sessions.filter((row) => row.usage === null),
    false,
  );
}

export async function deleteUsageDeviceSnapshot(
  input: DeleteUsageDeviceSnapshotInput,
) {
  const result = await prisma.$transaction(async (tx) => {
    const [existingBuckets, existingSessions] = await Promise.all([
      tx.usageBucket.findMany({
        where: {
          userId: input.userId,
          deviceId: input.deviceId,
        },
        select: {
          bucketStart: true,
        },
      }),
      tx.usageSession.findMany({
        where: {
          userId: input.userId,
          deviceId: input.deviceId,
        },
        select: {
          firstMessageAt: true,
        },
      }),
    ]);

    const affectedDates = collectAffectedLeaderboardDates({
      bucketStarts: existingBuckets.map((bucket) => bucket.bucketStart),
      sessionStarts: existingSessions.map((session) => session.firstMessageAt),
    });

    const [deletedBuckets, deletedSessions] = await Promise.all([
      tx.usageBucket.deleteMany({
        where: {
          userId: input.userId,
          deviceId: input.deviceId,
        },
      }),
      tx.usageSession.deleteMany({
        where: {
          userId: input.userId,
          deviceId: input.deviceId,
        },
      }),
    ]);

    if (affectedDates.length > 0) {
      await recomputeLeaderboardUserDays(tx, {
        userId: input.userId,
        dates: affectedDates,
      });
      await invalidateLeaderboardSnapshots(tx, { dates: affectedDates });
    }

    return {
      deletedBuckets: deletedBuckets.count,
      deletedSessions: deletedSessions.count,
    };
  });

  if (result.deletedBuckets > 0 || result.deletedSessions > 0) {
    await synchronizeAchievementsForUser(input.userId, "ingest");
  }

  return result;
}

export async function ingestUsagePayload(input: IngestUsagePayloadInput) {
  const seenAt = new Date();
  const catalog = await getPricingCatalog();

  const transactionTimeout = Number(process.env.TRANSACTION_TIMEOUT) || 5000;

  const result = await prisma.$transaction(
    async (tx) => {
      await upsertDevice(tx, {
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        device: input.payload.device,
        seenAt,
      });

      if (input.apiKeyId) {
        await tx.usageApiKey.update({
          where: { id: input.apiKeyId },
          data: { lastUsedAt: seenAt },
        });
      }

      const existingSessionStarts = await findExistingSessionStartDates(tx, {
        userId: input.userId,
        deviceId: input.payload.device.deviceId,
        sessions: input.payload.sessions.map((session) => ({
          source: session.source,
          sessionHash: session.sessionHash,
        })),
      });

      await upsertBuckets(tx, input);
      await upsertSessions(tx, input, catalog);

      const affectedDates = collectAffectedLeaderboardDates({
        bucketStarts: input.payload.buckets.map((bucket) => bucket.bucketStart),
        sessionStarts: input.payload.sessions.map(
          (session) => session.firstMessageAt,
        ),
        existingSessionStarts,
      });

      if (affectedDates.length > 0) {
        await recomputeLeaderboardUserDays(tx, {
          userId: input.userId,
          dates: affectedDates,
        });
        await invalidateLeaderboardSnapshots(tx, { dates: affectedDates });
      }

      return {
        ok: true,
        bucketCount: input.payload.buckets.length,
        sessionCount: input.payload.sessions.length,
        deviceId: input.payload.device.deviceId,
      };
    },
    { timeout: transactionTimeout },
  );

  if (input.payload.syncAchievements) {
    await synchronizeAchievementsForUser(input.userId, "ingest");
  }

  return result;
}
