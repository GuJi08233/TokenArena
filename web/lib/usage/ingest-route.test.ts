import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUsageApiKeyByRaw: vi.fn(),
  ingestUsagePayload: vi.fn(),
  deleteUsageDeviceSnapshot: vi.fn(),
}));

vi.mock("@/lib/usage/api-keys", () => ({
  findUsageApiKeyByRaw: mocks.findUsageApiKeyByRaw,
}));

vi.mock("@/lib/usage/ingest", () => ({
  ingestUsagePayload: mocks.ingestUsagePayload,
  deleteUsageDeviceSnapshot: mocks.deleteUsageDeviceSnapshot,
}));

import { POST } from "@/app/api/usage/ingest/route";
import { INGEST_MAX_PAYLOAD_BYTES } from "@/lib/usage/contracts";

describe("usage ingest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUsageApiKeyByRaw.mockResolvedValue({
      id: "key-1",
      userId: "user-1",
    });
    mocks.ingestUsagePayload.mockResolvedValue({
      ok: true,
      bucketCount: 0,
      sessionCount: 0,
      deviceId: "device-1234",
    });
  });

  it("rejects a declared body larger than the ingest limit", async () => {
    const response = await POST(
      new Request("https://example.com/api/usage/ingest", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-length": String(INGEST_MAX_PAYLOAD_BYTES + 1),
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "PAYLOAD_TOO_LARGE",
      maxBytes: INGEST_MAX_PAYLOAD_BYTES,
    });
    expect(mocks.ingestUsagePayload).not.toHaveBeenCalled();
  });

  it("parses a bounded payload and preserves legacy achievement sync", async () => {
    const response = await POST(
      new Request("https://example.com/api/usage/ingest", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 2,
          device: {
            deviceId: "device-1234",
            hostname: "workstation",
          },
          buckets: [],
          sessions: [],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.ingestUsagePayload).toHaveBeenCalledWith({
      userId: "user-1",
      apiKeyId: "key-1",
      payload: {
        schemaVersion: 2,
        device: {
          deviceId: "device-1234",
          hostname: "workstation",
        },
        buckets: [],
        sessions: [],
        syncAchievements: true,
      },
    });
  });
});
