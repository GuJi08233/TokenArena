import { describe, expect, it } from "vitest";
import type { UploadSessionMetadata, UploadTokenBucket } from "../domain/types";
import { getIngestPayloadSize } from "../infrastructure/api/client";
import {
  buildUploadBatches,
  formatBytes,
  MAX_INGEST_PAYLOAD_BYTES,
  renderProgressBar,
  shouldSyncAchievementsForBatch,
  toUploadBuckets,
  toUploadSessions,
} from "./sync-service";

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
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 10,
          cachedTokens: 20,
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
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cachedTokens: 0,
          totalTokens: 150,
        },
        {
          source: "test",
          model: "gpt-4",
          project: "proj",
          bucketStart: "2026-01-01T00:00:00Z",
          inputTokens: 200,
          outputTokens: 100,
          reasoningTokens: 0,
          cachedTokens: 0,
          totalTokens: 300,
        },
      ];
      const result = toUploadBuckets(buckets, settings, device);
      expect(result).toHaveLength(1);
      expect(result[0].inputTokens).toBe(300);
      expect(result[0].outputTokens).toBe(150);
    });

    it("defaults reasoningTokens and cachedTokens to 0 when undefined", () => {
      const buckets = [
        {
          source: "test",
          model: "gpt-4",
          project: "proj",
          bucketStart: "2026-01-01T00:00:00Z",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      ];
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
          firstMessageAt: "2026-01-01T00:00:00Z",
          lastMessageAt: "2026-01-01T01:00:00Z",
          durationSeconds: 3600,
          activeSeconds: 1800,
          messageCount: 10,
          userMessageCount: 5,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 20,
          cachedTokens: 10,
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
