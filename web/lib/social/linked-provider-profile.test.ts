import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pickLinkedAccount,
  resolveLinkedProfileUrl,
} from "./linked-provider-profile";

describe("resolveLinkedProfileUrl", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds Linux.do profile links with the summary route", async () => {
    await expect(resolveLinkedProfileUrl("linuxdo", "philfan")).resolves.toBe(
      "https://linux.do/u/philfan/summary",
    );
  });

  it("encodes Linux.do account ids safely", async () => {
    await expect(
      resolveLinkedProfileUrl("linuxdo", "name with space"),
    ).resolves.toBe("https://linux.do/u/name%20with%20space/summary");
  });

  it("resolves numeric Linux.do account ids to usernames via the user API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "philfan" }),
    }) as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", "token-123"),
    ).resolves.toBe("https://linux.do/u/philfan/summary");
  });

  it("caches a resolved Linux.do username without retaining the bearer token", async () => {
    const mockedFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "cached-user" }),
    });
    globalThis.fetch = mockedFetch as typeof fetch;

    const first = await resolveLinkedProfileUrl(
      "linuxdo",
      "400001",
      "cache-token",
    );
    const second = await resolveLinkedProfileUrl(
      "linuxdo",
      "400001",
      "cache-token",
    );

    expect(first).toBe("https://linux.do/u/cached-user/summary");
    expect(second).toBe(first);
    expect(mockedFetch).toHaveBeenCalledOnce();
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://connect.linux.do/api/user",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer cache-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("shares a pending Linux.do lookup between concurrent profile views", async () => {
    let resolveResponse!: (value: unknown) => void;
    const mockedFetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    globalThis.fetch = mockedFetch as typeof fetch;

    const first = resolveLinkedProfileUrl("linuxdo", "400002", "shared-token");
    const second = resolveLinkedProfileUrl("linuxdo", "400002", "shared-token");
    expect(mockedFetch).toHaveBeenCalledOnce();

    resolveResponse({
      ok: true,
      json: async () => ({ username: "shared-user" }),
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      "https://linux.do/u/shared-user/summary",
      "https://linux.do/u/shared-user/summary",
    ]);
  });

  it("keeps Linux.do cache entries separate by token and account id", async () => {
    const mockedFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: "first-user" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: "second-user" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: "third-user" }),
      });
    globalThis.fetch = mockedFetch as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("linuxdo", "400003", "first-token"),
    ).resolves.toBe("https://linux.do/u/first-user/summary");
    await expect(
      resolveLinkedProfileUrl("linuxdo", "400003", "second-token"),
    ).resolves.toBe("https://linux.do/u/second-user/summary");
    await expect(
      resolveLinkedProfileUrl("linuxdo", "400004", "first-token"),
    ).resolves.toBe("https://linux.do/u/third-user/summary");
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("retries a failed Linux.do lookup after its short cache lifetime", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const mockedFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: "recovered-user" }),
      });
    globalThis.fetch = mockedFetch as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("linuxdo", "400005", "retry-token"),
    ).resolves.toBeNull();
    now += 59_000;
    await expect(
      resolveLinkedProfileUrl("linuxdo", "400005", "retry-token"),
    ).resolves.toBeNull();
    expect(mockedFetch).toHaveBeenCalledOnce();

    now += 1_001;
    await expect(
      resolveLinkedProfileUrl("linuxdo", "400005", "retry-token"),
    ).resolves.toBe("https://linux.do/u/recovered-user/summary");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled Linux.do provider request after one second", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = (options as RequestInit).signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    ) as typeof fetch;

    const startedAt = performance.now();
    await expect(
      resolveLinkedProfileUrl("linuxdo", "400006", "timeout-token"),
    ).resolves.toBeNull();
    expect(timeout).toHaveBeenCalledWith(1_000);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(900);
  });

  it("hides Linux.do links when only a numeric id is available", async () => {
    await expect(resolveLinkedProfileUrl("linuxdo", "294197")).resolves.toBe(
      null,
    );
  });

  it("returns null for an unknown provider", async () => {
    await expect(
      resolveLinkedProfileUrl("unknown", "test"),
    ).resolves.toBeNull();
  });

  it("builds Watcha profile links", async () => {
    await expect(resolveLinkedProfileUrl("watcha", "testuser")).resolves.toBe(
      "https://watcha.cn/user/testuser",
    );
  });

  it("builds GitHub profile links for non-numeric account ids", async () => {
    await expect(resolveLinkedProfileUrl("github", "octocat")).resolves.toBe(
      "https://github.com/octocat",
    );
  });

  it("resolves GitHub numeric account ids via the user API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/found-user" }),
    }) as typeof fetch;

    await expect(resolveLinkedProfileUrl("github", "12345")).resolves.toBe(
      "https://github.com/found-user",
    );
  });

  it("returns null for GitHub numeric id when API response is not ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("github", "12345"),
    ).resolves.toBeNull();
  });

  it("returns null for GitHub numeric id when API throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(
      resolveLinkedProfileUrl("github", "12345"),
    ).resolves.toBeNull();
  });

  it("returns null for GitHub numeric id when html_url is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("github", "12345"),
    ).resolves.toBeNull();
  });

  it("returns null for GitHub when account id is empty/whitespace", async () => {
    await expect(resolveLinkedProfileUrl("github", "  ")).resolves.toBeNull();
  });

  it("returns null for Linux.do when account id is empty/whitespace", async () => {
    await expect(resolveLinkedProfileUrl("linuxdo", "  ")).resolves.toBeNull();
  });

  it("returns null for Linux.do numeric id when access token fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", "failure-token"),
    ).resolves.toBeNull();
  });

  it("returns null for Linux.do numeric id when API response is not ok", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
    }) as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", "not-ok-token"),
    ).resolves.toBeNull();
  });

  it("returns null for Linux.do numeric id when username is empty in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: "" }),
    }) as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", "empty-name-token"),
    ).resolves.toBeNull();
  });

  it("returns null for Linux.do numeric id when username is missing in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as typeof fetch;

    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", "missing-name-token"),
    ).resolves.toBeNull();
  });

  it("returns null for Linux.do numeric id when access token is empty", async () => {
    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", ""),
    ).resolves.toBeNull();
  });

  it("returns null for Linux.do numeric id when access token is whitespace", async () => {
    await expect(
      resolveLinkedProfileUrl("linuxdo", "294197", "   "),
    ).resolves.toBeNull();
  });
});

