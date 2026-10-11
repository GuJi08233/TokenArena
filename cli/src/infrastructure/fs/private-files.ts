import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

/**
 * Owner-only permissions for what the CLI keeps on disk: the config holds the
 * API key, and the state files hold usage with project names.
 *
 * Everything used to be written with the default umask, so `config.json` came
 * out world-readable (`0644`) in a world-readable directory, and any other
 * local account could read the API key. POSIX only: Windows ignores the mode
 * bits beyond read-only, and its profile directories are private by default.
 */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Drop group and other permissions from an existing file or directory. */
export function restrictToOwner(path: string) {
  if (process.platform === "win32") {
    return;
  }

  try {
    const { mode } = statSync(path);
    if ((mode & 0o077) !== 0) {
      chmodSync(path, mode & 0o700);
    }
  } catch {
    // Missing, or not ours to change: nothing to tighten.
  }
}

/** Create a directory, and any missing parents, readable by its owner only. */
export function ensurePrivateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  // `mode` only applies to directories mkdir creates.
  restrictToOwner(path);
}

/**
 * Write a file readable by its owner only.
 *
 * The content goes to a fresh temporary file created with the private mode and
 * is renamed into place, so it never exists with wider permissions, even when
 * replacing a file an older version wrote, and a reader never sees it half
 * written.
 */
export function writePrivateFile(path: string, content: string) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  writeFileSync(temporaryPath, content, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });

  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
