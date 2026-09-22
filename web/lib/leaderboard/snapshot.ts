import { resolveLeaderboardWindow } from "./date";
import { type LeaderboardPeriod, leaderboardPeriods } from "./types";

/** How long a rebuilt global snapshot may be served before it is recomputed. */
export const LEADERBOARD_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/**
 * Floor on how long an invalidated snapshot stays serveable.
 *
 * Invalidation is global (one snapshot row per period, shared by every viewer)
 * but it is triggered per user, on every ingest. Deleting the snapshot outright
 * meant that with N syncing devices the effective cache lifetime collapsed to
 * roughly `syncInterval / N`, so the TTL above never applied and the leaderboard
 * page rebuilt from a full `GROUP BY` almost every time. Instead of dropping the
 * snapshot, invalidation ages it so it expires after this window, which bounds
 * rebuilds to at most one per period per window while keeping the board fresh
 * to within half a minute.
 */
export const LEADERBOARD_SNAPSHOT_MIN_LIFETIME_MS = 30 * 1000;

/**
 * The `generatedAt` an invalidated snapshot is aged back to.
 *
 * Callers must only apply it to snapshots that are currently *newer* than this,
 * otherwise invalidation would extend the life of an already-stale snapshot.
 */
export function resolveStaleSnapshotGeneratedAt(now: Date) {
  return new Date(
    now.getTime() -
      (LEADERBOARD_SNAPSHOT_TTL_MS - LEADERBOARD_SNAPSHOT_MIN_LIFETIME_MS),
  );
}

/**
 * Periods whose current window covers at least one of the changed days.
 *
 * `all_time` is unbounded so any change lands in it. The bounded periods are
 * skipped when a sync only backfills history — a first-time sync carrying years
 * of data used to invalidate today's board as well.
 */
export function resolveAffectedSnapshotPeriods(
  dates: Date[],
  now = new Date(),
): LeaderboardPeriod[] {
  if (dates.length === 0) {
    return [];
  }

  return leaderboardPeriods.filter((period) => {
    const window = resolveLeaderboardWindow(period, now);

    if (!window.start || !window.end) {
      return true;
    }

    const start = window.start.getTime();
    const end = window.end.getTime();

    return dates.some((date) => {
      const value = date.getTime();
      return value >= start && value < end;
    });
  });
}
