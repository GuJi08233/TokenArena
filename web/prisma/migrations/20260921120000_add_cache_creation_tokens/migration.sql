-- 缓存写入单独计数，旧记录由客户端重新采集补齐。
ALTER TABLE "UsageBucket" ADD COLUMN "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "UsageSession" ADD COLUMN "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "leaderboard_user_day" ADD COLUMN "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "leaderboard_snapshot_entry" ADD COLUMN "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "leaderboard_period_entry" ADD COLUMN "cacheCreationTokens" BIGINT NOT NULL DEFAULT 0;
