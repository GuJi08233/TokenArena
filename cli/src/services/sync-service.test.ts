import { hostname } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiSettings,
  SessionMetadata,
  TokenBucket,
  UploadSessionMetadata,
  UploadTokenBucket,
} from "../domain/types";
import {
  buildUploadManifestScope,
  createUploadManifest,
  type UploadManifest,
} from "../domain/upload-manifest";
import { getIngestPayloadSize } from "../infrastructure/api/client";
import { getOrCreateDeviceId } from "../infrastructure/config/manager";
import { tryAcquireSyncLock } from "../infrastructure/runtime/lock";
import {
  markSyncFailed,
  markSyncSucceeded,
} from "../infrastructure/runtime/state";
import {
  loadUploadManifest,
  saveUploadManifest,
} from "../infrastructure/runtime/upload-manifest";
import { type AllParsersResult, runAllParsers } from "./parser-service";
import {
  buildUploadBatches,
  formatBytes,
  MAX_INGEST_PAYLOAD_BYTES,
  renderProgressBar,
  runSync,
  shouldSyncAchievementsForBatch,
  toUploadBuckets,
  toUploadSessions,
} from "./sync-service";

const syncApi = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  deleteDeviceData: vi.fn(),
  ingest: vi.fn(),
  release: vi.fn(),
}));
const projectIdentityCalls = vi.hoisted(() => vi.fn());

vi.mock("../domain/project-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../domain/project-identity")>();
  return {
    ...actual,
    toProjectIdentity: (
      input: Parameters<typeof actual.toProjectIdentity>[0],
    ) => {
      projectIdentityCalls(input.project);
      return actual.toProjectIdentity(input);
    },
  };
});

