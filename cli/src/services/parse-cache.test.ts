import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParseResult } from "../domain/types";
import { useTempDirs } from "../testing/temp-dir";

const mocks = vi.hoisted(() => ({ stateDir: "", version: "1.2.3" }));

vi.mock("../infrastructure/runtime/paths", () => ({
  getStateDir: () => mocks.stateDir,
}));
vi.mock("../infrastructure/runtime/cli-version", () => ({
  getCliVersion: () => mocks.version,
}));

import {
  computeScanFingerprint,
  getParseCachePath,
  loadCachedParseResult,
  saveCachedParseResult,
} from "./parse-cache";

const makeTempDir = useTempDirs("tokenarena-cache-");

let sourceDir: string;

/** Write a file and backdate it past the settle window. */
function writeSettled(name: string, content: string) {
  const path = join(sourceDir, name);
  writeFileSync(path, content);
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  return path;
}

function buildResult(totalTokens: number): ParseResult {
  return {
    buckets: [
      {
        source: "claude-code",
        model: "m",
        project: "p",
        bucketStart: "2026-04-01T12:00:00.000Z",
        hostname: "h",
        inputTokens: totalTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        totalTokens,
      },
    ],
    sessions: [],
  };
}

beforeEach(() => {
  mocks.stateDir = makeTempDir();
  mocks.version = "1.2.3";
  sourceDir = makeTempDir();
  mkdirSync(sourceDir, { recursive: true });
});

describe("computeScanFingerprint", () => {
  it("is stable for unchanged files", () => {
    const file = writeSettled("a.jsonl", "one");

    expect(computeScanFingerprint([file])).toBe(computeScanFingerprint([file]));
  });

  it("ignores the order the files were listed in", () => {
    const a = writeSettled("a.jsonl", "one");
    const b = writeSettled("b.jsonl", "two");

    expect(computeScanFingerprint([a, b])).toBe(computeScanFingerprint([b, a]));
  });

  it("changes when a file's contents change", () => {
    const file = writeSettled("a.jsonl", "one");
    const before = computeScanFingerprint([file]);
    writeSettled("a.jsonl", "one-but-longer");

    expect(computeScanFingerprint([file])).not.toBe(before);
  });

  it("changes when a file is added", () => {
    const a = writeSettled("a.jsonl", "one");
    const before = computeScanFingerprint([a]);
    const b = writeSettled("b.jsonl", "two");

    expect(computeScanFingerprint([a, b])).not.toBe(before);
  });

  it("changes when the CLI version changes", () => {
    const file = writeSettled("a.jsonl", "one");
    const before = computeScanFingerprint([file]);
    mocks.version = "9.9.9";

    expect(computeScanFingerprint([file])).not.toBe(before);
  });

  it("refuses to fingerprint a file that was just written", () => {
    const path = join(sourceDir, "fresh.jsonl");
    writeFileSync(path, "still being appended to");

    expect(computeScanFingerprint([path])).toBeNull();
  });

  it("refuses to fingerprint a file that has disappeared", () => {
    expect(
      computeScanFingerprint([join(sourceDir, "missing.jsonl")]),
    ).toBeNull();
  });
});

describe("parse cache round trip", () => {
  it("returns the stored result for a matching fingerprint", () => {
    const file = writeSettled("a.jsonl", "one");
    const fingerprint = computeScanFingerprint([file]);

    saveCachedParseResult("claude-code", fingerprint, buildResult(7));

    expect(loadCachedParseResult("claude-code", fingerprint)).toEqual(
      buildResult(7),
    );
  });

  it("misses when the inputs changed", () => {
    const file = writeSettled("a.jsonl", "one");
    saveCachedParseResult(
      "claude-code",
      computeScanFingerprint([file]),
      buildResult(7),
    );
    writeSettled("a.jsonl", "one-but-longer");

    expect(
      loadCachedParseResult("claude-code", computeScanFingerprint([file])),
    ).toBeNull();
  });

  it("never reads or writes without a fingerprint", () => {
    saveCachedParseResult("claude-code", null, buildResult(7));

    expect(loadCachedParseResult("claude-code", null)).toBeNull();
  });

  it("does not cache an incomplete scan", () => {
    const file = writeSettled("a.jsonl", "one");
    const fingerprint = computeScanFingerprint([file]);

    saveCachedParseResult("claude-code", fingerprint, {
      ...buildResult(7),
      incomplete: true,
    });

    expect(loadCachedParseResult("claude-code", fingerprint)).toBeNull();
  });

  it("misses instead of throwing on a corrupt cache file", () => {
    const file = writeSettled("a.jsonl", "one");
    const fingerprint = computeScanFingerprint([file]);
    saveCachedParseResult("claude-code", fingerprint, buildResult(7));
    writeFileSync(getParseCachePath("claude-code"), "{ not json");

    expect(loadCachedParseResult("claude-code", fingerprint)).toBeNull();
  });

  it("misses on a cache written by an older format", () => {
    const file = writeSettled("a.jsonl", "one");
    const fingerprint = computeScanFingerprint([file]);
    saveCachedParseResult("claude-code", fingerprint, buildResult(7));
    writeFileSync(
      getParseCachePath("claude-code"),
      JSON.stringify({ formatVersion: 0, fingerprint, result: buildResult(7) }),
    );

    expect(loadCachedParseResult("claude-code", fingerprint)).toBeNull();
  });

  it("keeps each tool's cache separate", () => {
    const file = writeSettled("a.jsonl", "one");
    const fingerprint = computeScanFingerprint([file]);

    saveCachedParseResult("claude-code", fingerprint, buildResult(7));

    expect(loadCachedParseResult("codex", fingerprint)).toBeNull();
  });
});
