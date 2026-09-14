import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

const versionCache = new Map<string, string>();

function readPackageVersion(startDir: string): string | undefined {
  let dir = startDir;
  const { root } = parse(dir);

  while (true) {
    const packageJsonPath = join(dir, "package.json");

    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, "utf-8"),
        ) as { name?: unknown; version?: unknown };

        if (
          typeof packageJson.name === "string" &&
          typeof packageJson.version === "string"
        ) {
          return packageJson.version;
        }
      } catch {
        // Ignore malformed package.json and keep walking up.
      }
    }

    if (dir === root) {
      return undefined;
    }

    dir = dirname(dir);
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

  if (cached) {
    return cached;
  }

  const version = readPackageVersion(startDir) ?? FALLBACK_VERSION;
  versionCache.set(startDir, version);

  return version;
}