vi.mock("../infrastructure/api/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../infrastructure/api/client")>();
  return {
    ...actual,
    ApiClient: class {
      fetchSettings = syncApi.fetchSettings;
      deleteDeviceData = syncApi.deleteDeviceData;
      ingest = syncApi.ingest;
    },
  };
});
vi.mock("../infrastructure/config/manager", () => ({
  getOrCreateDeviceId: vi.fn(),
}));
vi.mock("../infrastructure/runtime/lock", () => ({
  tryAcquireSyncLock: vi.fn(),
  describeExistingSyncLock: vi.fn(),
}));
vi.mock("../infrastructure/runtime/state", () => ({
  markSyncStarted: vi.fn(),
  markSyncFailed: vi.fn(),
  markSyncSucceeded: vi.fn(),
}));
vi.mock("../infrastructure/runtime/upload-manifest", () => ({
  loadUploadManifest: vi.fn(),
  saveUploadManifest: vi.fn(),
}));
vi.mock("./parser-service", () => ({ runAllParsers: vi.fn() }));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("sync-service helpers", () => {
  describe("formatBytes", () => {
    it("formats bytes", () => {
      expect(formatBytes(0)).toBe("0B");
      expect(formatBytes(512)).toBe("512B");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(1024)).toBe("1.0KB");
      expect(formatBytes(1536)).toBe("1.5KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(1024 * 1024)).toBe("1.0MB");
      expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
    });
  });

  describe("renderProgressBar", () => {
    it("renders empty bar", () => {
      const bar = renderProgressBar(0);
      expect(bar).toContain("░");
      expect(bar).not.toContain("█");
    });

    it("renders full bar", () => {
      const bar = renderProgressBar(1);
      expect(bar).toContain("█");
      expect(bar).not.toContain("░");
    });

    it("clamps negative progress", () => {
      const bar = renderProgressBar(-1);
      expect(bar).toContain("░");
      expect(bar).not.toContain("█");
    });

    it("clamps progress > 1", () => {
      const bar = renderProgressBar(2);
      expect(bar).toContain("█");
      expect(bar).not.toContain("░");
    });
  });

  describe("shouldSyncAchievementsForBatch", () => {
    it("defers intermediate batches and syncs the final batch", () => {
      expect(shouldSyncAchievementsForBatch(0, 3)).toBe(false);
      expect(shouldSyncAchievementsForBatch(1, 3)).toBe(false);
      expect(shouldSyncAchievementsForBatch(2, 3)).toBe(true);
    });

    it("synchronizes a single-batch upload", () => {
      expect(shouldSyncAchievementsForBatch(0, 1)).toBe(true);
    });
  });

  describe("buildUploadBatches", () => {
    const device = { deviceId: "device-1234", hostname: "test-host" };

    function createSession(
      sessionHash: string,
      projectLabel: string,
    ): UploadSessionMetadata {
      return {
        source: "codex",
        projectKey: sessionHash,
        projectLabel,
        sessionHash,
        deviceId: device.deviceId,
        hostname: device.hostname,
        firstMessageAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-01T00:01:00.000Z",
        durationSeconds: 60,
        activeSeconds: 30,
        messageCount: 2,
        userMessageCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 150,
        primaryModel: "gpt-5.4",
        modelUsages: [],
      };
    }

    it("splits a count-bounded batch that exceeds the byte limit", () => {
      const largeLabel = "x".repeat(5 * 1024 * 1024);
      const batches = buildUploadBatches(
        device,
        [],
        [
          createSession("session-a", largeLabel),
          createSession("session-b", largeLabel),
        ],
      );

      expect(
        batches.map((batch) =>
          batch.sessions.map((session) => session.sessionHash),
        ),
      ).toEqual([["session-a"], ["session-b"]]);
      for (const batch of batches) {
        expect(
          getIngestPayloadSize(device, batch.buckets, batch.sessions, {
            syncAchievements: true,
          }),
        ).toBeLessThanOrEqual(MAX_INGEST_PAYLOAD_BYTES);
      }
    });

    it("rejects a single record that exceeds the byte limit", () => {
      const oversizedLabel = "x".repeat(MAX_INGEST_PAYLOAD_BYTES);

      expect(() =>
        buildUploadBatches(
          device,
          [],
          [createSession("oversized", oversizedLabel)],
        ),
      ).toThrow("A single usage record exceeds the 8.0MB ingest payload limit");
    });

    it("separates one large bucket from one large session", () => {
      const largeLabel = "x".repeat(5 * 1024 * 1024);
      const bucket: UploadTokenBucket = {
        source: "codex",
        model: "gpt-5.4",
        projectKey: "project-a",
        projectLabel: largeLabel,
        bucketStart: "2026-01-01T00:00:00.000Z",
        deviceId: device.deviceId,
        hostname: device.hostname,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 150,
      };

      const batches = buildUploadBatches(
        device,
        [bucket],
        [createSession("session-a", largeLabel)],
      );

      expect(batches).toHaveLength(2);
      expect(batches[0]).toMatchObject({
        buckets: [{ projectKey: "project-a" }],
        sessions: [],
      });
      expect(batches[1]).toMatchObject({
        buckets: [],
        sessions: [{ sessionHash: "session-a" }],
      });
    });
  });

  describe("toUploadBuckets", () => {
    const settings = {
      schemaVersion: 2 as const,
      projectHashSalt: "salt",
      projectMode: "hashed" as const,
      timezone: "UTC",
    };
    const device = { deviceId: "dev1", hostname: "test" };

    it("converts empty buckets", () => {
      expect(toUploadBuckets([], settings, device)).toEqual([]);
    });

    it("converts single bucket", () => {
      const buckets = [
        {
          source: "test",
          model: "gpt-4",
          project: "my-project",
          bucketStart: "2026-01-01T00:00:00Z",
          hostname: "test",
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 10,
          cachedTokens: 20,
          cacheCreationTokens: 0,
          totalTokens: 160,
        },
      ];
      const result = toUploadBuckets(buckets, settings, device);
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("test");
      expect(result[0].inputTokens).toBe(100);
      expect(result[0].deviceId).toBe("dev1");
    });

    it("aggregates buckets with same key", () => {
      const buckets = [
        {
          source: "test",
          model: "gpt-4",
          project: "proj",
          bucketStart: "2026-01-01T00:00:00Z",
          hostname: "test",
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 150,
        },
        {
          source: "test",
          model: "gpt-4",
          project: "proj",
          bucketStart: "2026-01-01T00:00:00Z",
          hostname: "test",
          inputTokens: 200,
          outputTokens: 100,
          reasoningTokens: 0,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 300,
        },
      ];
      const result = toUploadBuckets(buckets, settings, device);
      expect(result).toHaveLength(1);
      expect(result[0].inputTokens).toBe(300);
      expect(result[0].outputTokens).toBe(150);
    });

    it("defaults reasoningTokens and cachedTokens to 0 when undefined", () => {
      // Deliberately violates TokenBucket: this guards the runtime fallback for
      // parsers that omit the optional token counts, which the type cannot express.
      const buckets = [
        {
          source: "test",
          model: "gpt-4",
          project: "proj",
          bucketStart: "2026-01-01T00:00:00Z",
          hostname: "test",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      ] as unknown as TokenBucket[];
      const result = toUploadBuckets(buckets, settings, device);
      expect(result[0].reasoningTokens).toBe(0);
      expect(result[0].cachedTokens).toBe(0);
    });
  });

  describe("toUploadSessions", () => {
    const settings = {
      schemaVersion: 2 as const,
      projectHashSalt: "salt",
      projectMode: "hashed" as const,
      timezone: "UTC",
    };
    const device = { deviceId: "dev1", hostname: "test" };

    it("converts empty sessions", () => {
      expect(toUploadSessions([], settings, device)).toEqual([]);
    });

    it("converts sessions with all fields", () => {
      const sessions = [
        {
          source: "test",
          project: "my-project",
          sessionHash: "hash1",
          hostname: "test",
          firstMessageAt: "2026-01-01T00:00:00Z",
          lastMessageAt: "2026-01-01T01:00:00Z",
          durationSeconds: 3600,
          activeSeconds: 1800,
          messageCount: 10,
          userMessageCount: 5,
          userPromptHours: [0],
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 20,
          cachedTokens: 10,
          cacheCreationTokens: 0,
          totalTokens: 150,
          primaryModel: "gpt-4",
          modelUsages: [],
        },
      ];
      const result = toUploadSessions(sessions, settings, device);
      expect(result).toHaveLength(1);
      expect(result[0].sessionHash).toBe("hash1");
      expect(result[0].deviceId).toBe("dev1");
      expect(result[0].primaryModel).toBe("gpt-4");
    });
  });
});

describe("runSync rebuild safeguards", () => {
  const config = {
    apiKey: "ta_test",
    apiUrl: "https://example.com",
    deviceId: "device-current",
  };
  const device = {
    deviceId: config.deviceId,
    hostname: hostname().replace(/\.local$/, ""),
  };
  const settings: ApiSettings = {
    schemaVersion: 2,
    projectMode: "hashed",
    projectHashSalt: "salt",
    timezone: "UTC",
  };
  const options = { quiet: true, throws: true };
  let manifest: UploadManifest | null;
  let snapshot: AllParsersResult;

  function bucket(index = 0): TokenBucket {
    return {
      source: "codex",
      model: `model-${index}`,
      project: "project",
      bucketStart: "2026-07-10T03:00:00.000Z",
      hostname: device.hostname,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      reasoningTokens: 10,
      cacheCreationTokens: 0,
      totalTokens: 180,
    };
  }

  function session(index = 0): SessionMetadata {
    return {
      source: "codex",
      project: "project",
      sessionHash: `session-${index}`,
      hostname: device.hostname,
      firstMessageAt: "2026-07-10T03:00:00.000Z",
      lastMessageAt: "2026-07-10T03:01:00.000Z",
      durationSeconds: 60,
      activeSeconds: 30,
      messageCount: 2,
      userMessageCount: 1,
      userPromptHours: [],
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      reasoningTokens: 10,
      cacheCreationTokens: 0,
      totalTokens: 180,
      primaryModel: "model-0",
      modelUsages: [],
    };
  }

  function rememberSnapshot(): void {
    manifest = createUploadManifest({
      buckets: toUploadBuckets(snapshot.buckets, settings, device),
      sessions: toUploadSessions(snapshot.sessions, settings, device),
      scope: buildUploadManifestScope({ ...config, settings }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    manifest = null;
    snapshot = {
      buckets: [bucket()],
      sessions: [session()],
      parserResults: [],
      failedSources: [],
    };
    syncApi.fetchSettings.mockReset().mockResolvedValue(settings);
    syncApi.deleteDeviceData
      .mockReset()
      .mockResolvedValue({ deletedBuckets: 1, deletedSessions: 1 });
    syncApi.ingest
      .mockReset()
      .mockImplementation(async (_device, buckets, sessions = []) => ({
        ingested: buckets.length,
        sessions: sessions.length,
      }));
    vi.mocked(getOrCreateDeviceId).mockReturnValue(config.deviceId);
    vi.mocked(tryAcquireSyncLock).mockReturnValue({ release: syncApi.release });
    vi.mocked(runAllParsers)
      .mockReset()
      .mockImplementation(async () => snapshot);
    vi.mocked(loadUploadManifest).mockImplementation(() => manifest);
    vi.mocked(saveUploadManifest)
      .mockReset()
      .mockImplementation((next) => {
        manifest = structuredClone(next);
      });
  });

  it("keeps normal incremental sync free of remote deletions", async () => {
    rememberSnapshot();
    expect(await runSync(config, options)).toEqual({ buckets: 0, sessions: 0 });
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.ingest).not.toHaveBeenCalled();
    expect(saveUploadManifest).not.toHaveBeenCalled();
    expect(markSyncSucceeded).toHaveBeenCalledWith("manual", {
      buckets: 0,
      sessions: 0,
    });
  });

  it.each([
    "buckets",
    "sessions",
  ] as const)("saves the manifest after %s disappear from a no-upload snapshot", async (kind) => {
    rememberSnapshot();
    if (!manifest) throw new Error("fixture");
    manifest[kind].obsolete = "old-hash";

    expect(await runSync(config, options)).toEqual({
      buckets: 0,
      sessions: 0,
    });
    expect(syncApi.ingest).not.toHaveBeenCalled();
    expect(saveUploadManifest).toHaveBeenCalledOnce();
    expect(manifest[kind].obsolete).toBeUndefined();
  });

  it("uploads and saves everything on a first sync or a changed server scope", async () => {
    expect(await runSync(config, options)).toEqual({ buckets: 1, sessions: 1 });
    expect(saveUploadManifest).toHaveBeenCalledOnce();

    if (!manifest) throw new Error("fixture");
    manifest.scope.apiKeyHash = "previous-key";
    vi.mocked(saveUploadManifest).mockClear();
    syncApi.ingest.mockClear();
    expect(await runSync(config, options)).toEqual({ buckets: 1, sessions: 1 });
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.ingest).toHaveBeenCalledOnce();
    expect(saveUploadManifest).toHaveBeenCalledOnce();
  });

  it("resolves each project once across buckets and sessions per sync", async () => {
    snapshot.buckets = [
      bucket(0),
      bucket(1),
      { ...bucket(2), project: "other" },
    ];
    snapshot.sessions = [session(0), { ...session(1), project: "other" }];

    expect(await runSync(config, options)).toEqual({ buckets: 3, sessions: 2 });
    expect(projectIdentityCalls.mock.calls.map(([project]) => project)).toEqual(
      ["project", "other"],
    );
    const [uploadedBuckets, uploadedSessions] =
      syncApi.ingest.mock.calls[0].slice(1, 3) as [
        UploadTokenBucket[],
        UploadSessionMetadata[],
      ];
    expect(uploadedBuckets[0].projectKey).toBe(uploadedBuckets[1].projectKey);
    expect(uploadedBuckets[0].projectKey).toBe(uploadedSessions[0].projectKey);
    expect(uploadedBuckets[2].projectKey).toBe(uploadedSessions[1].projectKey);

    projectIdentityCalls.mockClear();
    expect(await runSync(config, options)).toEqual({ buckets: 0, sessions: 0 });
    expect(projectIdentityCalls.mock.calls.map(([project]) => project)).toEqual(
      ["project", "other"],
    );
    expect(syncApi.ingest).toHaveBeenCalledOnce();
  });

  it.each([
    "project_identity",
    "snapshot_protocol",
  ])("preserves automatic snapshot replacement for %s changes", async (reason) => {
    rememberSnapshot();
    if (!manifest) throw new Error("fixture");
    if (reason === "project_identity") manifest.scope.projectMode = "raw";
    else manifest.scope.snapshotProtocolVersion = 0;
    expect(await runSync(config, options)).toEqual({ buckets: 1, sessions: 1 });
    expect(syncApi.ingest).toHaveBeenCalledOnce();
    expect(syncApi.deleteDeviceData).toHaveBeenCalledExactlyOnceWith(
      config.deviceId,
    );
    expect(saveUploadManifest).toHaveBeenCalledTimes(2);
  });

  it("retries automatic privacy cleanup after an interrupted replacement", async () => {
    rememberSnapshot();
    if (!manifest) throw new Error("fixture");
    manifest.scope.projectMode = "raw";
    syncApi.deleteDeviceData.mockRejectedValueOnce(new Error("delete timeout"));
    await expect(runSync(config, options)).rejects.toThrow("delete timeout");
    expect(manifest).toMatchObject({
      scope: { projectMode: "raw" },
      buckets: {},
      sessions: {},
    });
    expect(markSyncSucceeded).not.toHaveBeenCalled();
    expect(await runSync(config, options)).toEqual({ buckets: 1, sessions: 1 });
    expect(syncApi.deleteDeviceData).toHaveBeenCalledTimes(2);
    expect(manifest?.scope.projectMode).toBe("hashed");
  });

  it("does not delete a privacy snapshot when any parser reports incomplete data", async () => {
    rememberSnapshot();
    if (!manifest) throw new Error("fixture");
    manifest.scope.projectMode = "raw";
    snapshot.failedSources = ["codex"];
    await expect(runSync(config, options)).rejects.toThrow(
      "incomplete or failed parsers",
    );
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(saveUploadManifest).not.toHaveBeenCalled();
  });

  it("forces all current buckets and sessions to upload after an explicit rebuild", async () => {
    rememberSnapshot();
    expect(await runSync(config, { ...options, rebuild: true })).toEqual({
      buckets: 1,
      sessions: 1,
    });
    expect(syncApi.deleteDeviceData).toHaveBeenCalledExactlyOnceWith(
      config.deviceId,
    );
    expect(syncApi.ingest).toHaveBeenCalledWith(
      device,
      toUploadBuckets(snapshot.buckets, settings, device),
      toUploadSessions(snapshot.sessions, settings, device),
      undefined,
      { syncAchievements: true },
    );
    expect(saveUploadManifest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ buckets: {}, sessions: {} }),
    );
    expect(saveUploadManifest).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(saveUploadManifest).mock.invocationCallOrder[0],
    ).toBeLessThan(syncApi.deleteDeviceData.mock.invocationCallOrder[0]);
    expect(syncApi.deleteDeviceData.mock.invocationCallOrder[0]).toBeLessThan(
      syncApi.ingest.mock.invocationCallOrder[0],
    );
    expect(Object.keys(manifest?.buckets ?? {})).toHaveLength(1);
    expect(Object.keys(manifest?.sessions ?? {})).toHaveLength(1);
    expect(markSyncFailed).not.toHaveBeenCalled();
    expect(syncApi.release).toHaveBeenCalledOnce();
  });

  it("only deletes the current device even when the previous manifest belongs to another", async () => {
    rememberSnapshot();
    if (!manifest) throw new Error("fixture");
    manifest.scope.deviceId = "device-old";
    await runSync(config, { ...options, rebuild: true });
    expect(syncApi.deleteDeviceData).toHaveBeenCalledExactlyOnceWith(
      "device-current",
    );
  });

  it("rejects failed or incomplete parsers before changing the remote snapshot", async () => {
    rememberSnapshot();
    const previous = structuredClone(manifest);
    snapshot.failedSources = ["codex"];
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("incomplete or failed parsers (codex)");
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.fetchSettings).not.toHaveBeenCalled();
    expect(syncApi.ingest).not.toHaveBeenCalled();
    expect(manifest).toEqual(previous);
    expect(markSyncSucceeded).not.toHaveBeenCalled();
    expect(markSyncFailed).toHaveBeenCalled();
    expect(syncApi.release).toHaveBeenCalledOnce();
  });

  it("continues syncing healthy parser results during normal sync", async () => {
    snapshot.failedSources = ["unavailable-tool"];
    expect(await runSync(config, options)).toEqual({ buckets: 1, sessions: 1 });
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.ingest).toHaveBeenCalledOnce();
  });

  it("rejects an empty rebuild scan without updating the manifest or remote history", async () => {
    rememberSnapshot();
    const previous = structuredClone(manifest);
    snapshot = {
      buckets: [],
      sessions: [],
      parserResults: [],
      failedSources: [],
    };
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("empty scan");
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(saveUploadManifest).not.toHaveBeenCalled();
    expect(manifest).toEqual(previous);
    expect(markSyncSucceeded).not.toHaveBeenCalled();
  });

  it("requires valid settings before deleting remote data", async () => {
    syncApi.fetchSettings.mockResolvedValue(null);
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("Could not fetch usage settings");
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(saveUploadManifest).not.toHaveBeenCalled();
  });

  it("validates every upload batch before deleting or invalidating the old snapshot", async () => {
    rememberSnapshot();
    const previous = structuredClone(manifest);
    syncApi.fetchSettings.mockResolvedValue({
      ...settings,
      projectMode: "raw",
    });
    snapshot.buckets = Array.from({ length: 101 }, (_, index) => bucket(index));
    snapshot.buckets[100].project = "x".repeat(MAX_INGEST_PAYLOAD_BYTES);
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("single usage record exceeds");
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.ingest).not.toHaveBeenCalled();
    expect(saveUploadManifest).not.toHaveBeenCalled();
    expect(manifest).toEqual(previous);
    expect(markSyncSucceeded).not.toHaveBeenCalled();
  });

  it("does not delete anything when the recovery manifest cannot be saved", async () => {
    rememberSnapshot();
    const previous = structuredClone(manifest);
    vi.mocked(saveUploadManifest).mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("disk full");
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.ingest).not.toHaveBeenCalled();
    expect(manifest).toEqual(previous);
    expect(markSyncSucceeded).not.toHaveBeenCalled();
  });

  it("keeps a retryable manifest after a failed deletion without claiming success", async () => {
    rememberSnapshot();
    syncApi.deleteDeviceData.mockRejectedValue(new Error("delete timeout"));
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("delete timeout");
    expect(syncApi.ingest).not.toHaveBeenCalled();
    expect(manifest).toMatchObject({ buckets: {}, sessions: {} });
    expect(markSyncSucceeded).not.toHaveBeenCalled();
    expect(markSyncFailed).toHaveBeenCalledWith(
      "manual",
      expect.stringContaining("Rebuild did not finish"),
      "error",
    );
  });

  it("retries the entire local snapshot with normal sync after a partial upload failure", async () => {
    snapshot.sessions = Array.from({ length: 501 }, (_, index) =>
      session(index),
    );
    rememberSnapshot();
    syncApi.ingest
      .mockResolvedValueOnce({ ingested: 1, sessions: 500 })
      .mockRejectedValueOnce(new Error("upload failed"));
    await expect(
      runSync(config, { ...options, rebuild: true }),
    ).rejects.toThrow("upload failed");
    expect(manifest).toMatchObject({ buckets: {}, sessions: {} });
    expect(markSyncSucceeded).not.toHaveBeenCalled();
    expect(markSyncFailed).toHaveBeenCalledWith(
      "manual",
      expect.stringContaining("Rebuild did not finish"),
      "error",
    );
    expect(saveUploadManifest).toHaveBeenCalledOnce();

    syncApi.ingest.mockClear();
    syncApi.deleteDeviceData.mockClear();
    expect(await runSync(config, options)).toEqual({
      buckets: 1,
      sessions: 501,
    });
    expect(syncApi.deleteDeviceData).not.toHaveBeenCalled();
    expect(syncApi.ingest.mock.calls.map((call) => call[2].length)).toEqual([
      500, 1,
    ]);
    expect(Object.keys(manifest?.sessions ?? {})).toHaveLength(501);
    expect(markSyncSucceeded).toHaveBeenCalledOnce();
  });
});
