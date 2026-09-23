import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicProfileActivityShareData: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/lib/social/queries", () => ({
  getPublicProfileActivityShareData: mocks.getPublicProfileActivityShareData,
}));

describe("activity svg route", () => {
  // 首次加载路由会转换整棵依赖树，全量并行时可能超过单个用例 5 秒的超时。
  beforeAll(async () => {
    await import("@/app/[locale]/u/[username]/activity.svg/route");
  }, 60_000);

  it("serves the heatmap under a restrictive CSP", async () => {
    mocks.getPublicProfileActivityShareData.mockResolvedValue({
      username: "alice",
      timezone: "UTC",
      heatmap: [
        {
          date: "2026-09-01",
          activeSeconds: 60,
          sessions: 1,
          totalTokens: 10,
          level: 4,
        },
      ],
      summary: { activeDays: 1, activeSeconds: 60 },
    });

    const { GET } = await import(
      "@/app/[locale]/u/[username]/activity.svg/route"
    );
    const response = await GET(
      new Request("https://example.com/en/u/alice/activity.svg"),
      { params: Promise.resolve({ locale: "en", username: "alice" }) },
    );

    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.text()).resolves.toContain("activityTitle");
  });
});