describe("pickLinkedAccount", () => {
  it("prefers GitHub over Linux.do and Watcha", () => {
    const result = pickLinkedAccount([
      { providerId: "linuxdo", accountId: "linux_user" },
      { providerId: "github", accountId: "gh_user" },
      { providerId: "watcha", accountId: "w_user" },
    ]);

    expect(result).toEqual({
      providerId: "github",
      accountId: "gh_user",
      accessToken: undefined,
    });
  });

  it("picks Linux.do when GitHub is not present", () => {
    const result = pickLinkedAccount([
      { providerId: "watcha", accountId: "w_user" },
      { providerId: "linuxdo", accountId: "linux_user" },
    ]);

    expect(result).toEqual({
      providerId: "linuxdo",
      accountId: "linux_user",
      accessToken: undefined,
    });
  });

  it("picks Watcha when nothing else is available", () => {
    const result = pickLinkedAccount([
      { providerId: "watcha", accountId: "w_user" },
    ]);

    expect(result).toEqual({
      providerId: "watcha",
      accountId: "w_user",
      accessToken: undefined,
    });
  });

  it("returns null when no accounts are provided", () => {
    expect(pickLinkedAccount([])).toBeNull();
  });

  it("returns null when the account id is empty/whitespace", () => {
    const result = pickLinkedAccount([
      { providerId: "github", accountId: "  " },
    ]);

    expect(result).toBeNull();
  });

  it("includes the access token when available", () => {
    const result = pickLinkedAccount([
      { providerId: "github", accountId: "gh_user", accessToken: "tok123" },
    ]);

    expect(result).toEqual({
      providerId: "github",
      accountId: "gh_user",
      accessToken: "tok123",
    });
  });

  it("returns null when only unknown providers exist", () => {
    const result = pickLinkedAccount([
      { providerId: "twitter", accountId: "tw_user" },
    ]);

    expect(result).toBeNull();
  });
});
