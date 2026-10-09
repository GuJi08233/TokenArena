import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  findUsageApiKeyByRaw: vi.fn(),
  ingestUsagePayload: vi.fn(),
  deleteUsageDeviceSnapshot: vi.fn(),
  synchronizeAchievementsInBackground: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}));

vi.mock("@/lib/achievements/queries", () => ({
  synchronizeAchievementsInBackground:
    mocks.synchronizeAchievementsInBackground,
}));

vi.mock("@/lib/usage/api-keys", () => ({
  findUsageApiKeyByRaw: mocks.findUsageApiKeyByRaw,
}));

vi.mock("@/lib/usage/ingest", () => ({
  ingestUsagePayload: mocks.ingestUsagePayload,
  deleteUsageDeviceSnapshot: mocks.deleteUsageDeviceSnapshot,
}));

import { DELETE, POST } from "@/app/api/usage/ingest/route";
import { INGEST_MAX_PAYLOAD_BYTES } from "@/lib/usage/contracts";

function ingestRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/api/usage/ingest", {
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
      ...body,
    }),
  });
}

function deleteRequest() {
  return new Request(
    "https://example.com/api/usage/ingest?deviceId=device-1234",
    {
      method: "DELETE",
      headers: { authorization: "Bearer token" },
    },
  );
}

async function runScheduledWork() {
  await Promise.all(mocks.after.mock.calls.map(([callback]) => callback()));
}

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
    mocks.synchronizeAchievementsInBackground.mockResolvedValue(undefined);
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
    const response = await POST(ingestRequest({}));

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
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("answers before the award pass runs", async () => {
    const response = await POST(ingestRequest({ syncAchievements: true }));

    // The pass is only scheduled: a timeout there used to turn a committed
    // upload into a 500, and the CLI then re-sent the batch.
    expect(response.status).toBe(200);
    expect(mocks.synchronizeAchievementsInBackground).not.toHaveBeenCalled();

    await runScheduledWork();
    expect(mocks.synchronizeAchievementsInBackground).toHaveBeenCalledWith(
      "user-1",
      "ingest",
    );
  });

  it("schedules nothing for an intermediate batch", async () => {
    const response = await POST(ingestRequest({ syncAchievements: false }));

    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("schedules an award pass after deleting a device's usage", async () => {
    mocks.deleteUsageDeviceSnapshot.mockResolvedValue({
      deletedBuckets: 3,
      deletedSessions: 0,
    });

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deletedBuckets: 3,
      deletedSessions: 0,
    });
    await runScheduledWork();
    expect(mocks.synchronizeAchievementsInBackground).toHaveBeenCalledWith(
      "user-1",
      "ingest",
    );
  });

  it("schedules nothing when a delete removed nothing", async () => {
    mocks.deleteUsageDeviceSnapshot.mockResolvedValue({
      deletedBuckets: 0,
      deletedSessions: 0,
    });

    const response = await DELETE(deleteRequest());

    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
