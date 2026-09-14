import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Returns a factory for temp directories that are removed after each test.
 *
 * Registers its own `afterEach`, so a caller only keeps the factory. Removal
 * retries because on Windows a search indexer or virus scanner holding a handle
 * makes `rmSync` throw EPERM/EBUSY — which used to fail the hook and leak every
 * directory still queued behind the one that threw.
 *
 * @param defaultPrefix used when the factory is called without an argument.
 */
export function useTempDirs(
  defaultPrefix = "tokenarena-test-",
): (prefix?: string) => string {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 100,
      });
    }
  });

  return (prefix = defaultPrefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
