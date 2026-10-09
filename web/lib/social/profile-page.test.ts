import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileAchievementWallItem } from "@/lib/achievements/profile-wall";
import type { PricingCatalog } from "@/lib/pricing/catalog";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  accountFindMany: vi.fn(),
  followFindUnique: vi.fn(),
  groupBy: vi.fn(),
  sessionAggregate: vi.fn(),
  queryRaw: vi.fn(),
  getPricingCatalog: vi.fn(),
  getArenaSummaryForProfile: vi.fn(),
  getProfileAchievementWall: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    account: { findMany: mocks.accountFindMany },
    follow: { findUnique: mocks.followFindUnique },
    usageBucket: { groupBy: mocks.groupBy },
    usageSession: { aggregate: mocks.sessionAggregate },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@/lib/pricing/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pricing/catalog")>()),
  getPricingCatalog: mocks.getPricingCatalog,
}));
vi.mock("@/lib/achievements/queries", () => ({
  getArenaSummaryForProfile: mocks.getArenaSummaryForProfile,
}));
vi.mock("@/lib/achievements/profile-wall", () => ({
  getProfileAchievementWall: mocks.getProfileAchievementWall,
}));

import {
  getPublicProfilePageData,
  type PublicProfilePageData,
} from "./queries";

function publicUser(publicProfileEnabled = true) {
  return {
    id: "user-1",
    name: "Example",
    username: "example",
    image: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    usagePreference: {
      bio: "An example profile",
      timezone: "UTC",
      publicProfileEnabled,
    },
    _count: { followers: 2, following: 4 },
  };
}

const achievementWall: ProfileAchievementWallItem[] = [
  {
    code: "leaderboard_day_top50",
    iconKey: "trophy",
    tier: "bronze",
    awardCount: 2,
  },
];

function expectUsagePreserved(profile: PublicProfilePageData | null) {
  expect(profile).toMatchObject({
    id: "user-1",
    username: "example",
    bio: "An example profile",
    followerCount: 2,
    followingCount: 4,
    overview: {
      totalTokens: 1_000_000,
      estimatedCostUsd: 2.5,
      activeSeconds: 600,
      sessions: 3,
    },
    topTools: [{ name: "codex", totalTokens: 1_000_000, share: 1 }],
    topModels: [{ name: "gpt-example", totalTokens: 1_000_000, share: 1 }],
  });
  expect(profile?.heatmap).toHaveLength(365);
  expect(profile?.heatmap.find((day) => day.date === "2026-10-10")).toEqual({
    date: "2026-10-10",
    activeSeconds: 600,
    sessions: 3,
    totalTokens: 1_000_000,
    level: 4,
  });
}

