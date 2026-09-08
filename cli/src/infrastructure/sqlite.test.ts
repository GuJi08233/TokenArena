import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSqliteRows } from "./sqlite";

// `node:sqlite` only exists on Node 22.5+, and the CLI matrix still covers
// Node 20. There the builtin reader bails out to the sqlite3 CLI and the
// fallback chain under test never runs, so these cases are skipped rather
// than rewritten against an external binary that may not be installed.
let sqliteModule: typeof import("node:sqlite") | null = null;
try {
  sqliteModule = await import("node:sqlite");
} catch {
  sqliteModule = null;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Build a WAL database whose newest row is still only in the -wal file, then
 * copy the pair somewhere the -shm file cannot be created. Opening that copy
 * fails for read-write and succeeds only for the immutable fallback, which is
 * the exact situation the warning exists for.
 */
function makeDatabaseThatOnlyOpensImmutable(options: { copyWal: boolean }): {
  dbPath: string;
} {
  const DatabaseSync = sqliteModule?.DatabaseSync;
  if (!DatabaseSync) throw new Error("node:sqlite unavailable");

  const dir = makeTempDir();
  const sourcePath = join(dir, "source.sqlite");

  const setup = new DatabaseSync(sourcePath);
  setup.exec("PRAGMA journal_mode=WAL");
  setup.exec("CREATE TABLE usage(id TEXT)");
  setup.exec("INSERT INTO usage VALUES ('checkpointed')");
  setup.close();

  // Holding this connection open keeps the row below out of the main file.
  const holder = new DatabaseSync(sourcePath);
  holder.exec("INSERT INTO usage VALUES ('pending-in-wal')");

  const dbPath = join(dir, "target.sqlite");
  copyFileSync(sourcePath, dbPath);
  if (options.copyWal) {
    copyFileSync(`${sourcePath}-wal`, `${dbPath}-wal`);
  }
  holder.close();

  // A directory squatting on the -shm path is what makes the shared-memory
  // index uncreatable, mirroring a read-only database directory.
  mkdirSync(`${dbPath}-shm`);

  return { dbPath };
}

function spyOnStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

function findWalWarning(spy: ReturnType<typeof spyOnStderr>): string | null {
  for (const call of spy.mock.calls) {
    const line = String(call[0]);
    if (line.includes("write-ahead log")) return line;
  }
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!sqliteModule)("readSqliteRows", () => {
  it("reads rows including ones still pending in the write-ahead log", async () => {
    const DatabaseSync = sqliteModule?.DatabaseSync;
    if (!DatabaseSync) return;

    const dbPath = join(makeTempDir(), "usage.sqlite");
    const setup = new DatabaseSync(dbPath);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.exec("CREATE TABLE usage(id TEXT)");
    setup.exec("INSERT INTO usage VALUES ('checkpointed')");
    setup.close();

    const holder = new DatabaseSync(dbPath);
    holder.exec("INSERT INTO usage VALUES ('pending-in-wal')");

    const stderrSpy = spyOnStderr();
    try {
      const rows = await readSqliteRows<{ id: string }>(
        dbPath,
        "SELECT id FROM usage",
      );

      expect(rows.map((row) => row.id)).toEqual([
        "checkpointed",
        "pending-in-wal",
      ]);
      // The read-write path sees the WAL, so there is nothing to warn about.
      expect(findWalWarning(stderrSpy)).toBeNull();
    } finally {
      holder.close();
    }
  });

  it("warns when the immutable fallback skips pending write-ahead log data", async () => {
    const { dbPath } = makeDatabaseThatOnlyOpensImmutable({ copyWal: true });
    const stderrSpy = spyOnStderr();

    const rows = await readSqliteRows<{ id: string }>(
      dbPath,
      "SELECT id FROM usage",
    );

    // Only the main file is readable, so the pending row is absent...
    expect(rows.map((row) => row.id)).toEqual(["checkpointed"]);
    // ...and that loss is reported instead of passing silently.
    const warning = findWalWarning(stderrSpy);
    expect(warning).toContain(dbPath);
    expect(warning).toContain("bytes pending");
  });

  it("stays quiet on the immutable fallback when no write-ahead log is left behind", async () => {
    const { dbPath } = makeDatabaseThatOnlyOpensImmutable({ copyWal: false });
    const stderrSpy = spyOnStderr();

    const rows = await readSqliteRows<{ id: string }>(
      dbPath,
      "SELECT id FROM usage",
    );

    expect(rows.map((row) => row.id)).toEqual(["checkpointed"]);
    expect(findWalWarning(stderrSpy)).toBeNull();
  });

  it("propagates query errors instead of retrying the fallback", async () => {
    const DatabaseSync = sqliteModule?.DatabaseSync;
    if (!DatabaseSync) return;

    const dbPath = join(makeTempDir(), "usage.sqlite");
    const setup = new DatabaseSync(dbPath);
    setup.exec("CREATE TABLE usage(id TEXT)");
    setup.close();

    await expect(
      readSqliteRows(dbPath, "SELECT id FROM missing_table"),
    ).rejects.toThrow(/no such table/i);
  });
});
