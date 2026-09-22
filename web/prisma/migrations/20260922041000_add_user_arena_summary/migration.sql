-- Materialized arena score/level so a public profile view does not have to
-- replay the user's full bucket and session history plus four global rank
-- queries on every request. Refreshed whenever achievements are synchronized;
-- rows are backfilled lazily on first read.
CREATE TABLE "user_arena_summary" (
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" BIGINT NOT NULL DEFAULT 0,
    "totalEstimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalActiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalSessions" INTEGER NOT NULL DEFAULT 0,
    "totalActiveDays" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_arena_summary_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "user_arena_summary" ADD CONSTRAINT "user_arena_summary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
