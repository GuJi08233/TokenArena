-- The cost board had no snapshot at all: every request ran a full
-- GROUP BY (userId, model) over UsageBucket and ranked it in the application.
-- Give the snapshot a metric dimension so both boards share the same cache.
CREATE TYPE "LeaderboardSnapshotMetric" AS ENUM ('total_tokens', 'estimated_cost');

ALTER TABLE "leaderboard_snapshot"
  ADD COLUMN "metric" "LeaderboardSnapshotMetric" NOT NULL DEFAULT 'total_tokens';

-- Existing rows are all token boards, so widening the key keeps them valid.
DROP INDEX "leaderboard_snapshot_period_key";
CREATE UNIQUE INDEX "leaderboard_snapshot_period_metric_key" ON "leaderboard_snapshot"("period", "metric");

-- Cost entries need their ranking value persisted; token entries leave it at 0
-- and recompute cost on hydration as before.
ALTER TABLE "leaderboard_snapshot_entry"
  ADD COLUMN "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
