import { unstable_cache } from "next/cache";
import { cache } from "react";

import { OFFICIAL_PRICING_PROVIDER_IDS } from "./providers";

const PRICING_CATALOG_URL = "https://models.dev/api.json";
const PRICING_CATALOG_REVALIDATE_SECONDS = 60 * 60 * 12;
const PRICING_CATALOG_CACHE_KEY = "pricing-catalog";
const PRICING_CATALOG_FETCH_TIMEOUT_MS = 15_000;

export type PricingCost = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
};

export type PricingCatalogModel = {
  id: string;
  name: string;
  cost: PricingCost | null;
};

type PricingCatalogProvider = {
  id: string;
  name: string;
  modelsByLower: Map<string, PricingCatalogModel>;
};

export type PricingCatalog = Map<string, PricingCatalogProvider>;

type RawCatalogPayload = Record<
  string,
  {
    id?: string;
    name?: string;
    models?: Record<
      string,
      {
        id?: string;
        name?: string;
        cost?: PricingCost;
      }
    >;
  }
>;

type SerializedPricingCatalogModel = readonly [
  lookupKey: string,
  modelId: string,
  modelName: string | null,
  cost: PricingCost | null,
];

type SerializedPricingCatalogProvider = readonly [
  providerId: string,
  providerName: string | null,
  models: SerializedPricingCatalogModel[],
];

export type SerializedPricingCatalog = SerializedPricingCatalogProvider[];

export function normalizeModelLookupKey(value: string) {
  return value.trim().toLowerCase();
}

export function createPricingCatalogSnapshot(
  payload: RawCatalogPayload,
  providerIds?: ReadonlySet<string>,
): SerializedPricingCatalog {
  const snapshot: SerializedPricingCatalog = [];

  for (const [providerKey, providerValue] of Object.entries(payload)) {
    if (!providerValue || typeof providerValue !== "object") {
      continue;
    }

    const providerId = providerValue.id ?? providerKey;
    if (!providerId || (providerIds && !providerIds.has(providerId))) {
      continue;
    }

    const providerName = providerValue.name ?? providerId;
    const serializedModels: SerializedPricingCatalogModel[] = [];
    const rawModels = providerValue.models;

    if (rawModels && typeof rawModels === "object") {
      for (const [modelKey, modelValue] of Object.entries(rawModels)) {
        if (!modelValue || typeof modelValue !== "object") {
          continue;
        }

        const modelId = modelValue.id ?? modelKey;
        const lookupKey = normalizeModelLookupKey(modelId);
        if (!lookupKey) {
          continue;
        }

        const modelName = modelValue.name ?? modelId;

        serializedModels.push([
          lookupKey,
          modelId,
          modelName === modelId ? null : modelName,
          modelValue.cost ?? null,
        ]);
      }
    }

    snapshot.push([
      providerId,
      providerName === providerId ? null : providerName,
      serializedModels,
    ]);
  }

  return snapshot;
}

export function hydratePricingCatalogSnapshot(
  snapshot: SerializedPricingCatalog,
): PricingCatalog {
  const catalog: PricingCatalog = new Map();

  for (const [providerId, providerNameOverride, serializedModels] of snapshot) {
    if (!providerId) {
      continue;
    }

    const modelsByLower = new Map<string, PricingCatalogModel>();

    for (const [
      lookupKey,
      modelId,
      modelNameOverride,
      cost,
    ] of serializedModels) {
      if (!lookupKey || !modelId) {
        continue;
      }

      modelsByLower.set(lookupKey, {
        id: modelId,
        name: modelNameOverride ?? modelId,
        cost,
      });
    }

    catalog.set(providerId, {
      id: providerId,
      name: providerNameOverride ?? providerId,
      modelsByLower,
    });
  }

  return catalog;
}

/**
 * Fetch and compact the upstream catalog, throwing on any failure.
 *
 * It must throw rather than resolve to nothing: `unstable_cache` stores
 * whatever the callback resolves to, so a `null` would pin the outage for the
 * whole revalidate window, and a failed background refresh would overwrite a
 * good snapshot. A thrown refresh keeps the stale snapshot in service instead.
 */
export async function fetchPricingCatalogSnapshot(): Promise<SerializedPricingCatalog> {
  // Skip Next.js fetch caching for the large upstream payload and cache a
  // compact serialized snapshot instead, which stays comfortably under the
  // per-entry data cache limit.
  const response = await fetch(PRICING_CATALOG_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(PRICING_CATALOG_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Pricing catalog request failed: ${response.status}`);
  }

  const payload = (await response.json()) as RawCatalogPayload;
  const snapshot = createPricingCatalogSnapshot(
    payload,
    OFFICIAL_PRICING_PROVIDER_IDS,
  );

  if (snapshot.length === 0) {
    throw new Error("Pricing catalog has none of the priced providers");
  }

  return snapshot;
}

const getCachedPricingCatalogSnapshot = unstable_cache(
  fetchPricingCatalogSnapshot,
  [PRICING_CATALOG_CACHE_KEY],
  {
    revalidate: PRICING_CATALOG_REVALIDATE_SECONDS,
  },
);

export const getPricingCatalog = cache(
  async (): Promise<PricingCatalog | null> => {
    try {
      return hydratePricingCatalogSnapshot(
        await getCachedPricingCatalogSnapshot(),
      );
    } catch (error) {
      console.error("Failed to load the pricing catalog", { error });
      return null;
    }
  },
);
