import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reports whether the module identified by `metaUrl` is the process entry point.
 *
 * `metaUrl` is required on purpose: a default of `import.meta.url` would resolve
 * to this helper's own file, which only equals the entry point once tsup has
 * inlined everything into dist/index.js. Callers must pass their own URL, or
 * `tsx src/index.ts` silently no-ops.
 */
export function isMainModule(
  metaUrl: string,
  argvEntry = process.argv[1],
): boolean {
  if (!argvEntry) {
    return false;
  }

  const currentModulePath = fileURLToPath(metaUrl);

  try {
    return realpathSync(argvEntry) === realpathSync(currentModulePath);
  } catch {
    if (!existsSync(argvEntry)) {
      return false;
    }

    return resolve(argvEntry) === resolve(currentModulePath);
  }
}
