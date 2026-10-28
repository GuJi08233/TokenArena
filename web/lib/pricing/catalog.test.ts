import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: <T>(fn: T) => fn,
}));

import {
  createPricingCatalogSnapshot,
  fetchPricingCatalogSnapshot,
  getPricingCatalog,
  hydratePricingCatalogSnapshot,
  normalizeModelLookupKey,
} from "./catalog";

describe("pricing catalog snapshot", () => {
  it("compacts the upstream payload and hydrates the lookup maps back", () => {
    const rawPayload = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            cost: {
              input: 2,
              output: 8,
            },
          },
          "gpt-4.1-mini": {
            id: "gpt-4.1-mini",
          },
        },
      },
      minimax: {
        id: "minimax",
        models: {
          "minimax-m2.5": {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            cost: {
              input: 0.3,
            },
          },
        },
      },
    };

    const snapshot = createPricingCatalogSnapshot(rawPayload);

    expect(snapshot).toEqual([
      [
        "openai",
        "OpenAI",
        [
          [
            "gpt-4.1",
            "gpt-4.1",
            "GPT-4.1",
            {
              input: 2,
              output: 8,
            },
          ],
          ["gpt-4.1-mini", "gpt-4.1-mini", null, null],
        ],
      ],
      [
        "minimax",
        null,
        [
          [
            "minimax-m2.5",
            "MiniMax-M2.5",
            "MiniMax M2.5",
            {
              input: 0.3,
            },
          ],
        ],
      ],
    ]);

    expect(JSON.stringify(snapshot).length).toBeLessThan(
      JSON.stringify(rawPayload).length,
    );

    const catalog = hydratePricingCatalogSnapshot(snapshot);

    expect(catalog.get("openai")).toEqual({
      id: "openai",
      name: "OpenAI",
      modelsByLower: new Map([
        [
          "gpt-4.1",
          {
            id: "gpt-4.1",
            name: "GPT-4.1",
            cost: {
              input: 2,
              output: 8,
            },
          },
        ],
        [
          "gpt-4.1-mini",
          {
            id: "gpt-4.1-mini",
            name: "gpt-4.1-mini",
            cost: null,
          },
        ],
      ]),
    });

    expect(catalog.get("minimax")).toEqual({
      id: "minimax",
      name: "minimax",
      modelsByLower: new Map([
        [
          "minimax-m2.5",
          {
            id: "MiniMax-M2.5",
            name: "MiniMax M2.5",
            cost: {
              input: 0.3,
            },
          },
        ],
      ]),
    });
  });

  it("lowercases and trims model names via normalizeModelLookupKey", () => {
    expect(normalizeModelLookupKey("GPT-4.1")).toBe("gpt-4.1");
  });

  it("trims whitespace from model names via normalizeModelLookupKey", () => {
    expect(normalizeModelLookupKey("  gpt-4.1  ")).toBe("gpt-4.1");
  });

  it("returns empty string for empty input to normalizeModelLookupKey", () => {
    expect(normalizeModelLookupKey("")).toBe("");
  });

  it("preserves special characters in normalizeModelLookupKey", () => {
    expect(normalizeModelLookupKey("Model-@#$!")).toBe("model-@#$!");
  });

  it("creates an empty snapshot and hydrates to an empty catalog from an empty payload", () => {
    const snapshot = createPricingCatalogSnapshot({});
    expect(snapshot).toEqual([]);

    const catalog = hydratePricingCatalogSnapshot(snapshot);
    expect(catalog.size).toBe(0);
  });

  it("falls back to the key name when a provider has no id field", () => {
    const rawPayload = {
      myProvider: {
        name: "My Provider",
        models: {
          "my-model": {
            id: "my-model",
          },
        },
      },
    };

    const snapshot = createPricingCatalogSnapshot(rawPayload);
    expect(snapshot).toEqual([
      ["myProvider", "My Provider", [["my-model", "my-model", null, null]]],
    ]);

    const catalog = hydratePricingCatalogSnapshot(snapshot);
    expect(catalog.get("myProvider")?.id).toBe("myProvider");
    expect(catalog.get("myProvider")?.name).toBe("My Provider");
  });

  it("hydrates an empty array snapshot to an empty catalog", () => {
    const catalog = hydratePricingCatalogSnapshot([]);
    expect(catalog.size).toBe(0);
  });

  it("handles multiple providers in a single payload", () => {
    const rawPayload = {
      openai: {
        id: "openai",
        models: {
          "gpt-4.1": { id: "gpt-4.1" },
        },
      },
      google: {
        id: "google",
        models: {
          "gemini-pro": { id: "gemini-pro" },
        },
      },
    };

    const snapshot = createPricingCatalogSnapshot(rawPayload);
    expect(snapshot).toHaveLength(2);

    const catalog = hydratePricingCatalogSnapshot(snapshot);
    expect(catalog.get("openai")).toBeDefined();
    expect(catalog.get("google")).toBeDefined();
    expect(catalog.get("openai")?.modelsByLower.has("gpt-4.1")).toBe(true);
    expect(catalog.get("google")?.modelsByLower.has("gemini-pro")).toBe(true);
  });
});

describe("pricing catalog provider filter", () => {
  it("keeps only the requested providers", () => {
    const snapshot = createPricingCatalogSnapshot(
      {
        anthropic: { models: { "claude-opus-4-6": {} } },
        openrouter: { models: { "anthropic/claude-opus-4.6": {} } },
      },
      new Set(["anthropic"]),
    );

    expect(snapshot.map(([providerId]) => providerId)).toEqual(["anthropic"]);
  });
});

describe("fetchPricingCatalogSnapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(response: Response) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("caps the request time and drops providers that are never priced", async () => {
    const fetchMock = stubFetch(
      Response.json({
        anthropic: {
          id: "anthropic",
          models: { "claude-opus-4-6": { cost: { input: 5 } } },
        },
        openrouter: {
          id: "openrouter",
          models: { "anthropic/claude-opus-4.6": { cost: { input: 9 } } },
        },
      }),
    );

    await expect(fetchPricingCatalogSnapshot()).resolves.toEqual([
      [
        "anthropic",
        null,
        [["claude-opus-4-6", "claude-opus-4-6", null, { input: 5 }]],
      ],
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  // `unstable_cache` would store a resolved value for the whole revalidate
  // window, so every failure has to surface as a rejection.
  it("rejects on an error status", async () => {
    stubFetch(new Response("unavailable", { status: 503 }));

    await expect(fetchPricingCatalogSnapshot()).rejects.toThrow("503");
  });

  it("rejects a payload without any priced provider", async () => {
    stubFetch(Response.json({ openrouter: { models: {} } }));

    await expect(fetchPricingCatalogSnapshot()).rejects.toThrow(
      "none of the priced providers",
    );
  });

  it("lets getPricingCatalog fall back to null when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(getPricingCatalog()).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to load the pricing catalog",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
