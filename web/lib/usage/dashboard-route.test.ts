import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  getUsageDashboardData: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/usage/dashboard.server", () => ({
  getUsageDashboardData: mocks.getUsageDashboardData,
}));

import { GET } from "@/app/api/usage/dashboard/route";

describe("usage dashboard route", () => {
  it("tells API clients when dashboard figures are incomplete", async () => {
    mocks.getOptionalSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUsageDashboardData.mockResolvedValue({
      dashboard: {
        truncated: true,
        range: {
          from: new Date("2026-09-01T00:00:00.000Z"),
          to: new Date("2026-09-23T00:00:00.000Z"),
          granularity: "day",
          preset: "custom",
          timezone: "UTC",
        },
        overview: {},
        tokenTrend: [],
        activityTrend: [],
        hourlyActivityHeatmap: [],
        breakdowns: {},
        pricingSummary: {},
        modelPricingRows: [],
        sessions: [],
        lastSyncedAt: null,
      },
    });

    const response = await GET(
      new Request("http://localhost:3000/api/usage/dashboard"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ truncated: true });
  });
});
