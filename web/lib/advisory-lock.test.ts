import { describe, expect, it, vi } from "vitest";
import { ADVISORY_LOCK_NAMESPACE, lockAdvisoryKeys } from "./advisory-lock";

describe("lockAdvisoryKeys", () => {
  it("takes every lock in one ordered statement", async () => {
    const db = { $executeRaw: vi.fn().mockResolvedValue(2) };

    await lockAdvisoryKeys(db, ADVISORY_LOCK_NAMESPACE.achievementState, [
      "user-b",
      "user-a",
    ]);

    expect(db.$executeRaw).toHaveBeenCalledOnce();
    const [statement] = db.$executeRaw.mock.calls[0] ?? [];
    expect(statement.sql).toContain("pg_advisory_xact_lock");
    // Ascending key order is what keeps overlapping lock sets deadlock-free.
    expect(statement.sql).toContain('ORDER BY "key"');
    expect(statement.values).toEqual([1, "user-b", "user-a"]);
  });

  it("issues nothing without names", async () => {
    const db = { $executeRaw: vi.fn() };

    await lockAdvisoryKeys(db, ADVISORY_LOCK_NAMESPACE.leaderboardFinalize, []);

    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
