import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  userFindMany: vi.fn(),
  userCount: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    follow: { count: mocks.count, findMany: mocks.findMany },
    user: {
      findMany: mocks.userFindMany,
      count: mocks.userCount,
      findUnique: mocks.userFindUnique,
    },
  },
}));

import {
  countFollowerProfiles,
  countFollowingProfiles,
  countPublicProfiles,
  getPublicProfileMetadata,
  listFollowerProfiles,
  listFollowingProfiles,
  searchPublicProfiles,
} from "./queries";

function profile(id: string, publicProfileEnabled: boolean) {
  return {
    id,
    name: `Name ${id}`,
    username: `user_${id}`,
    image: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    usagePreference: {
      bio: `Bio ${id}`,
      timezone: "UTC",
      publicProfileEnabled,
    },
    _count: { followers: 3, following: 4 },
  };
}

describe("network profile pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts and loads only the requested following page, including private profiles", async () => {
    mocks.count.mockResolvedValue(42);
    mocks.findMany
      .mockResolvedValueOnce([
        { tag: "friend", following: profile("a", false) },
        { tag: null, following: profile("b", true) },
      ])
      .mockResolvedValueOnce([{ followerId: "a" }]);
    const input = {
      viewerUserId: "viewer",
      query: "  BIO  ",
      offset: 10,
      limit: 10,
    };

    expect(await countFollowingProfiles(input)).toBe(42);
    const rows = await listFollowingProfiles(input);

    const countWhere = mocks.count.mock.calls[0][0].where;
    const pageQuery = mocks.findMany.mock.calls[0][0];
    expect(pageQuery.where).toEqual(countWhere);
    expect(pageQuery).toMatchObject({
      orderBy: { createdAt: "desc" },
      skip: 10,
      take: 10,
    });
    expect(countWhere).toEqual({
      followerId: "viewer",
      following: {
        is: {
          OR: [
            { username: { contains: "BIO", mode: "insensitive" } },
            { name: { contains: "BIO", mode: "insensitive" } },
            {
              usagePreference: {
                is: { bio: { contains: "BIO", mode: "insensitive" } },
              },
            },
          ],
        },
      },
    });
    expect(mocks.findMany.mock.calls[1][0].where).toEqual({
      followerId: { in: ["a", "b"] },
      followingId: "viewer",
    });
    expect(rows).toMatchObject([
      {
        id: "a",
        publicProfileEnabled: false,
        isFollowing: true,
        followsYou: true,
        followTag: "friend",
      },
      {
        id: "b",
        publicProfileEnabled: true,
        isFollowing: true,
        followsYou: false,
        followTag: null,
      },
    ]);
  });

  it("counts and loads only the requested follower page with relationship tags", async () => {
    mocks.count.mockResolvedValue(11);
    mocks.findMany
      .mockResolvedValueOnce([{ follower: profile("c", false) }])
      .mockResolvedValueOnce([{ followingId: "c", tag: "coworker" }]);
    const input = {
      viewerUserId: "viewer",
      query: "Name",
      offset: 10,
      limit: 10,
    };

    expect(await countFollowerProfiles(input)).toBe(11);
    const rows = await listFollowerProfiles(input);

    const countWhere = mocks.count.mock.calls[0][0].where;
    const pageQuery = mocks.findMany.mock.calls[0][0];
    expect(pageQuery.where).toEqual(countWhere);
    expect(pageQuery).toMatchObject({
      orderBy: { createdAt: "desc" },
      skip: 10,
      take: 10,
    });
    expect(countWhere).toMatchObject({
      followingId: "viewer",
      follower: { is: { OR: expect.any(Array) } },
    });
    expect(mocks.findMany.mock.calls[1][0].where).toEqual({
      followerId: "viewer",
      followingId: { in: ["c"] },
    });
    expect(rows).toMatchObject([
      {
        id: "c",
        publicProfileEnabled: false,
        isFollowing: true,
        followsYou: true,
        followTag: "coworker",
      },
    ]);
  });

  it("skips the relationship lookup when a page is empty", async () => {
    mocks.findMany.mockResolvedValue([]);

    expect(
      await listFollowingProfiles({
        viewerUserId: "viewer",
        limit: 10,
        offset: 0,
      }),
    ).toEqual([]);
    expect(mocks.findMany).toHaveBeenCalledOnce();
  });

  it("does not apply a public filter or search condition to an unfiltered network page", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.findMany
      .mockResolvedValueOnce([
        { tag: null, following: profile("private", false) },
      ])
      .mockResolvedValueOnce([]);

    expect(await countFollowingProfiles({ viewerUserId: "viewer" })).toBe(1);
    const rows = await listFollowingProfiles({
      viewerUserId: "viewer",
      query: "  ",
      limit: 10,
      offset: 0,
    });

    expect(mocks.count.mock.calls[0][0].where).toEqual({
      followerId: "viewer",
    });
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      followerId: "viewer",
    });
    expect(rows[0]).toMatchObject({
      id: "private",
      publicProfileEnabled: false,
      isFollowing: true,
      followsYou: false,
    });
  });

  it("does not query reverse relations for an empty follower page", async () => {
    mocks.findMany.mockResolvedValue([]);

    expect(
      await listFollowerProfiles({
        viewerUserId: "viewer",
        limit: 10,
        offset: 0,
      }),
    ).toEqual([]);
    expect(mocks.findMany).toHaveBeenCalledOnce();
  });

  it("keeps a follower without a mutual follow or tag", async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ follower: profile("solo", false) }])
      .mockResolvedValueOnce([]);

    const rows = await listFollowerProfiles({
      viewerUserId: "viewer",
      limit: 10,
      offset: 0,
    });

    expect(rows[0]).toMatchObject({
      id: "solo",
      publicProfileEnabled: false,
      isFollowing: false,
      followTag: null,
      followsYou: true,
    });
  });
});

