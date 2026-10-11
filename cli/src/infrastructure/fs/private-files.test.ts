import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../testing/temp-dir";
import {
  ensurePrivateDir,
  restrictToOwner,
  writePrivateFile,
} from "./private-files";

const posixIt = process.platform === "win32" ? it.skip : it;

function permissions(path: string) {
  return statSync(path).mode & 0o777;
}

describe("private files", () => {
  const makeTempDir = useTempDirs();

  posixIt("creates directories readable by the owner only", () => {
    const dir = join(makeTempDir("private-files-"), "a", "b");

    ensurePrivateDir(dir);

    expect(permissions(dir)).toBe(0o700);
  });

  posixIt("tightens a directory an older version left open", () => {
    const dir = join(makeTempDir("private-files-"), "config");
    mkdirSync(dir, { mode: 0o755 });

    ensurePrivateDir(dir);

    expect(permissions(dir)).toBe(0o700);
  });

  posixIt("replaces a world-readable file with an owner-only one", () => {
    const file = join(makeTempDir("private-files-"), "config.json");
    writeFileSync(file, "old", { mode: 0o644 });

    writePrivateFile(file, "new");

    expect(readFileSync(file, "utf-8")).toBe("new");
    expect(permissions(file)).toBe(0o600);
  });

  posixIt("drops group and other bits from an existing file", () => {
    const file = join(makeTempDir("private-files-"), "status.json");
    writeFileSync(file, "{}", { mode: 0o664 });

    restrictToOwner(file);

    expect(permissions(file)).toBe(0o600);
  });

  it("ignores a path that does not exist", () => {
    expect(() =>
      restrictToOwner(join(makeTempDir("private-files-"), "missing")),
    ).not.toThrow();
  });
});
