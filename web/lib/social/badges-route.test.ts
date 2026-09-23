import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicBadgeData: vi.fn(),
}));

vi.mock("@/lib/social/badges", async () => {
  const actual = await vi.importActual<typeof import("@/lib/social/badges")>(
    "@/lib/social/badges",
  );

  return {
    ...actual,
    getPublicBadgeData: mocks.getPublicBadgeData,
  };
});

describe("badge route", () => {
  // 首次加载路由会转换整棵依赖树，全量并行时可能超过单个用例 5 秒的超时。
  beforeAll(async () => {
    await import("@/app/api/badges/[username]/route");
  }, 60_000);

  it("returns svg for a public metric", async () => {
    mocks.getPublicBadgeData.mockResolvedValue({
      kind: "ok",
      data: {
        username: "alice",
        publicProfileEnabled: true,
        totalTokens: 123456,
        estimatedCostUsd: 4.2,
        activeSeconds: 7200,
        totalSeconds: 10800,
        sessions: 3,
        currentStreakDays: 5,
      },
    });

    const { GET } = await import("@/app/api/badges/[username]/route");
    const response = await GET(
      new Request(
        "https://example.com/api/badges/alice?metric=tokens&style=plastic",
      ),
      { params: Promise.resolve({ username: "alice" }) } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await response.text();
    expect(svg).toContain("TokenArena tokens: 123.5K");
    expect(svg).toContain(">tokens<");
    expect(svg).toContain("linearGradient");
  });

  it("returns 400 for invalid metric", async () => {
    const { GET } = await import("@/app/api/badges/[username]/route");
    const response = await GET(
      new Request("https://example.com/api/badges/alice?metric=invalid"),
      { params: Promise.resolve({ username: "alice" }) } as never,
    );

    expect(response.status).toBe(400);
  });

  it("returns private placeholder badge", async () => {
    mocks.getPublicBadgeData.mockResolvedValue({
      kind: "private",
      username: "alice",
    });

    const { GET } = await import("@/app/api/badges/[username]/route");
    const response = await GET(
      new Request("https://example.com/api/badges/alice?metric=cost"),
      { params: Promise.resolve({ username: "alice" }) } as never,
    );

    await expect(response.text()).resolves.toContain("private");
  });

  it("escapes a hostile label and serves the SVG under a restrictive CSP", async () => {
    mocks.getPublicBadgeData.mockResolvedValue({
      kind: "private",
      username: "alice",
    });

    const { GET } = await import("@/app/api/badges/[username]/route");
    const label = encodeURIComponent('"><script>alert(1)</script>');
    const response = await GET(
      new Request(
        `https://example.com/api/badges/alice?metric=tokens&label=${label}`,
      ),
      { params: Promise.resolve({ username: "alice" }) } as never,
    );

    const svg = await response.text();
    expect(svg).not.toContain("<script");
    expect(svg).toContain(
      'aria-label="TokenArena &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;: private"',
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
