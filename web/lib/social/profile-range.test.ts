import { describe, expect, it } from "vitest";

import {
  parseProfileRangeQuery,
  profileRangeQuerySchema,
  resolveProfileRange,
} from "./profile-range";

const timezone = "Asia/Shanghai";
const now = new Date("2026-03-24T06:30:00.000Z");

describe("parseProfileRangeQuery", () => {
  it("keeps a valid preset and custom bounds", () => {
    expect(
      parseProfileRangeQuery({
        preset: "custom",
        from: "2026-03-01",
        to: "2026-03-10",
      }),
    ).toEqual({
      preset: "custom",
      from: "2026-03-01",
      to: "2026-03-10",
    });
  });

  it("reads the first value of repeated params", () => {
    expect(parseProfileRangeQuery({ preset: ["7d", "30d"] })).toEqual({
      preset: "7d",
    });
  });

  it("falls back to an empty query instead of throwing on junk input", () => {
    expect(parseProfileRangeQuery({ preset: "year" })).toEqual({});
    expect(parseProfileRangeQuery({ from: "not-a-date" })).toEqual({});
  });

  it("rejects presets the dashboard supports but profiles do not", () => {
    expect(profileRangeQuerySchema.safeParse({ preset: "90d" }).success).toBe(
      false,
    );
  });
});

describe("resolveProfileRange", () => {
  it("defaults to all-time with no date bounds", () => {
    expect(resolveProfileRange({ timezone, now })).toEqual({
      preset: "all",
      range: null,
    });
  });

  it("resolves a rolling preset through the dashboard resolver", () => {
    const selection = resolveProfileRange({
      query: { preset: "7d" },
      timezone,
      now,
    });

    expect(selection.preset).toBe("7d");
    // 2026-03-24 14:30 Shanghai, so the window opens on 2026-03-18 00:00 local.
    expect(selection.range?.from.toISOString()).toBe(
      "2026-03-17T16:00:00.000Z",
    );
    expect(selection.range?.to).toEqual(now);
    expect(selection.range?.granularity).toBe("day");
  });

  it("resolves custom bounds to the edges of the local days", () => {
    const selection = resolveProfileRange({
      query: { preset: "custom", from: "2026-03-01", to: "2026-03-02" },
      timezone,
      now,
    });

    expect(selection.preset).toBe("custom");
    expect(selection.range?.from.toISOString()).toBe(
      "2026-02-28T16:00:00.000Z",
    );
    expect(selection.range?.to.toISOString()).toBe("2026-03-02T15:59:59.999Z");
  });

  it("falls back to all-time when a custom range is missing a bound", () => {
    expect(
      resolveProfileRange({
        query: { preset: "custom", from: "2026-03-01" },
        timezone,
        now,
      }),
    ).toEqual({ preset: "all", range: null });
  });
});
