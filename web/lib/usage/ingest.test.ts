import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synchronizeAchievementsForUser: vi.fn().mockResolvedValue([]),
  getPricingCatalog: vi.fn().mockResolvedValue([]),
  collectAffectedLeaderboardDates: vi.fn((): Date[] => []),
  findExistingSessionStartDates: vi.fn().mockResolvedValue([]),
  invalidateLeaderboardSnapshots: vi.fn().mockResolvedValue(undefined),
  recomputeLeaderboardUserDays: vi.fn().mockResolvedValue(undefined),
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/achievements/queries", () => ({
  synchronizeAchievementsForUser: mocks.synchronizeAchievementsForUser,
}));
vi.mock("@/lib/pricing/catalog", () => ({
  getPricingCatalog: mocks.getPricingCatalog,
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/leaderboard/aggregates", () => ({
  collectAffectedLeaderboardDates: mocks.collectAffectedLeaderboardDates,
  findExistingSessionStartDates: mocks.findExistingSessionStartDates,
  invalidateLeaderboardSnapshots: mocks.invalidateLeaderboardSnapshots,
  recomputeLeaderboardUserDays: mocks.recomputeLeaderboardUserDays,
}));

import { ingestRequestSchema } from "./contracts";
import { ingestUsagePayload } from "./ingest";

function buildPayload(syncAchievements?: boolean) {
  return ingestRequestSchema.parse({
    schemaVersion: 2,
    device: {
      deviceId: "device-1234",
      hostname: "macbook-pro",
    },
    buckets: [],
    sessions: [],
    ...(syncAchievements === undefined ? {} : { syncAchievements }),
  });
}

function buildTransactionClient() {
  return {
    device: { upsert: vi.fn().mockResolvedValue({}) },
    usageApiKey: { update: vi.fn().mockResolvedValue({}) },
    usageBucket: { upsert: vi.fn().mockResolvedValue({}) },
    usageSession: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

describe("ingestUsagePayload achievement synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPricingCatalog.mockResolvedValue(null);
    mocks.collectAffectedLeaderboardDates.mockReturnValue([]);
    mocks.findExistingSessionStartDates.mockResolvedValue([]);
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(buildTransactionClient()),
    );
  });

  it("persists cache writes in buckets and derives session totals from model usage", async () => {
    const tx = buildTransactionClient();
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(tx),
    );
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cachedTokens: 200,
      cacheCreationTokens: 30,
    };
    const payload = ingestRequestSchema.parse({
      ...buildPayload(false),
      buckets: [
        {
          ...usage,
          source: "claude-code",
          model: "claude-sonnet-4",
          projectKey: "project",
          projectLabel: "Project",
          bucketStart: "2026-09-21T10:00:00.000Z",
          totalTokens: 350,
        },
      ],
      sessions: [
        {
          source: "claude-code",
          projectKey: "project",
          projectLabel: "Project",
          sessionHash: "session",
          firstMessageAt: "2026-09-21T10:00:00.000Z",
          lastMessageAt: "2026-09-21T10:01:00.000Z",
          durationSeconds: 60,
          activeSeconds: 30,
          messageCount: 2,
          userMessageCount: 1,
          modelUsages: [
            { model: "claude-sonnet-4", ...usage, totalTokens: 380 },
          ],
        },
      ],
    });
    await ingestUsagePayload({ userId: "user-1", payload });
    for (const upsert of [tx.usageBucket.upsert, tx.usageSession.upsert]) {
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            inputTokens: BigInt(100),
            cachedTokens: BigInt(200),
            cacheCreationTokens: BigInt(30),
            totalTokens: BigInt(380),
          }),
          update: expect.objectContaining({ cacheCreationTokens: BigInt(30) }),
        }),
      );
    }
  });

  it("keeps explicit cache-only session usage when model details are empty", async () => {
    const tx = buildTransactionClient();
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(tx),
    );
    const payload = ingestRequestSchema.parse({
      ...buildPayload(false),
      sessions: [
        {
          source: "claude-code",
          projectKey: "project",
          projectLabel: "Project",
          sessionHash: "cache-only",
          firstMessageAt: "2026-09-21T10:00:00.000Z",
          lastMessageAt: "2026-09-21T10:00:00.000Z",
          durationSeconds: 0,
          activeSeconds: 0,
          messageCount: 1,
          userMessageCount: 0,
          cacheCreationTokens: 30,
          modelUsages: [],
        },
      ],
    });
    await ingestUsagePayload({ userId: "user-1", payload });
    expect(tx.usageSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          cacheCreationTokens: BigInt(30),
          totalTokens: BigInt(30),
        }),
        update: expect.objectContaining({
          cacheCreationTokens: BigInt(30),
          totalTokens: BigInt(30),
        }),
      }),
    );
  });

  it("keeps achievement synchronization enabled for direct API payloads", async () => {
    await ingestUsagePayload({
      userId: "user-1",
      payload: buildPayload(),
    });

    expect(mocks.synchronizeAchievementsForUser).toHaveBeenCalledWith(
      "user-1",
      "ingest",
    );
  });

  it("defers achievement synchronization when requested by a batch client", async () => {
    await ingestUsagePayload({
      userId: "user-1",
      payload: buildPayload(false),
    });

    expect(mocks.synchronizeAchievementsForUser).not.toHaveBeenCalled();
  });

  it("writes bounded batches and refreshes affected leaderboard days", async () => {
    const tx = buildTransactionClient();
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(tx),
    );
    mocks.collectAffectedLeaderboardDates.mockReturnValue([
      new Date("2026-04-01T00:00:00.000Z"),
    ]);
    const bucket = {
      source: "codex",
      model: "gpt-5.4",
      projectKey: "project-a",
      projectLabel: "Project A",
      bucketStart: "2026-04-01T12:00:00.000Z",
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 25,
      cachedTokens: 10,
      cacheCreationTokens: 0,
      totalTokens: 185,
    };
    const payload = ingestRequestSchema.parse({
      schemaVersion: 2,
      device: {
        deviceId: "device-1234",
        hostname: "macbook-pro",
      },
      buckets: Array.from({ length: 25 }, () => bucket),
      sessions: [
        {
          source: "codex",
          projectKey: "project-a",
          projectLabel: "Project A",
          sessionHash: "session-hash",
          firstMessageAt: "2026-04-01T12:00:00.000Z",
          lastMessageAt: "2026-04-01T12:10:00.000Z",
          durationSeconds: 600,
          activeSeconds: 420,
          messageCount: 8,
          userMessageCount: 3,
          primaryModel: "gpt-5.4",
          modelUsages: [
            {
              model: "gpt-5.4",
              inputTokens: 100,
              outputTokens: 50,
              reasoningTokens: 25,
              cachedTokens: 10,
              cacheCreationTokens: 0,
              totalTokens: 185,
            },
          ],
        },
      ],
      syncAchievements: false,
    });

    const result = await ingestUsagePayload({
      userId: "user-1",
      apiKeyId: "key-1",
      payload,
    });

    expect(tx.usageApiKey.update).toHaveBeenCalledOnce();
    expect(tx.usageBucket.upsert).toHaveBeenCalledTimes(25);
    expect(tx.usageSession.upsert).toHaveBeenCalledOnce();
    expect(mocks.recomputeLeaderboardUserDays).toHaveBeenCalledOnce();
    expect(mocks.invalidateLeaderboardSnapshots).toHaveBeenCalledOnce();
    expect(mocks.synchronizeAchievementsForUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      bucketCount: 25,
      sessionCount: 1,
      deviceId: "device-1234",
    });
  });
});
