import { describe, expect, it, vi } from "vitest";
import {
  collectAffectedLeaderboardDates,
  expireLeaderboardSnapshots,
  findExistingSessionStartDates,
  invalidateLeaderboardSnapshots,
  recomputeLeaderboardUserDays,
} from "./aggregates";

const mocks = vi.hoisted(() => ({
  prisma: {
    usageSession: {
      findMany: vi.fn(),
    },
    usageBucket: {
      findMany: vi.fn(),
    },
    leaderboardUserDay: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    leaderboardSnapshot: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

describe("collectAffectedLeaderboardDates", () => {
  it("deduplicates and sorts bucket, session, and previous session dates by Shanghai day", () => {
    const dates = collectAffectedLeaderboardDates({
      bucketStarts: ["2026-03-28T02:00:00.000Z", "2026-03-28T18:00:00.000Z"],
      sessionStarts: ["2026-03-29T01:00:00.000Z"],
      existingSessionStarts: ["2026-03-27T23:59:59.000Z"],
    });

    expect(dates.map((value) => value.toISOString())).toEqual([
      "2026-03-27T16:00:00.000Z",
      "2026-03-28T16:00:00.000Z",
    ]);
  });
});

describe("findExistingSessionStartDates", () => {
  it("returns an empty array when sessions list is empty", async () => {
    const db = {
      usageSession: { findMany: vi.fn() },
    };

    const result = await findExistingSessionStartDates(db, {
      userId: "user-1",
      deviceId: "device-1",
      sessions: [],
    });

    expect(result).toEqual([]);
    expect(db.usageSession.findMany).not.toHaveBeenCalled();
  });

  it("queries sessions and returns firstMessageAt dates", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { firstMessageAt: new Date("2026-03-28T02:00:00.000Z") },
        { firstMessageAt: new Date("2026-03-29T10:00:00.000Z") },
      ]);
    const db = {
      usageSession: { findMany },
    };

    const result = await findExistingSessionStartDates(db, {
      userId: "user-1",
      deviceId: "device-1",
      sessions: [
        { source: "claude", sessionHash: "abc123" },
        { source: "claude", sessionHash: "def456" },
      ],
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        deviceId: "device-1",
        OR: [
          { source: "claude", sessionHash: "abc123" },
          { source: "claude", sessionHash: "def456" },
        ],
      },
      select: { firstMessageAt: true },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(new Date("2026-03-28T02:00:00.000Z"));
    expect(result[1]).toEqual(new Date("2026-03-29T10:00:00.000Z"));
  });
});

describe("invalidateLeaderboardSnapshots", () => {
  // 2026-03-25 is a Wednesday, so the week window opens on the 23rd.
  const now = new Date("2026-03-25T06:00:00.000Z");
  // TTL (5min) minus the min lifetime (30s) before `now`.
  const staleGeneratedAt = new Date("2026-03-25T05:55:30.000Z");

  function createDb() {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    return {
      db: { leaderboardSnapshot: { updateMany, deleteMany } },
      updateMany,
      deleteMany,
    };
  }

  it("ages only the periods whose window covers the changed day", async () => {
    const { db, updateMany } = createDb();

    await invalidateLeaderboardSnapshots(db, {
      dates: [new Date("2026-03-25T04:00:00.000Z")],
      now,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        period: { in: ["day", "week", "month", "all_time"] },
        generatedAt: { gt: staleGeneratedAt },
      },
      data: { generatedAt: staleGeneratedAt },
    });
  });

  it("leaves the bounded periods alone when a sync only backfills history", async () => {
    const { db, updateMany } = createDb();

    await invalidateLeaderboardSnapshots(db, {
      dates: [new Date("2024-01-05T04:00:00.000Z")],
      now,
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          period: { in: ["all_time"] },
        }),
      }),
    );
  });

  it("does not touch snapshots when nothing changed", async () => {
    const { db, updateMany } = createDb();

    await invalidateLeaderboardSnapshots(db, { dates: [], now });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never ages a snapshot that is already past the stale mark", async () => {
    const { db, updateMany } = createDb();

    await invalidateLeaderboardSnapshots(db, {
      dates: [new Date("2026-03-25T04:00:00.000Z")],
      now,
    });

    const [call] = updateMany.mock.calls;
    expect(call[0].where.generatedAt).toEqual({ gt: staleGeneratedAt });
  });
});

