import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getOptionalSession: vi.fn(),
  synchronizeAchievementsInBackground: vi.fn(),
  prisma: {
    user: { findUnique: vi.fn() },
    follow: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));
vi.mock("@/lib/achievements/queries", () => ({
  synchronizeAchievementsInBackground:
    mocks.synchronizeAchievementsInBackground,
}));
vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { DELETE, PATCH, POST } from "./route";

function context(username: string) {
  return { params: Promise.resolve({ username }) } as never;
}

function request(method: string, body?: unknown) {
  return new Request("https://example.com/api/social/follows/bob", {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function target(publicProfileEnabled: boolean) {
  return {
    id: "user-bob",
    usagePreference: { publicProfileEnabled },
  };
}

async function runScheduledWork() {
  await Promise.all(mocks.after.mock.calls.map(([callback]) => callback()));
}

describe("follow route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalSession.mockResolvedValue({
      user: { id: "user-alice" },
    });
    mocks.prisma.user.findUnique.mockResolvedValue(target(true));
    mocks.synchronizeAchievementsInBackground.mockResolvedValue(undefined);
  });

  it("requires a session", async () => {
    mocks.getOptionalSession.mockResolvedValue(null);

    const response = await POST(request("POST"), context("bob"));

    expect(response.status).toBe(401);
    expect(mocks.prisma.follow.createMany).not.toHaveBeenCalled();
  });

  it("refuses to follow a private profile or yourself", async () => {
    mocks.prisma.user.findUnique.mockResolvedValueOnce(target(false));
    expect((await POST(request("POST"), context("bob"))).status).toBe(403);

    mocks.prisma.user.findUnique.mockResolvedValueOnce({
      ...target(true),
      id: "user-alice",
    });
    expect((await POST(request("POST"), context("alice"))).status).toBe(400);

    mocks.prisma.user.findUnique.mockResolvedValueOnce(null);
    expect((await POST(request("POST"), context("nobody"))).status).toBe(404);

    expect(mocks.prisma.follow.createMany).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("answers a new follow before re-evaluating both users", async () => {
    mocks.prisma.follow.createMany.mockResolvedValue({ count: 1 });

    const response = await POST(request("POST"), context("bob"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mocks.prisma.follow.createMany).toHaveBeenCalledWith({
      data: [{ followerId: "user-alice", followingId: "user-bob" }],
      skipDuplicates: true,
    });
    // A failed award pass used to report a saved follow as failed.
    expect(mocks.synchronizeAchievementsInBackground).not.toHaveBeenCalled();

    await runScheduledWork();
    expect(mocks.synchronizeAchievementsInBackground.mock.calls).toEqual([
      ["user-alice", "social"],
      ["user-bob", "social"],
    ]);
  });

  it("does not replay anyone's history for a follow that already exists", async () => {
    mocks.prisma.follow.createMany.mockResolvedValue({ count: 0 });

    const response = await POST(request("POST"), context("bob"));

    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("re-evaluates both users after an unfollow", async () => {
    mocks.prisma.follow.deleteMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(request("DELETE"), context("bob"));

    expect(response.status).toBe(200);
    await runScheduledWork();
    expect(mocks.synchronizeAchievementsInBackground.mock.calls).toEqual([
      ["user-alice", "social"],
      ["user-bob", "social"],
    ]);
  });

  it("does nothing more for an unfollow that removed nothing", async () => {
    // Even for a private profile: the request is answered, but repeating it
    // can no longer make the server replay that account's history.
    mocks.prisma.user.findUnique.mockResolvedValue(target(false));
    mocks.prisma.follow.deleteMany.mockResolvedValue({ count: 0 });

    const response = await DELETE(request("DELETE"), context("bob"));

    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("updates a follow tag without touching achievements", async () => {
    mocks.prisma.follow.updateMany.mockResolvedValue({ count: 1 });

    const response = await PATCH(
      request("PATCH", { tag: null }),
      context("bob"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      tag: null,
    });
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
