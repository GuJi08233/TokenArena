import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCliVersionCache, getCliVersion } from "./cli-version";

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

function resolveFrom(moduleDir: string) {
  return getCliVersion(pathToFileURL(join(moduleDir, "index.js")).href);
}

beforeEach(() => {
  clearCliVersionCache();
});

afterEach(() => {
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

    writePackageJson(dir, { name: "cli", version: "1.2.3" });

    expect(resolveFrom(join(dir, "dist"))).toBe("1.2.3");
  });

  it("walks up from deeply nested unbundled sources", () => {
    const dir = createTempDir();

    writePackageJson(dir, { name: "cli", version: "4.5.6" });

    expect(
      getCliVersion(
        pathToFileURL(
          join(dir, "src", "infrastructure", "runtime", "cli-version.ts"),
        ).href,
      ),
    ).toBe("4.5.6");
  });

  it("stops at the nearest package.json instead of an ancestor's", () => {
    const dir = createTempDir();
    const innerDir = join(dir, "nested");

    writePackageJson(dir, { name: "host-app", version: "9.9.9" });
    writePackageJson(innerDir, { name: "cli", version: "2.0.0" });

    expect(resolveFrom(join(innerDir, "dist"))).toBe("2.0.0");
  });

  it.each([
    ["is malformed", "{ not json"],
    ["has no version", { name: "cli" }],
    ["has an empty version", { name: "cli", version: "" }],
    ["has a non-string version", { name: "cli", version: 1 }],
  ])("falls back to 0.0.0 when the nearest package.json %s", (_label, contents) => {
    const dir = createTempDir();
    const innerDir = join(dir, "nested");

    // An ancestor with a perfectly good version must not be picked up.
    writePackageJson(dir, { name: "host-app", version: "9.9.9" });
    writePackageJson(innerDir, contents);

    expect(resolveFrom(join(innerDir, "dist"))).toBe("0.0.0");
  });

  it("resolves a version even when the owning package.json has no name", () => {
    const dir = createTempDir();

    writePackageJson(dir, { private: true, version: "0.14.2" });

    expect(resolveFrom(join(dir, "dist"))).toBe("0.14.2");
  });

  it("caches the resolved version per module directory", () => {
    const dir = createTempDir();
    const other = createTempDir();

    writePackageJson(dir, { name: "cli", version: "7.8.9" });
    writePackageJson(other, { name: "cli", version: "3.2.1" });

    expect(resolveFrom(join(dir, "dist"))).toBe("7.8.9");
    expect(resolveFrom(join(other, "dist"))).toBe("3.2.1");

    writePackageJson(dir, { name: "cli", version: "1.0.0" });
    writePackageJson(other, { name: "cli", version: "1.0.0" });

    // Each module directory keeps its own memoized answer.
    expect(resolveFrom(join(dir, "dist"))).toBe("7.8.9");
    expect(resolveFrom(join(other, "dist"))).toBe("3.2.1");
  });

  it("re-resolves after the cache is cleared", () => {
    const dir = createTempDir();

    writePackageJson(dir, { name: "cli", version: "5.0.0" });
    expect(resolveFrom(join(dir, "dist"))).toBe("5.0.0");

    writePackageJson(dir, { name: "cli", version: "6.0.0" });
    clearCliVersionCache();

    expect(resolveFrom(join(dir, "dist"))).toBe("6.0.0");
  });
});