describe("public profile search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts public users and paginates a guest search without relation queries", async () => {
    mocks.userCount.mockResolvedValue(1);
    mocks.userFindMany.mockResolvedValue([profile("guest-result", true)]);

    expect(await countPublicProfiles({ query: "  maker  " })).toBe(1);
    const rows = await searchPublicProfiles({
      query: "  maker  ",
      offset: 20,
      limit: 10,
    });

    const countWhere = mocks.userCount.mock.calls[0][0].where;
    expect(mocks.userFindMany.mock.calls[0][0]).toMatchObject({
      where: countWhere,
      orderBy: { username: "asc" },
      skip: 20,
      take: 10,
    });
    expect(countWhere).toEqual({
      AND: [
        { usagePreference: { is: { publicProfileEnabled: true } } },
        {
          OR: [
            { username: { contains: "maker", mode: "insensitive" } },
            { name: { contains: "maker", mode: "insensitive" } },
          ],
        },
      ],
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      id: "guest-result",
      isFollowing: false,
      followsYou: false,
      isSelf: false,
    });
  });

  it("includes the viewer's private profile and maps both relation directions", async () => {
    mocks.userFindMany.mockResolvedValue([
      profile("viewer", false),
      profile("peer", true),
    ]);
    mocks.findMany
      .mockResolvedValueOnce([{ followingId: "peer", tag: "friend" }])
      .mockResolvedValueOnce([{ followerId: "peer" }]);

    const rows = await searchPublicProfiles({ viewerUserId: "viewer" });

    expect(mocks.userFindMany.mock.calls[0][0]).toMatchObject({
      where: {
        AND: [
          {
            OR: [
              { usagePreference: { is: { publicProfileEnabled: true } } },
              { id: "viewer" },
            ],
          },
          {},
        ],
      },
      orderBy: { createdAt: "desc" },
      skip: 0,
    });
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      followerId: "viewer",
      followingId: { in: ["viewer", "peer"] },
    });
    expect(mocks.findMany.mock.calls[1][0].where).toEqual({
      followerId: { in: ["viewer", "peer"] },
      followingId: "viewer",
    });
    expect(rows).toMatchObject([
      {
        id: "viewer",
        publicProfileEnabled: false,
        isSelf: true,
        isFollowing: false,
      },
      {
        id: "peer",
        isSelf: false,
        isFollowing: true,
        followsYou: true,
        followTag: "friend",
      },
    ]);
  });

  it("avoids relation queries when no users match a logged-in search", async () => {
    mocks.userFindMany.mockResolvedValue([]);

    expect(
      await searchPublicProfiles({ viewerUserId: "viewer", query: "missing" }),
    ).toEqual([]);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("counts the viewer alongside public users when no search is provided", async () => {
    mocks.userCount.mockResolvedValue(7);

    expect(await countPublicProfiles({ viewerUserId: "viewer" })).toBe(7);
    expect(mocks.userCount.mock.calls[0][0].where).toEqual({
      AND: [
        {
          OR: [
            { usagePreference: { is: { publicProfileEnabled: true } } },
            { id: "viewer" },
          ],
        },
        {},
      ],
    });
  });

  it("maps an account without preferences only when it is the viewer", async () => {
    mocks.userFindMany.mockResolvedValue([
      { ...profile("viewer", false), usagePreference: null },
    ]);
    mocks.findMany.mockResolvedValue([]);

    const rows = await searchPublicProfiles({ viewerUserId: "viewer" });

    expect(rows).toMatchObject([
      {
        id: "viewer",
        isSelf: true,
        bio: null,
        publicProfileEnabled: false,
      },
    ]);
  });

  it("only exposes public profile metadata", async () => {
    mocks.userFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        usagePreference: { publicProfileEnabled: false, bio: "private bio" },
      })
      .mockResolvedValueOnce({
        usagePreference: { publicProfileEnabled: true, bio: "public bio" },
      });

    await expect(
      getPublicProfileMetadata({ username: "MISSING" }),
    ).resolves.toBeNull();
    await expect(
      getPublicProfileMetadata({ username: "PRIVATE" }),
    ).resolves.toBeNull();
    await expect(
      getPublicProfileMetadata({ username: "PUBLIC" }),
    ).resolves.toEqual({ bio: "public bio" });
    expect(mocks.userFindUnique.mock.calls[2][0].where).toEqual({
      username: "public",
    });
  });
});
