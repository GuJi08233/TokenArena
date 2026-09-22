import { describe, expect, it } from "vitest";
import {
  LEADERBOARD_SNAPSHOT_MIN_LIFETIME_MS,
  LEADERBOARD_SNAPSHOT_TTL_MS,
  resolveAffectedSnapshotPeriods,
  resolveStaleSnapshotGeneratedAt,
} from "./snapshot";

// A Wednesday, so the Shanghai week window runs 2026-03-23 .. 2026-03-30.
const now = new Date("2026-03-25T06:00:00.000Z");

describe("resolveStaleSnapshotGeneratedAt", () => {
  it("leaves the snapshot exactly one min-lifetime away from expiry", () => {
    const staleAt = resolveStaleSnapshotGeneratedAt(now);
    const remaining =
      LEADERBOARD_SNAPSHOT_TTL_MS - (now.getTime() - staleAt.getTime());

    expect(remaining).toBe(LEADERBOARD_SNAPSHOT_MIN_LIFETIME_MS);
  });
});

describe("resolveAffectedSnapshotPeriods", () => {
  it("returns nothing when no days changed", () => {
    expect(resolveAffectedSnapshotPeriods([], now)).toEqual([]);
  });

  it("returns every period for a change inside today", () => {
    expect(
      resolveAffectedSnapshotPeriods(
        [new Date("2026-03-25T04:00:00.000Z")],
        now,
      ),
    ).toEqual(["day", "week", "month", "all_time"]);
  });

  it("skips the day window for an earlier day in the same week", () => {
    expect(
      resolveAffectedSnapshotPeriods(
        [new Date("2026-03-23T04:00:00.000Z")],
        now,
      ),
    ).toEqual(["week", "month", "all_time"]);
  });

  it("skips day and week for an earlier day in the same month", () => {
    expect(
      resolveAffectedSnapshotPeriods(
        [new Date("2026-03-02T04:00:00.000Z")],
        now,
      ),
    ).toEqual(["month", "all_time"]);
  });

  it("only affects all_time when backfilling an old day", () => {
    expect(
      resolveAffectedSnapshotPeriods(
        [new Date("2024-01-05T04:00:00.000Z")],
        now,
      ),
    ).toEqual(["all_time"]);
  });

  it("unions the periods across a mixed batch of days", () => {
    expect(
      resolveAffectedSnapshotPeriods(
        [
          new Date("2024-01-05T04:00:00.000Z"),
          new Date("2026-03-25T04:00:00.000Z"),
        ],
        now,
      ),
    ).toEqual(["day", "week", "month", "all_time"]);
  });
});
