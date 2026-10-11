import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  createUsageApiKey: vi.fn(),
  listUsageApiKeys: vi.fn(),
  updateUsageApiKey: vi.fn(),
  deleteUsageApiKey: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/usage/api-keys", () => ({
  createUsageApiKey: mocks.createUsageApiKey,
  listUsageApiKeys: mocks.listUsageApiKeys,
  updateUsageApiKey: mocks.updateUsageApiKey,
  deleteUsageApiKey: mocks.deleteUsageApiKey,
}));

import { PATCH } from "./[id]/route";
import { POST } from "./route";

function jsonRequest(method: string, body: string) {
  return new Request("https://example.com/api/usage/keys", {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("usage key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("answers 400 instead of 500 for a malformed or invalid key body", async () => {
    // `schema.parse(await request.json())` threw on both.
    for (const body of ["{not json", JSON.stringify({ name: "" })]) {
      const response = await POST(jsonRequest("POST", body));

      expect(response.status).toBe(400);
    }
    expect(mocks.createUsageApiKey).not.toHaveBeenCalled();
  });

  it("creates a key from a valid body", async () => {
    mocks.createUsageApiKey.mockResolvedValue({
      apiKey: { id: "key-1" },
      rawKey: "ta_raw",
    });

    const response = await POST(
      jsonRequest("POST", JSON.stringify({ name: " CLI " })),
    );

    expect(response.status).toBe(200);
    expect(mocks.createUsageApiKey).toHaveBeenCalledWith("user-1", "CLI");
  });

  it("answers 400 for an update without any field", async () => {
    const response = await PATCH(jsonRequest("PATCH", "{}"), {
      params: Promise.resolve({ id: "key-1" }),
    } as never);

    expect(response.status).toBe(400);
    expect(mocks.updateUsageApiKey).not.toHaveBeenCalled();
  });
});
