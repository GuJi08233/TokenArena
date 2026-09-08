import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSqliteRows, warnWhenWalSkipped } from "./sqlite";

// `node:sqlite` only exists on Node 22.5+, and the CLI matrix still covers
// Node 20. There the builtin reader bails out to the sqlite3 CLI and the
// paths below never run, so they are skipped rather than rewritten against an
// external binary that may not be installed.
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

describe("warnWhenWalSkipped", () => {
  it("reports how many bytes the immutable read left behind", () => {
    const dbPath = join(makeTempDir(), "usage.sqlite");
    writeFileSync(dbPath, "");
    writeFileSync(`${dbPath}-wal`, "x".repeat(4152));

    const stderrSpy = spyOnStderr();
    warnWhenWalSkipped(dbPath);

    const warning = findWalWarning(stderrSpy);
    expect(warning).toContain(dbPath);
    expect(warning).toContain("4152 bytes pending");
  });

  it("stays quiet when no write-ahead log exists", () => {
    const dbPath = join(makeTempDir(), "usage.sqlite");
    writeFileSync(dbPath, "");

    const stderrSpy = spyOnStderr();
    warnWhenWalSkipped(dbPath);

    expect(findWalWarning(stderrSpy)).toBeNull();
  });

  it("stays quiet when the write-ahead log is empty", () => {
    const dbPath = join(makeTempDir(), "usage.sqlite");
    writeFileSync(dbPath, "");
    writeFileSync(`${dbPath}-wal`, "");

    const stderrSpy = spyOnStderr();
    warnWhenWalSkipped(dbPath);

    expect(findWalWarning(stderrSpy)).toBeNull();
  });

  it("never throws when the database path is unusable", () => {
    const stderrSpy = spyOnStderr();

    // A missing directory must not turn a successful read into a failure.
    expect(() =>
      warnWhenWalSkipped(join(makeTempDir(), "absent", "usage.sqlite")),
    ).not.toThrow();
    expect(findWalWarning(stderrSpy)).toBeNull();
  });
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

    // Holding this connection open keeps the row below out of the main file,
    // so the read has to consult the -wal to see it.
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
