import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end check of the hand-written ingest SQL against a real Postgres.
 *
 * `upsertBuckets` / `upsertSessions` are `INSERT ... ON CONFLICT` statements
 * rather than Prisma upserts, so the shape assertions in `ingest-sql-shape`
 * cannot tell us whether Postgres actually accepts them or what it stores.
 * Every case below pins a decision in that SQL that a mock cannot verify.
 *
 * Skipped unless `VERIFY_DATABASE_URL` points at a **scratch** database:
 *
 *   docker run -d --name ta-verify -e POSTGRES_PASSWORD=verify \
 *     -e POSTGRES_USER=verify -e POSTGRES_DB=token_arena_verify \
 *     -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://verify:verify@127.0.0.1:55432/token_arena_verify \
 *     pnpm exec prisma migrate deploy
 *   VERIFY_DATABASE_URL=postgresql://verify:verify@127.0.0.1:55432/token_arena_verify \
 *     pnpm exec vitest run lib/usage/ingest-db.test.ts
 *
 * It uses its own variable rather than `DATABASE_URL` because `vitest.config.ts`
 * pins that one for the unit tests.
 */
const VERIFY_URL = process.env.VERIFY_DATABASE_URL;

const mocks = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/prisma", async () => {
  const url = process.env.VERIFY_DATABASE_URL;

  if (!url) {
    // Suite is skipped; hand back a stub so the import graph still resolves.
    return { prisma: {} };
  }

  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  mocks.client = client;

  return { prisma: client };
});

// The real one wraps its fetch in Next's `unstable_cache`, which needs a
// request context this process does not have. Pricing only affects the
// estimated-cost column, not the SQL under test.
vi.mock("@/lib/pricing/catalog", () => ({
  getPricingCatalog: async () => null,
}));

const RUN = randomUUID().slice(0, 8);
const USER_ID = `verify-${RUN}`;
const DEVICE_ID = `device-${RUN}`;
const BUCKET_START = "2026-04-01T12:00:00.000Z";
const FIRST_MESSAGE_AT = "2026-04-01T12:00:00.000Z";
const LAST_MESSAGE_AT = "2026-04-01T12:10:00.000Z";

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    source: "codex",
    model: "gpt-5.4",
    projectKey: "project-a",
    projectLabel: "Project A",
    bucketStart: BUCKET_START,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 25,
    cachedTokens: 10,
    cacheCreationTokens: 5,
    totalTokens: 190,
    ...overrides,
  };
}

function flatBucket(inputTokens: number) {
  return bucket({
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: inputTokens,
  });
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    source: "codex",
    projectKey: "project-a",
    projectLabel: "Project A",
    sessionHash: "session-with-usage",
    firstMessageAt: FIRST_MESSAGE_AT,
    lastMessageAt: LAST_MESSAGE_AT,
    durationSeconds: 600,
    activeSeconds: 420,
    messageCount: 8,
    userMessageCount: 3,
    ...overrides,
  };
}