describe("expireLeaderboardSnapshots", () => {
  it("deletes every snapshot so a visibility change applies at once", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });

    await expireLeaderboardSnapshots({
      leaderboardSnapshot: { deleteMany, updateMany },
    });

    expect(deleteMany).toHaveBeenCalledWith({});
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("recomputeLeaderboardUserDays", () => {
  function createMockDb(overrides: Record<string, unknown> = {}) {
    return {
      usageBucket: {
        findMany: vi.fn().mockResolvedValue([]),
        ...((overrides.usageBucket as Record<string, unknown>) ?? {}),
      },
      usageSession: {
        findMany: vi.fn().mockResolvedValue([]),
        ...((overrides.usageSession as Record<string, unknown>) ?? {}),
      },
      leaderboardUserDay: {
        upsert: vi.fn().mockResolvedValue(undefined),
        deleteMany: vi.fn().mockResolvedValue(undefined),
        ...((overrides.leaderboardUserDay as Record<string, unknown>) ?? {}),
      },
      leaderboardSnapshot: {
        updateMany: vi.fn().mockResolvedValue(undefined),
        deleteMany: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  it("returns early when dates array is empty", async () => {
    const db = createMockDb();

    await recomputeLeaderboardUserDays(db, {
      userId: "user-1",
      dates: [],
    });

    expect(db.usageBucket.findMany).not.toHaveBeenCalled();
    expect(db.usageSession.findMany).not.toHaveBeenCalled();
  });

  it("accumulates buckets and sessions into leaderboard user days", async () => {
    const bucketStart = new Date("2026-03-28T00:00:00.000Z");
    const firstMessageAt = new Date("2026-03-28T05:00:00.000Z");

    const db = createMockDb({
      usageBucket: {
        findMany: vi.fn().mockResolvedValue([
          {
            bucketStart,
            inputTokens: BigInt(1000),
            outputTokens: BigInt(500),
            reasoningTokens: BigInt(200),
            cachedTokens: BigInt(100),
            cacheCreationTokens: BigInt(0),
            totalTokens: BigInt(1800),
          },
        ]),
      },
      usageSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            firstMessageAt,
            activeSeconds: 120,
            messageCount: 10,
            userMessageCount: 5,
          },
        ]),
      },
    });

    await recomputeLeaderboardUserDays(db, {
      userId: "user-1",
      dates: [bucketStart],
    });

    expect(db.leaderboardUserDay.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = db.leaderboardUserDay.upsert.mock.calls[0][0];
    expect(upsertArg.update.inputTokens).toBe(BigInt(1000));
    expect(upsertArg.update.outputTokens).toBe(BigInt(500));
    expect(upsertArg.update.activeSeconds).toBe(120);
    expect(upsertArg.update.sessions).toBe(1);
    expect(upsertArg.update.messages).toBe(10);
    expect(upsertArg.update.userMessages).toBe(5);
  });

  it("deletes leaderboard user days when no data exists for a date", async () => {
    const dateWithData = new Date("2026-03-28T00:00:00.000Z");
    const dateWithoutData = new Date("2026-03-29T00:00:00.000Z");

    const db = createMockDb({
      usageBucket: {
        findMany: vi.fn().mockResolvedValue([
          {
            bucketStart: dateWithData,
            inputTokens: BigInt(500),
            outputTokens: BigInt(200),
            reasoningTokens: BigInt(0),
            cachedTokens: BigInt(0),
            cacheCreationTokens: BigInt(0),
            totalTokens: BigInt(700),
          },
        ]),
      },
      usageSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            firstMessageAt: dateWithData,
            activeSeconds: 60,
            messageCount: 5,
            userMessageCount: 3,
          },
        ]),
      },
    });

    await recomputeLeaderboardUserDays(db, {
      userId: "user-1",
      dates: [dateWithData, dateWithoutData],
    });

    // dateWithData has data -> upsert
    expect(db.leaderboardUserDay.upsert).toHaveBeenCalledTimes(1);
    // dateWithoutData has no data -> deleteMany
    expect(db.leaderboardUserDay.deleteMany).toHaveBeenCalledTimes(1);
    const deleteArg = db.leaderboardUserDay.deleteMany.mock.calls[0][0];
    expect(deleteArg.where.userId).toBe("user-1");
  });

  it("reads only affected days when their dates are far apart", async () => {
    const older = new Date("2024-01-01T16:00:00.000Z");
    const newer = new Date("2026-09-22T16:00:00.000Z");
    const db = createMockDb({
      usageBucket: {
        findMany: vi.fn().mockResolvedValue([
          {
            bucketStart: older,
            inputTokens: BigInt(1),
            outputTokens: BigInt(0),
            reasoningTokens: BigInt(0),
            cachedTokens: BigInt(0),
            cacheCreationTokens: BigInt(0),
            totalTokens: BigInt(1),
          },
        ]),
      },
      usageSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            firstMessageAt: newer,
            activeSeconds: 10,
            messageCount: 2,
            userMessageCount: 1,
          },
        ]),
      },
    });

    await recomputeLeaderboardUserDays(db, {
      userId: "user-1",
      dates: [newer, older],
    });

    const ranges = [
      { gte: older, lt: new Date("2024-01-02T16:00:00.000Z") },
      { gte: newer, lt: new Date("2026-09-23T16:00:00.000Z") },
    ];
    expect(db.usageBucket.findMany.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      OR: ranges.map((range) => ({ bucketStart: range })),
    });
    expect(db.usageSession.findMany.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      OR: ranges.map((range) => ({ firstMessageAt: range })),
    });
    expect(
      db.leaderboardUserDay.upsert.mock.calls.map(
        ([{ where }]) => where.userId_statDate.statDate,
      ),
    ).toEqual([older, newer]);
  });

  it("handles multi-date scenario with data across several days", async () => {
    const day1 = new Date("2026-03-27T16:00:00.000Z");
    const day2 = new Date("2026-03-28T16:00:00.000Z");
    const day3 = new Date("2026-03-29T16:00:00.000Z");

    const db = createMockDb({
      usageBucket: {
        findMany: vi.fn().mockResolvedValue([
          {
            bucketStart: day1,
            inputTokens: BigInt(100),
            outputTokens: BigInt(50),
            reasoningTokens: BigInt(0),
            cachedTokens: BigInt(0),
            cacheCreationTokens: BigInt(0),
            totalTokens: BigInt(150),
          },
          {
            bucketStart: day2,
            inputTokens: BigInt(200),
            outputTokens: BigInt(100),
            reasoningTokens: BigInt(10),
            cachedTokens: BigInt(5),
            cacheCreationTokens: BigInt(0),
            totalTokens: BigInt(315),
          },
        ]),
      },
      usageSession: {
        findMany: vi.fn().mockResolvedValue([
          {
            firstMessageAt: day1,
            activeSeconds: 30,
            messageCount: 3,
            userMessageCount: 2,
          },
          {
            firstMessageAt: day2,
            activeSeconds: 60,
            messageCount: 8,
            userMessageCount: 4,
          },
        ]),
      },
    });

    await recomputeLeaderboardUserDays(db, {
      userId: "user-1",
      dates: [day1, day2, day3],
    });

    // day1 and day2 have data -> upsert; day3 has no data -> deleteMany
    expect(db.leaderboardUserDay.upsert).toHaveBeenCalledTimes(2);
    expect(db.leaderboardUserDay.deleteMany).toHaveBeenCalledTimes(1);
  });
});
