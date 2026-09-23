import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finalizePendingLeaderboardPeriods: vi.fn().mockResolvedValue(undefined),
  getPricingCatalog: vi.fn().mockResolvedValue(null),
  prisma: {
    $queryRaw: vi.fn(),
    leaderboardSnapshot: { findUnique: vi.fn() },
    leaderboardSnapshotEntry: { findMany: vi.fn(), findUnique: vi.fn() },
    leaderboardUserDay: { groupBy: vi.fn() },
    usagePreference: { findUnique: vi.fn() },
    usageBucket: { groupBy: vi.fn() },
    user: { findMany: vi.fn() },
    follow: { findMany: vi.fn() },
  },
}));

vi.mock("./finalize", () => ({
  finalizePendingLeaderboardPeriods: mocks.finalizePendingLeaderboardPeriods,
}));
vi.mock("@/lib/pricing/catalog", () => ({
  getPricingCatalog: mocks.getPricingCatalog,
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { getLeaderboardPageData } from "./queries";

function snapshotEntry(userId: string, rank: number) {
  return {
    userId,
    rank,
    inputTokens: BigInt(100),
    outputTokens: BigInt(0),
    reasoningTokens: BigInt(0),
    cachedTokens: BigInt(0),
    cacheCreationTokens: BigInt(0),
    totalTokens: BigInt(100),
    estimatedCostUsd: 1,
    activeSeconds: 60,
    sessions: 1,
  };
}

describe("cost leaderboard viewer rank", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.leaderboardSnapshot.findUnique.mockResolvedValue({
      id: "snapshot-1",
      generatedAt: now,
      windowStart: null,
      windowEnd: null,
    });
    mocks.prisma.leaderboardSnapshotEntry.findMany.mockResolvedValue([
      snapshotEntry("leader", 1),
    ]);
    mocks.prisma.usagePreference.findUnique.mockResolvedValue({
      publicProfileEnabled: true,
    });
    mocks.prisma.usageBucket.groupBy.mockResolvedValue([]);
    mocks.prisma.leaderboardUserDay.groupBy.mockResolvedValue([]);
    mocks.prisma.follow.findMany.mockResolvedValue([]);
    mocks.prisma.user.findMany.mockImplementation(async (query) =>
      query.where.id.in.map((id: string) => ({
        id,
        name: id,
        username: id,
        image: null,
        usagePreference: { bio: null, publicProfileEnabled: true },
        _count: { followers: 0, following: 0 },
      })),
    );
  });

  it("shows a viewer at rank 75 from the persisted top 100 snapshot", async () => {
    mocks.prisma.leaderboardSnapshotEntry.findUnique.mockResolvedValue(
      snapshotEntry("viewer", 75),
    );

    const page = await getLeaderboardPageData({
      period: "all_time",
      metric: "estimated_cost",
      viewerUserId: "viewer",
      now,
    });

    expect(page.global.entries.map((entry) => entry.userId)).toEqual([
      "leader",
    ]);
    expect(page.viewerGlobalEntry).toMatchObject({
      userId: "viewer",
      rank: 75,
      estimatedCostUsd: 1,
    });
    expect(
      mocks.prisma.leaderboardSnapshotEntry.findUnique,
    ).toHaveBeenCalledWith({
      where: {
        snapshotId_userId: { snapshotId: "snapshot-1", userId: "viewer" },
      },
    });
  });

  it("omits the standalone row beyond the cached top 100", async () => {
    mocks.prisma.leaderboardSnapshotEntry.findUnique.mockResolvedValue(null);

    const page = await getLeaderboardPageData({
      period: "all_time",
      metric: "estimated_cost",
      viewerUserId: "viewer",
      now,
    });

    expect(page.viewerGlobalEntry).toBeNull();
  });

  it("uses the board row when the viewer is already in the top 50", async () => {
    mocks.prisma.leaderboardSnapshotEntry.findMany.mockResolvedValue([
      snapshotEntry("viewer", 1),
    ]);

    const page = await getLeaderboardPageData({
      period: "all_time",
      metric: "estimated_cost",
      viewerUserId: "viewer",
      now,
    });

    expect(page.global.entries[0]).toMatchObject({
      userId: "viewer",
      isSelf: true,
    });
    expect(page.viewerGlobalEntry).toBeNull();
    expect(
      mocks.prisma.leaderboardSnapshotEntry.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("does not expose a private viewer in the global board", async () => {
    mocks.prisma.usagePreference.findUnique.mockResolvedValue({
      publicProfileEnabled: false,
    });

    const page = await getLeaderboardPageData({
      period: "all_time",
      metric: "estimated_cost",
      viewerUserId: "viewer",
      now,
    });

    expect(page.viewerPublicProfileEnabled).toBe(false);
    expect(page.viewerGlobalEntry).toBeNull();
    expect(
      mocks.prisma.leaderboardSnapshotEntry.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("serves the cached board without viewer-specific reads for guests", async () => {
    const page = await getLeaderboardPageData({
      period: "all_time",
      metric: "estimated_cost",
      now,
    });

    expect(page.following).toBeNull();
    expect(page.viewerGlobalEntry).toBeNull();
    expect(mocks.prisma.usagePreference.findUnique).not.toHaveBeenCalled();
    expect(
      mocks.prisma.leaderboardSnapshotEntry.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("adds a token viewer outside the cached top 50 using the SQL rank", async () => {
    mocks.prisma.leaderboardSnapshotEntry.findMany.mockResolvedValue([
      { ...snapshotEntry("leader", 1), estimatedCostUsd: 0 },
    ]);
    mocks.prisma.$queryRaw.mockResolvedValue([
      {
        rank: BigInt(75),
        inputTokens: BigInt(100),
        outputTokens: BigInt(0),
        reasoningTokens: BigInt(0),
        cachedTokens: BigInt(0),
        cacheCreationTokens: BigInt(0),
        totalTokens: BigInt(100),
        activeSeconds: BigInt(60),
        sessions: BigInt(1),
      },
    ]);

    const page = await getLeaderboardPageData({
      period: "all_time",
      metric: "total_tokens",
      viewerUserId: "viewer",
      now,
    });

    expect(page.viewerGlobalEntry).toMatchObject({
      userId: "viewer",
      rank: 75,
      totalTokens: 100,
    });
    expect(mocks.prisma.$queryRaw).toHaveBeenCalledOnce();
  });
});