describe.skipIf(!VERIFY_URL)("ingest against a real database", () => {
  // biome-ignore lint/suspicious/noExplicitAny: resolved from the mocked module
  let prisma: any;
  // biome-ignore lint/suspicious/noExplicitAny: resolved from the mocked module
  let ingestUsagePayload: any;
  // biome-ignore lint/suspicious/noExplicitAny: resolved from the mocked module
  let ingestRequestSchema: any;
  let apiKeyId: string;

  async function ingest(
    input: { buckets?: unknown[]; sessions?: unknown[] },
    options: { apiKeyId?: string | null; syncAchievements?: boolean } = {},
  ) {
    return ingestUsagePayload({
      userId: USER_ID,
      apiKeyId:
        options.apiKeyId === null ? undefined : (options.apiKeyId ?? apiKeyId),
      payload: ingestRequestSchema.parse({
        schemaVersion: 2,
        device: { deviceId: DEVICE_ID, hostname: "verify-host" },
        buckets: input.buckets ?? [],
        sessions: input.sessions ?? [],
        syncAchievements: options.syncAchievements ?? false,
      }),
    });
  }

  const readBucket = () =>
    prisma.usageBucket.findFirst({ where: { userId: USER_ID } });
  const readSession = (sessionHash: string) =>
    prisma.usageSession.findFirst({ where: { userId: USER_ID, sessionHash } });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ ingestUsagePayload } = await import("./ingest"));
    ({ ingestRequestSchema } = await import("./contracts"));

    // The only safe target is an empty database. A real one has accounts, so
    // this turns a mistyped connection string into a clean failure.
    const users = await prisma.user.count();
    if (users > 0) {
      throw new Error(
        `Refusing to run: ${users} user account(s) already exist, so this is ` +
          "not a scratch database.",
      );
    }

    await prisma.user.create({
      data: {
        id: USER_ID,
        name: "Ingest SQL Verification",
        username: `verify_${RUN}`,
        email: `verify-${RUN}@example.invalid`,
      },
    });
    const key = await prisma.usageApiKey.create({
      data: {
        userId: USER_ID,
        name: "verify",
        prefix: `ta_${RUN}`,
        keyHash: `hash-${RUN}`,
      },
    });
    apiKeyId = key.id;
  });

  afterAll(async () => {
    if (!prisma?.user) return;
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    // Snapshots are global rather than owned by a user, so deleting the
    // verification account does not cascade to them and a leftover row would
    // break the next run.
    await prisma.leaderboardSnapshot.deleteMany({});
    await prisma.$disconnect();
  });

  it("inserts buckets and sessions on first ingest", async () => {
    await ingest({
      buckets: [bucket()],
      sessions: [
        session({
          modelUsages: [
            {
              model: "gpt-5.4",
              inputTokens: 100,
              outputTokens: 50,
              reasoningTokens: 25,
              cachedTokens: 10,
              cacheCreationTokens: 5,
              totalTokens: 190,
            },
          ],
        }),
        session({ sessionHash: "session-no-usage" }),
      ],
    });

    const row = await readBucket();
    expect(row).not.toBeNull();
    expect(row.inputTokens).toBe(BigInt(100));
    // Re-derived from the parts, not taken from the payload.
    expect(row.totalTokens).toBe(BigInt(190));
    expect(row.apiKeyId).toBe(apiKeyId);
    expect(row.createdAt).toBeInstanceOf(Date);

    const withUsage = await readSession("session-with-usage");
    expect(withUsage.totalTokens).toBe(BigInt(190));

    const noUsage = await readSession("session-no-usage");
    expect(noUsage.totalTokens).toBe(BigInt(0));
    expect(noUsage.messageCount).toBe(8);
  });

  it("round-trips timestamps without a timezone shift", async () => {
    const row = await readBucket();
    const withUsage = await readSession("session-with-usage");

    // `timestamp(3)` holds the UTC reading; a shift by the local offset — the
    // classic hazard when binding dates into raw SQL — would surface here.
    expect(row.bucketStart.toISOString()).toBe(BUCKET_START);
    expect(withUsage.firstMessageAt.toISOString()).toBe(FIRST_MESSAGE_AT);
    expect(withUsage.lastMessageAt.toISOString()).toBe(LAST_MESSAGE_AT);
  });

  it("updates in place instead of inserting a duplicate", async () => {
    await ingest({ buckets: [bucket({ inputTokens: 200, totalTokens: 290 })] });

    expect(await prisma.usageBucket.count({ where: { userId: USER_ID } })).toBe(
      1,
    );
    const row = await readBucket();
    expect(row.inputTokens).toBe(BigInt(200));
    expect(row.totalTokens).toBe(BigInt(290));
  });

  it("keeps stored totals when a session arrives without usage", async () => {
    await ingest({
      sessions: [session({ messageCount: 99, modelUsages: undefined })],
    });

    const row = await readSession("session-with-usage");
    expect(row.totalTokens).toBe(BigInt(190));
    expect(row.messageCount).toBe(99);
  });

  it("keeps the stored apiKeyId when a request carries none", async () => {
    await ingest({ buckets: [flatBucket(300)] }, { apiKeyId: null });

    const row = await readBucket();
    expect(row.apiKeyId).toBe(apiKeyId);
    expect(row.inputTokens).toBe(BigInt(300));
  });

  it("collapses duplicate conflict keys in one batch", async () => {
    // Postgres rejects a statement that updates the same row twice, so the
    // dedupe has to happen before the statement is built.
    await ingest({ buckets: [flatBucket(11), flatBucket(22)] });

    expect(await prisma.usageBucket.count({ where: { userId: USER_ID } })).toBe(
      1,
    );
    expect((await readBucket()).inputTokens).toBe(BigInt(22));
  });

  it("refreshes the leaderboard day aggregate", async () => {
    const day = await prisma.leaderboardUserDay.findFirst({
      where: { userId: USER_ID },
    });

    expect(day).not.toBeNull();
    expect(day.totalTokens).toBe(BigInt(22));
  });

  it("materializes the arena summary when achievements sync", async () => {
    await ingest({ buckets: [flatBucket(33)] }, { syncAchievements: true });

    const arena = await prisma.userArenaSummary.findUnique({
      where: { userId: USER_ID },
    });

    expect(arena).not.toBeNull();
    expect(arena.totalTokens).toBe(BigInt(33));
  });

  it("ages only the affected leaderboard snapshots", async () => {
    await prisma.leaderboardSnapshot.deleteMany({});
    const snapshot = await prisma.leaderboardSnapshot.create({
      data: {
        period: "all_time",
        metric: "total_tokens",
        generatedAt: new Date(),
      },
    });

    await ingest({ buckets: [flatBucket(44)] });

    const after = await prisma.leaderboardSnapshot.findUnique({
      where: { id: snapshot.id },
    });
    // Aged back toward expiry rather than deleted.
    expect(after).not.toBeNull();
    expect(after.generatedAt.getTime()).toBeLessThan(
      snapshot.generatedAt.getTime(),
    );
  });
});
