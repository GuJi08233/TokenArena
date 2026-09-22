-- `getLastSyncedAt` sorts a user's rows by "updatedAt"; the existing
-- (userId, bucketStart) / (userId, firstMessageAt) indexes cannot serve it, so
-- every dashboard request sorted the user's whole history.
CREATE INDEX "UsageBucket_userId_updatedAt_idx" ON "UsageBucket"("userId", "updatedAt");
CREATE INDEX "UsageSession_userId_updatedAt_idx" ON "UsageSession"("userId", "updatedAt");

-- Every leaderboard query joins UsagePreference on this flag to drop private
-- profiles, previously without an index to filter on.
CREATE INDEX "UsagePreference_publicProfileEnabled_idx" ON "UsagePreference"("publicProfileEnabled");
