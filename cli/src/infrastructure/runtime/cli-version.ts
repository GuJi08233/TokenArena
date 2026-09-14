import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSafe } from "../fs/utils";

const FALLBACK_VERSION = "0.0.0";

const versionCache = new Map<string, string>();

/**
 * Reads the version of the package that owns `startDir`.
 *
 * The nearest package.json wins and ends the walk, the same way Node resolves a
 * package boundary. A manifest that is unreadable, malformed or carries no
 * usable version yields `undefined` rather than resuming the walk: reporting an
 * unrelated ancestor package's version as the CLI's own is far worse than the
 * honest `0.0.0` fallback, because it is indistinguishable from a correct answer.
 */
function readPackageVersion(startDir: string): string | undefined {
  let dir = startDir;

  while (true) {
    const contents = readFileSafe(join(dir, "package.json"));

    if (contents !== null) {
      try {
        const { version } = JSON.parse(contents) as { version?: unknown };

        return typeof version === "string" && version.length > 0
          ? version
          : undefined;
      } catch {
        return undefined;
      }
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return undefined;
    }

    dir = parent;
  }
}

/**
 * Resolves the CLI version from the nearest owning package.json.
 *
 * The lookup walks up from this module's directory instead of assuming a single
 * level (`dist/` -> package root), so it also works when the sources run
 * unbundled (`tsx src/index.ts`) and are nested several directories deep.
 */
export function getCliVersion(metaUrl = import.meta.url): string {
  const startDir = dirname(fileURLToPath(metaUrl));
  const cached = versionCache.get(startDir);

  // Presence, not truthiness: an empty cached value must still short-circuit.
  if (cached !== undefined) {
    return cached;
  }

  const version = readPackageVersion(startDir) ?? FALLBACK_VERSION;
  versionCache.set(startDir, version);

  return version;
}

/** Drops the memoized versions. Exists so tests stay order-independent. */
export function clearCliVersionCache(): void {
  versionCache.clear();
}
