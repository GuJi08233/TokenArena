import { describe, expect, it, vi } from "vitest";
import {
  generateUniqueUsername,
  resolveCreatedUsername,
} from "./auth-username.server";

describe("generateUniqueUsername", () => {
  it("returns the provided seed when the username is available", async () => {
    const username = await generateUniqueUsername("alice", {
      findUserByUsername: vi.fn().mockResolvedValue(null),
      createRandomSuffix: () => "abcdef",
    });

    expect(username).toBe("alice");
  });

  it("adds a random suffix when the first candidate is taken", async () => {
    const findUserByUsername = vi
      .fn()
      .mockResolvedValueOnce({ id: "user-1" })
      .mockResolvedValueOnce(null);

    const username = await generateUniqueUsername("alice", {
      findUserByUsername,
      createRandomSuffix: () => "abcdef",
    });

    expect(username).toBe("alice.abcdef");
    expect(findUserByUsername).toHaveBeenNthCalledWith(1, "alice");
    expect(findUserByUsername).toHaveBeenNthCalledWith(2, "alice.abcdef");
  });

  it("strips separators from both ends of the seed", async () => {
    const username = await generateUniqueUsername("__.Mia-Chen._", {
      findUserByUsername: vi.fn().mockResolvedValue(null),
    });

    expect(username).toBe("mia.chen");
  });

  it("stays fast on a long run of separators that does not reach the end", async () => {
    // `/[._]+$/` backtracked quadratically on this shape: about 2.5 s at
    // 80,000 characters, and an email local part is not length-limited.
    const seed = `a${"_.".repeat(200_000)}b`;
    const started = performance.now();

    const username = await generateUniqueUsername(seed, {
      findUserByUsername: vi.fn().mockResolvedValue(null),
    });

    expect(performance.now() - started).toBeLessThan(100);
    // Only "a" survives the separator trim, too short to be a username.
    expect(username).toBe("user");
  });
});

describe("resolveCreatedUsername", () => {
  it("keeps a unique provided username unchanged", async () => {
    await expect(
      resolveCreatedUsername({
        providedUsername: "Alice",
        seed: "alice@example.com",
        findUserByUsername: vi.fn().mockResolvedValue(null),
        createRandomSuffix: () => "abcdef",
      }),
    ).resolves.toEqual({
      username: "alice",
      usernameNeedsSetup: false,
      usernameAutoAdjusted: false,
    });
  });

  it("auto-adjusts a conflicting provided username", async () => {
    const findUserByUsername = vi
      .fn()
      .mockResolvedValueOnce({ id: "user-1" })
      .mockResolvedValueOnce({ id: "user-1" })
      .mockResolvedValueOnce(null);

    await expect(
      resolveCreatedUsername({
        providedUsername: "alice",
        seed: "alice@example.com",
        findUserByUsername,
        createRandomSuffix: () => "abcdef",
      }),
    ).resolves.toEqual({
      username: "alice.abcdef",
      usernameNeedsSetup: false,
      usernameAutoAdjusted: true,
    });
  });

  it("marks generated usernames as needing setup when no username is provided", async () => {
    await expect(
      resolveCreatedUsername({
        providedUsername: "",
        seed: "alice",
        findUserByUsername: vi.fn().mockResolvedValue(null),
        createRandomSuffix: () => "abcdef",
      }),
    ).resolves.toEqual({
      username: "alice",
      usernameNeedsSetup: true,
      usernameAutoAdjusted: false,
    });
  });
});
