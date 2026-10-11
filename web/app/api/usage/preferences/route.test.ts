import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalSession: vi.fn(),
  getUsagePreference: vi.fn(),
  updateUsagePreference: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getOptionalSession: mocks.getOptionalSession,
}));
vi.mock("@/lib/usage/preferences", () => ({
  getUsagePreference: mocks.getUsagePreference,
  updateUsagePreference: mocks.updateUsagePreference,
}));

import { PATCH } from "./route";

function patch(body: string, headers: Record<string, string> = {}) {
  return PATCH(
    new Request("https://example.com/api/usage/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

describe("usage preferences route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOptionalSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("answers 400 for an invalid time zone instead of throwing", async () => {
    const response = await patch(JSON.stringify({ timezone: "Mars/Base" }));

    expect(response.status).toBe(400);
    expect(mocks.updateUsagePreference).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over the limit", async () => {
    const response = await patch(JSON.stringify({ bio: "x" }), {
      "content-length": String(1024 * 1024),
    });

    expect(response.status).toBe(413);
  });

  it("saves a valid update", async () => {
    mocks.updateUsagePreference.mockResolvedValue({
      locale: "en",
      theme: "dark",
      timezone: "UTC",
      projectMode: "hashed",
      publicProfileEnabled: true,
      bio: null,
    });

    const response = await patch(JSON.stringify({ theme: "dark" }));

    expect(response.status).toBe(200);
    expect(mocks.updateUsagePreference).toHaveBeenCalledWith("user-1", {
      theme: "dark",
    });
  });
});
