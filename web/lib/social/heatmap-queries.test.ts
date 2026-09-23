import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupByHourOrDay } from "@/lib/usage/date-range";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  leaderboardDays: vi.fn(),
  sessions: vi.fn(),
  buckets: vi.fn(),
  groupByHourOrDay: vi.fn(),
}));

vi.mock("@/lib/usage/date-range", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/usage/date-range")>();
  return {
    ...actual,
    groupByHourOrDay: (...args: Parameters<typeof actual.groupByHourOrDay>) => {
      mocks.groupByHourOrDay();
      return actual.groupByHourOrDay(...args);
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    leaderboardUserDay: { findMany: mocks.leaderboardDays },
    usageSession: { findMany: mocks.sessions },
    usageBucket: { findMany: mocks.buckets },
  },
}));

import { getActivityHeatmap365 } from "./queries";

describe("getActivityHeatmap365", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw.mockResolvedValue([]);
    mocks.leaderboardDays.mockResolvedValue([]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries local day aggregates across a daylight saving change", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        date: "2026-03-08",
        activeSeconds: 90,
        sessions: 2,
        totalTokens: BigInt(100),
      },
      {
        date: "2026-03-09",
        activeSeconds: 10,
        sessions: 1,
        totalTokens: BigInt(20),
      },
    ]);

    const days = await getActivityHeatmap365({
      userId: "user-1",
      timezone: "America/New_York",
    });

    expect(days.find((day) => day.date === "2026-03-08")).toMatchObject({
      activeSeconds: 90,
      sessions: 2,
      totalTokens: 100,
    });
    expect(days.find((day) => day.date === "2026-03-09")).toMatchObject({
      activeSeconds: 10,
      sessions: 1,
      totalTokens: 20,
    });
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.sessions).not.toHaveBeenCalled();
    expect(mocks.buckets).not.toHaveBeenCalled();

    const [statement] = mocks.queryRaw.mock.calls[0];
    expect(statement.sql).toContain('JOIN "UsageSession"');
    expect(statement.sql).toContain('JOIN "UsageBucket"');
    expect(statement.sql).toContain("UNION ALL");
    expect(statement.sql).toContain('s."firstMessageAt" <=');
    expect(statement.sql).toContain('b."bucketStart" <=');
    expect(statement.values).toContain("2026-03-10T03:59:59.999Z");
    expect(
      statement.values.some(
        (value: unknown, index: number) =>
          value === "2026-03-08" &&
          statement.values[index + 1] === "2026-03-08T05:00:00.000Z" &&
          statement.values[index + 2] === "2026-03-09T04:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("continues to read the Shanghai leaderboard daily aggregates", async () => {
    mocks.leaderboardDays.mockResolvedValue([
      {
        statDate: new Date("2026-03-08T16:00:00.000Z"),
        activeSeconds: 30,
        sessions: 1,
        totalTokens: BigInt(50),
      },
    ]);

    const days = await getActivityHeatmap365({
      userId: "user-1",
      timezone: "Asia/Shanghai",
    });

    expect(days.find((day) => day.date === "2026-03-09")).toMatchObject({
      activeSeconds: 30,
      sessions: 1,
      totalTokens: 50,
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.leaderboardDays).toHaveBeenCalledOnce();
  });

  it("uses UTC midnight for the default profile timezone", async () => {
    const days = await getActivityHeatmap365({
      userId: "user-1",
      timezone: "UTC",
    });

    const [statement] = mocks.queryRaw.mock.calls[0];
    const values: unknown[] = statement.values;
    const index = values.indexOf("2026-03-09");
    expect(values[index + 1]).toBe("2026-03-09T00:00:00.000Z");
    expect(values[index + 2]).toBe("2026-03-10T00:00:00.000Z");
    expect(days).toHaveLength(365);
    expect(days.at(-1)).toMatchObject({
      date: "2026-03-09",
      activeSeconds: 0,
      sessions: 0,
      totalTokens: 0,
    });
  });

  it("confirms listed day starts instead of searching every boundary", async () => {
    await getActivityHeatmap365({
      userId: "user-1",
      timezone: "America/New_York",
    });

    // 逐日二分约需一万次时区格式化；校验 day.start 每天只需两次。
    expect(mocks.groupByHourOrDay.mock.calls.length).toBeLessThan(1_000);
  });

  it.each([
    ["America/Santiago", "2026-09-07", "2026-09-07T03:00:00.000Z"],
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00.000Z"],
    ["America/Havana", "2026-03-09", "2026-03-09T04:00:00.000Z"],
    ["Africa/Cairo", "2026-04-24", "2026-04-23T22:00:00.000Z"],
    ["Asia/Kathmandu", "2026-09-07", "2026-09-06T18:15:00.000Z"],
  ])("uses the first UTC instant of %s %s", async (timezone, key, start) => {
    vi.setSystemTime(new Date(`${key}T12:00:00.000Z`));

    const days = await getActivityHeatmap365({ userId: "user-1", timezone });
    const [statement] = mocks.queryRaw.mock.calls[0];
    const values: unknown[] = statement.values;
    const index = values.indexOf(key);
    const previousKey = new Date(
      Date.parse(`${key}T00:00:00.000Z`) - 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const previousIndex = values.indexOf(previousKey);
    const oracleRange = {
      from: new Date(0),
      to: new Date(0),
      granularity: "day" as const,
      preset: "custom" as const,
      timezone,
    };

    expect(index).toBeGreaterThanOrEqual(0);
    expect(values[index + 1]).toBe(start);
    expect(values[previousIndex + 2]).toBe(start);
    expect(groupByHourOrDay(oracleRange, new Date(Date.parse(start) - 1))).toBe(
      previousKey,
    );
    expect(groupByHourOrDay(oracleRange, new Date(start))).toBe(key);
    expect(days.find((day) => day.date === key)).toMatchObject({
      activeSeconds: 0,
      sessions: 0,
      totalTokens: 0,
    });
  });
});
