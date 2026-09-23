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
    $executeRaw: vi.fn().mockResolvedValue(1),
    device: { upsert: vi.fn().mockResolvedValue({}) },
    usageApiKey: { update: vi.fn().mockResolvedValue({}) },
    usageBucket: { upsert: vi.fn().mockResolvedValue({}) },
    usageSession: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

/**
 * Bound parameters across every `$executeRaw` call.
 *
 * Buckets and sessions are written as tagged-template statements now, so the
 * values that used to be asserted on a Prisma `upsert` argument live in the
 * statement's parameter list.
 */
function boundValues(executeRaw: ReturnType<typeof vi.fn>): unknown[] {
  return executeRaw.mock.calls.flatMap(([statement]) => statement.values);
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
    const values = boundValues(tx.$executeRaw);

    expect(values).toContain(BigInt(100));
    expect(values).toContain(BigInt(200));
    expect(values).toContain(BigInt(30));
    // Both rows total 380: the bucket re-derives it from the parts rather than
    // trusting the payload's 350, and the session sums modelUsages.
    expect(values.filter((value) => value === BigInt(380))).toHaveLength(2);
  });

  it("collapses duplicate buckets to the last one, as row-wise upserts did", async () => {
    const tx = buildTransactionClient();
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(tx),
    );
    const base = {
      source: "codex",
      model: "gpt-5.4",
      projectKey: "project-a",
      projectLabel: "Project A",
      bucketStart: "2026-04-01T12:00:00.000Z",
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    };
    const payload = ingestRequestSchema.parse({
      ...buildPayload(false),
      buckets: [
        { ...base, inputTokens: 11 },
        // Same conflict target, different value — Postgres would reject a
        // statement that tried to update this row twice.
        { ...base, inputTokens: 22 },
      ],
    });

    await ingestUsagePayload({ userId: "user-1", payload });
    const values = boundValues(tx.$executeRaw);

    expect(values).toContain(BigInt(22));
    expect(values).not.toContain(BigInt(11));
  });

  it.each([
    {
      name: "usage followed by metadata only",
      rows: [{ inputTokens: 11 }, {}],
      expectedTokens: 11,
    },
    {
      name: "metadata only followed by usage",
      rows: [{}, { inputTokens: 22 }],
      expectedTokens: 22,
    },
    {
      name: "the latest usage followed by metadata only",
      rows: [{ inputTokens: 11 }, { inputTokens: 22 }, {}],
      expectedTokens: 22,
    },
    {
      name: "metadata only duplicates",
      rows: [{}, {}],
      expectedTokens: null,
    },
  ])("keeps $name for duplicate sessions", async ({ rows, expectedTokens }) => {
    const tx = buildTransactionClient();
    mocks.prisma.$transaction.mockImplementation(async (callback) =>
      callback(tx),
    );
    const base = {
      source: "codex",
      projectKey: "project-a",
      sessionHash: "duplicate-session",
      firstMessageAt: "2026-04-01T12:00:00.000Z",
      lastMessageAt: "2026-04-01T12:10:00.000Z",
      durationSeconds: 600,
      activeSeconds: 420,
      messageCount: 8,
      userMessageCount: 3,
    };
    const payload = ingestRequestSchema.parse({
      ...buildPayload(false),
      sessions: rows.map((row, index) => ({
        ...base,
        projectLabel: `Project ${index}`,
        messageCount: index + 1,
        ...row,
      })),
    });

    await ingestUsagePayload({ userId: "user-1", payload });

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    const [statement] = tx.$executeRaw.mock.calls[0];
    if (expectedTokens === null) {
      expect(statement.sql).not.toContain(
        '"totalTokens" = EXCLUDED."totalTokens"',
      );
    } else {
      expect(statement.sql).toContain('"totalTokens" = EXCLUDED."totalTokens"');
      expect(statement.values).toContain(BigInt(expectedTokens));
    }
    expect(statement.values).toContain(`Project ${rows.length - 1}`);
    expect(statement.values).toContain(rows.length);
    if (expectedTokens === 22 && rows.length === 3) {
      expect(statement.values).not.toContain(BigInt(11));
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
    const values = boundValues(tx.$executeRaw);

    // Cache-creation tokens alone still count toward the session total.
    expect(values.filter((value) => value === BigInt(30))).toHaveLength(2);
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
    // The 25 buckets share one conflict key and collapse into a single row, and
    // both tables are written with one statement each rather than per row.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
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
