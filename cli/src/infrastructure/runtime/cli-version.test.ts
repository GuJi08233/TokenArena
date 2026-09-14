import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliVersion } from "./cli-version";

/**
 * `getCliVersion` walks up to the filesystem root, so the "no package.json
 * found" branch can only be exercised deterministically by hiding package
 * manifests from the walk.
 */
const fsState = { hidePackageJson: false };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (fsState.hidePackageJson && String(path).endsWith("package.json")) {
        return false;
      }

      return actual.existsSync(path);
    },
  };
});

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tokenarena-cli-version-"));
  tempDirs.push(dir);
  return dir;
}

function writePackageJson(dir: string, contents: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf-8",
  );
}

afterEach(() => {
  fsState.hidePackageJson = false;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("getCliVersion", () => {
  it("reads the version from the owning package.json in a bundled layout", () => {
    const dir = createTempDir();
    const moduleDir = join(dir, "dist");

    writePackageJson(dir, { name: "cli", version: "1.2.3" });

    expect(getCliVersion(pathToFileURL(join(moduleDir, "index.js")).href)).toBe(
      "1.2.3",
    );
  });

  it("walks up from deeply nested unbundled sources", () => {
    const dir = createTempDir();
    const moduleDir = join(dir, "src", "infrastructure", "runtime");

    writePackageJson(dir, { name: "cli", version: "4.5.6" });

    expect(
      getCliVersion(pathToFileURL(join(moduleDir, "cli-version.ts")).href),
    ).toBe("4.5.6");
  });

  it("skips package.json files that are not a named package", () => {
    const dir = createTempDir();
    const innerDir = join(dir, "nested");
    const moduleDir = join(innerDir, "dist");

    writePackageJson(dir, { name: "cli", version: "2.0.0" });
    writePackageJson(innerDir, { private: true, version: "9.9.9" });

    expect(getCliVersion(pathToFileURL(join(moduleDir, "index.js")).href)).toBe(
      "2.0.0",
    );
  });

  it("skips malformed package.json files", () => {
    const dir = createTempDir();
    const innerDir = join(dir, "nested");
    const moduleDir = join(innerDir, "dist");

    writePackageJson(dir, { name: "cli", version: "3.0.0" });
    writePackageJson(innerDir, "{ not json");

    expect(getCliVersion(pathToFileURL(join(moduleDir, "index.js")).href)).toBe(
      "3.0.0",
    );
  });

  it("falls back to 0.0.0 when no package.json is found", () => {
    const dir = createTempDir();

    fsState.hidePackageJson = true;

    expect(getCliVersion(pathToFileURL(join(dir, "index.js")).href)).toBe(
      "0.0.0",
    );
  });

  it("caches the resolved version per module directory", () => {
    const dir = createTempDir();
    const moduleDir = join(dir, "dist");

    writePackageJson(dir, { name: "cli", version: "7.8.9" });

    const metaUrl = pathToFileURL(join(moduleDir, "index.js")).href;

    expect(getCliVersion(metaUrl)).toBe("7.8.9");

    writePackageJson(dir, { name: "cli", version: "1.0.0" });

    expect(getCliVersion(metaUrl)).toBe("7.8.9");
  });
});