describe("public profile optional achievements", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.userFindUnique.mockResolvedValue(publicUser());
    mocks.accountFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([
      {
        date: "2026-10-10",
        activeSeconds: 600,
        sessions: 3,
        totalTokens: BigInt(1_000_000),
      },
    ]);
    const catalog: PricingCatalog = new Map([
      [
        "openai",
        {
          id: "openai",
          name: "OpenAI",
          modelsByLower: new Map([
            [
              "gpt-example",
              {
                id: "gpt-example",
                name: "Example model",
                cost: { input: 2, output: 4 },
              },
            ],
          ]),
        },
      ],
    ]);
    mocks.getPricingCatalog.mockResolvedValue(catalog);
    mocks.groupBy.mockImplementation(async ({ by }: { by: string[] }) =>
      by[0] === "source"
        ? [{ source: "codex", _sum: { totalTokens: BigInt(1_000_000) } }]
        : [
            {
              model: "gpt-example",
              _sum: {
                totalTokens: BigInt(1_000_000),
                inputTokens: BigInt(750_000),
                outputTokens: BigInt(250_000),
                reasoningTokens: BigInt(0),
                cachedTokens: BigInt(0),
                cacheCreationTokens: BigInt(0),
              },
            },
          ],
    );
    mocks.sessionAggregate.mockResolvedValue({
      _sum: { activeSeconds: 600 },
      _count: { _all: 3 },
    });
    mocks.getArenaSummaryForProfile.mockResolvedValue({
      score: 120,
      level: 2,
      totalActiveDays: 7,
    });
    mocks.getProfileAchievementWall.mockResolvedValue(achievementWall);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns usage statistics and both successful achievement sections", async () => {
    const profile = await getPublicProfilePageData({ username: "example" });

    expectUsagePreserved(profile);
    expect(profile?.overview).toMatchObject({
      arenaScore: 120,
      arenaLevel: 2,
      activeDays: 7,
    });
    expect(profile?.achievementWall).toEqual(achievementWall);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps usage and the wall when the Arena summary fails", async () => {
    const error = new Error("Arena summary unavailable");
    mocks.getArenaSummaryForProfile.mockRejectedValue(error);

    const profile = await getPublicProfilePageData({ username: "example" });

    expectUsagePreserved(profile);
    expect(profile?.overview).toMatchObject({
      arenaScore: null,
      arenaLevel: null,
      activeDays: null,
    });
    expect(profile?.achievementWall).toEqual(achievementWall);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), {
      userId: "user-1",
      error,
    });
  });

  it("keeps usage and the Arena summary when the wall fails", async () => {
    const error = new Error("Achievement wall unavailable");
    mocks.getProfileAchievementWall.mockRejectedValue(error);

    const profile = await getPublicProfilePageData({ username: "example" });

    expectUsagePreserved(profile);
    expect(profile?.overview).toMatchObject({
      arenaScore: 120,
      arenaLevel: 2,
      activeDays: 7,
    });
    expect(profile?.achievementWall).toEqual([]);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), {
      userId: "user-1",
      error,
    });
  });

  it("keeps usage when both achievement reads fail", async () => {
    const arenaError = new Error("Arena failed");
    const wallError = new Error("Wall failed");
    mocks.getArenaSummaryForProfile.mockRejectedValue(arenaError);
    mocks.getProfileAchievementWall.mockRejectedValue(wallError);

    const profile = await getPublicProfilePageData({ username: "example" });

    expectUsagePreserved(profile);
    expect(profile?.overview).toMatchObject({
      arenaScore: null,
      arenaLevel: null,
      activeDays: null,
    });
    expect(profile?.achievementWall).toEqual([]);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), {
      userId: "user-1",
      error: arenaError,
    });
    expect(console.error).toHaveBeenCalledWith(expect.any(String), {
      userId: "user-1",
      error: wallError,
    });
  });

  it("keeps usage when the score comes from stored achievements without a summary", async () => {
    mocks.getArenaSummaryForProfile.mockResolvedValue({
      score: 140_460,
      level: 10,
      totalActiveDays: null,
    });

    const profile = await getPublicProfilePageData({ username: "example" });

    expectUsagePreserved(profile);
    expect(profile?.overview).toMatchObject({
      arenaScore: 140_460,
      arenaLevel: 10,
      activeDays: null,
    });
    expect(profile?.achievementWall).toEqual(achievementWall);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("propagates a core usage failure instead of returning partial statistics", async () => {
    const error = new Error("Usage aggregation failed");
    mocks.groupBy.mockRejectedValue(error);

    await expect(
      getPublicProfilePageData({ username: "example" }),
    ).rejects.toBe(error);

    expect(mocks.getArenaSummaryForProfile).not.toHaveBeenCalled();
    expect(mocks.getProfileAchievementWall).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "another-user",
  ])("does not load a private profile's data for viewer %s", async (viewerUserId) => {
    mocks.userFindUnique.mockResolvedValue(publicUser(false));

    await expect(
      getPublicProfilePageData({ username: "example", viewerUserId }),
    ).resolves.toBeNull();

    expect(mocks.accountFindMany).not.toHaveBeenCalled();
    expect(mocks.followFindUnique).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.sessionAggregate).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.getArenaSummaryForProfile).not.toHaveBeenCalled();
    expect(mocks.getProfileAchievementWall).not.toHaveBeenCalled();
  });
});
