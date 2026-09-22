import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ParseResult } from "../domain/types";
import { getCliVersion } from "../infrastructure/runtime/cli-version";
import { getStateDir } from "../infrastructure/runtime/paths";

/**
 * Bump when the cached shape changes. Old files then fail to match and the
 * tool falls back to a full scan instead of being read with the wrong meaning.
 */
const CACHE_FORMAT_VERSION = 1;

/**
 * A file modified within this window is treated as still changing.
 *
 * Some filesystems only keep whole-second mtimes, so two writes inside the same
 * second that happen to leave the size unchanged would produce an identical
 * fingerprint. Refusing to trust a fingerprint that includes a very fresh file
 * closes that window. It costs nothing in practice: the tool a user is actively
 * working in is exactly the one whose files must be re-read anyway.
 */
const SETTLE_MS = 5_000;

type CacheEnvelope = {
  formatVersion: number;
  fingerprint: string;
  result: ParseResult;
};

function getParseCacheDir(): string {
  return join(getStateDir(), "parse-cache");
}

/** Cache files are keyed by tool id, which is a registry slug, not user input. */
export function getParseCachePath(toolId: string): string {
  return join(getParseCacheDir(), `${toolId}.json`);
}

/**
 * Fingerprint the inputs a parser would read.
 *
 * Returns `null` when the scan must not be cached — an unreadable entry (the
 * file list no longer matches the filesystem) or one that was just written.
 * A `null` fingerprint never matches and is never stored, so the caller simply
 * parses as it always did.
 */
export function computeScanFingerprint(
  files: string[],
  now = Date.now(),
): string | null {
  const hash = createHash("sha256");

  // The version covers parsing logic changes, the hostname is baked into every
  // bucket by `aggregateToBuckets`.
  hash.update(`v${CACHE_FORMAT_VERSION}\u0000`);
  hash.update(`${getCliVersion()}\u0000`);
  hash.update(`${hostname()}\u0000`);

  // Sorted so an unstable directory read order cannot invalidate the cache.
  for (const file of [...files].sort()) {
    let stats: { mtimeMs: number; size: number };

    try {
      stats = statSync(file);
    } catch {
      return null;
    }

    if (now - stats.mtimeMs < SETTLE_MS) {
      return null;
    }

    hash.update(`${file}\u0000${stats.mtimeMs}\u0000${stats.size}\u0000`);
  }

  return hash.digest("hex");
}

/**
 * Previously cached result for this tool, if it was produced from these inputs.
 *
 * Anything unexpected — missing file, unreadable JSON, older format, different
 * fingerprint — returns `null` and the caller re-parses.
 */
export function loadCachedParseResult(
  toolId: string,
  fingerprint: string | null,
): ParseResult | null {
  if (!fingerprint) {
    return null;
  }

  try {
    const envelope = JSON.parse(
      readFileSync(getParseCachePath(toolId), "utf-8"),
    ) as Partial<CacheEnvelope>;

    if (
      envelope.formatVersion !== CACHE_FORMAT_VERSION ||
      envelope.fingerprint !== fingerprint ||
      !Array.isArray(envelope.result?.buckets) ||
      !Array.isArray(envelope.result?.sessions)
    ) {
      return null;
    }

    return {
      buckets: envelope.result.buckets,
      sessions: envelope.result.sessions,
    };
  } catch {
    return null;
  }
}

/**
 * Store a freshly parsed result against its fingerprint.
 *
 * Never stores an incomplete scan: the upload treats each tool's buckets as a
 * full snapshot, so replaying a partial one would overwrite complete remote
 * counts. Write failures are ignored — the cache is an optimization.
 */
export function saveCachedParseResult(
  toolId: string,
  fingerprint: string | null,
  result: ParseResult,
): void {
  if (!fingerprint || result.incomplete) {
    return;
  }

  const envelope: CacheEnvelope = {
    formatVersion: CACHE_FORMAT_VERSION,
    fingerprint,
    result: { buckets: result.buckets, sessions: result.sessions },
  };

  try {
    mkdirSync(getParseCacheDir(), { recursive: true });
    writeFileSync(getParseCachePath(toolId), JSON.stringify(envelope), "utf-8");
  } catch {
    // A cache that cannot be written just means the next sync rescans.
  }
}
