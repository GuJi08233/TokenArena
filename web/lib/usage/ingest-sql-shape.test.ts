import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synchronizeAchievementsForUser: vi.fn().mockResolvedValue([]),
  getPricingCatalog: vi.fn().mockResolvedValue(null),
  collectAffectedLeaderboardDates: vi.fn((): Date[] => []),
  findExistingSessionStartDates: vi.fn().mockResolvedValue([]),
  invalidateLeaderboardSnapshots: vi.fn().mockResolvedValue(undefined),
  recomputeLeaderboardUserDays: vi.fn().mockResolvedValue(undefined),
  prisma: { $transaction: vi.fn() },
}));

vi.mock("@/lib/achievements/queries", () => ({
  synchronizeAchievementsForUser: mocks.synchronizeAchievementsForUser,
}));
vi.mock("@/lib/pricing/catalog", () => ({
  getPricingCatalog: mocks.getPricingCatalog,
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/leaderboard/aggregates", () => ({
  collectAffectedLeaderboardDates: mocks.collectAffectedLeaderboardDates,
  findExistingSessionStartDates: mocks.findExistingSessionStartDates,
  invalidateLeaderboardSnapshots: mocks.invalidateLeaderboardSnapshots,
  recomputeLeaderboardUserDays: mocks.recomputeLeaderboardUserDays,
}));

import { ingestRequestSchema } from "./contracts";
import { ingestUsagePayload } from "./ingest";

/**
 * Structural checks on the generated `INSERT ... ON CONFLICT` statements.
 *
 * These writes are hand-written SQL rather than Prisma upserts, so the shape
 * mistakes a query builder would have prevented — a column list that does not
 * line up with its SELECT, a conflict target that is not the unique index, a
 * placeholder without a bound value — have to be asserted here.
 */
async function captureStatements() {
  const statements: Array<{ sql: string; text: string; values: unknown[] }> =
    [];
  const tx = {
    $executeRaw: vi.fn(
      (statement: { sql: string; text: string; values: unknown[] }) => {
        statements.push({
          // `.sql` uses `?` placeholders, `.text` the numbered `$n` ones.
          sql: statement.sql,
          text: statement.text,
          values: statement.values,
        });
        return Promise.resolve(1);
      },
    ),
    device: { upsert: vi.fn().mockResolvedValue({}) },
    usageApiKey: { update: vi.fn().mockResolvedValue({}) },
  };
  mocks.prisma.$transaction.mockImplementation(async (callback) =>
    callback(tx),
  );

  const payload = ingestRequestSchema.parse({
    schemaVersion: 2,
    device: { deviceId: "device-1", hostname: "host" },
    buckets: [
      {
        source: "codex",
        model: "gpt-5.4",
        projectKey: "p",
        projectLabel: "P",
        bucketStart: "2026-04-01T12:00:00.000Z",
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 3,
        cachedTokens: 4,
        cacheCreationTokens: 5,
        totalTokens: 15,
      },
    ],
    sessions: [
      {
        source: "codex",
        projectKey: "p",
        projectLabel: "P",
        sessionHash: "with-usage",
        firstMessageAt: "2026-04-01T12:00:00.000Z",
        lastMessageAt: "2026-04-01T12:10:00.000Z",
        durationSeconds: 600,
        activeSeconds: 420,
        messageCount: 8,
        userMessageCount: 3,
        primaryModel: "gpt-5.4",
        modelUsages: [
          {
            model: "gpt-5.4",
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 0,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 3,
          },
        ],
      },
      {
        source: "codex",
        projectKey: "p",
        projectLabel: "P",
        sessionHash: "no-usage",
        firstMessageAt: "2026-04-01T12:00:00.000Z",
        lastMessageAt: "2026-04-01T12:10:00.000Z",
        durationSeconds: 600,
        activeSeconds: 420,
        messageCount: 8,
        userMessageCount: 3,
      },
    ],
    syncAchievements: false,
  });

  await ingestUsagePayload({ userId: "user-1", apiKeyId: "key-1", payload });

  return statements;
}

/** Column names inside the first parenthesised list after `marker`. */
function columnsAfter(sql: string, marker: string) {
  const start = sql.indexOf(marker) + marker.length;
  const open = sql.indexOf("(", start);
  let depth = 0;
  let end = open;

  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  return sql
    .slice(open + 1, end)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

describe("ingest write statements", () => {
  // Every assertion here inspects the same generated statements, so capture
  // them once instead of replaying a full ingest per test.
  let statements: Awaited<ReturnType<typeof captureStatements>>;

  beforeAll(async () => {
    statements = await captureStatements();
  });

  it("emits one statement per table plus one per session usage shape", () => {
    // buckets, sessions-with-usage, sessions-without-usage
    expect(statements).toHaveLength(3);
  });

  it("binds a value for every placeholder", () => {
    for (const statement of statements) {
      const placeholders = statement.text.match(/\$\d+/g) ?? [];
      expect(new Set(placeholders).size).toBe(statement.values.length);
    }
  });

  it("matches each insert column list to its select list", () => {
    for (const statement of statements) {
      const insertColumns = columnsAfter(statement.sql, "INSERT INTO");
      const selectList = statement.sql
        .slice(
          statement.sql.indexOf("SELECT") + "SELECT".length,
          statement.sql.indexOf("FROM (VALUES"),
        )
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

      expect(selectList).toHaveLength(insertColumns.length);
    }
  });

  it("gives every VALUES tuple the same arity as its column aliases", () => {
    for (const statement of statements) {
      const aliases = columnsAfter(statement.text, "AS v");
      const tuple = statement.text
        .slice(
          statement.text.indexOf("FROM (VALUES") + "FROM (VALUES".length,
          statement.text.indexOf("AS v"),
        )
        .match(/\$\d+::[a-z ]+/g);

      expect(tuple).toHaveLength(aliases.length);
    }
  });

  it("binds timestamps as UTC literals, never as Date objects", () => {
    for (const statement of statements) {
      // `::timestamp` ignores an offset instead of applying it, so the bound
      // value has to already be the UTC wall-clock reading.
      expect(statement.values.some((value) => value instanceof Date)).toBe(
        false,
      );
    }

    const bound = statements.flatMap((statement) => statement.values);
    const timestamps = bound.filter(
      (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value),
    );

    expect(timestamps.length).toBeGreaterThan(0);
    for (const value of timestamps) {
      expect(value).toMatch(/Z$/);
    }
  });

  it("conflicts on the declared unique indexes", () => {
    const [buckets, sessions] = statements;

    expect(columnsAfter(buckets.sql, "ON CONFLICT")).toEqual([
      '"userId"',
      '"deviceId"',
      '"source"',
      '"model"',
      '"projectKey"',
      '"bucketStart"',
    ]);
    expect(columnsAfter(sessions.sql, "ON CONFLICT")).toEqual([
      '"userId"',
      '"deviceId"',
      '"source"',
      '"sessionHash"',
    ]);
  });

  it("only writes token columns for the session group that carries usage", () => {
    const [, withUsage, withoutUsage] = statements;

    expect(withUsage.sql).toContain('"totalTokens" = EXCLUDED."totalTokens"');
    // A session without usage must keep whatever totals are already stored.
    expect(withoutUsage.sql).not.toContain(
      '"totalTokens" = EXCLUDED."totalTokens"',
    );
    expect(withoutUsage.sql).toContain(
      '"messageCount" = EXCLUDED."messageCount"',
    );
  });
});
