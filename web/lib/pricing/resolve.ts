import {
  normalizeModelLookupKey,
  type PricingCatalog,
  type PricingCatalogModel,
  type PricingCost,
} from "./catalog";
import { OFFICIAL_PRICING_PROVIDER_RULES } from "./providers";

const MODEL_PATH_SEPARATOR = "/";
const MODEL_VARIANT_SEPARATOR = ":";
const CLAUDE_MODEL_PREFIX = "claude-";
const CLAUDE_THINKING_SUFFIX = "-thinking";
const VERSION_DOT_PATTERN = /(\d)\.(?=\d)/g;

export type PricingModelMatch = {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  cost: PricingCost | null;
};

export type PricingProviderMatch = {
  providerId: string;
  providerName: string;
};

export type CostEstimate = {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  reasoningUsd: number;
  cacheUsd: number;
  cacheCreationUsd: number;
};

function _unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function buildModelLookupCandidates(rawModel: string) {
  const normalized = normalizeModelLookupKey(rawModel);
  if (!normalized) {
    return [];
  }

  const candidates = [normalized];
  const lastSegment = normalized.includes(MODEL_PATH_SEPARATOR)
    ? (normalized.split(MODEL_PATH_SEPARATOR).at(-1) ?? "")
    : "";

  if (lastSegment) {
    candidates.push(lastSegment);
  }

  const seen = new Set<string>(candidates.filter(Boolean));

  const values = [normalized, lastSegment].filter((v) =>
    v?.includes(MODEL_VARIANT_SEPARATOR),
  );

  for (const value of values) {
    const variant = value.split(MODEL_VARIANT_SEPARATOR)[0] ?? "";
    if (variant) {
      seen.add(variant);
    }
  }

  for (const candidate of Array.from(seen)) {
    for (const alias of buildClaudeAliases(candidate)) {
      seen.add(alias);
    }
  }

  return Array.from(seen);
}

/**
 * Official Claude ids spell versions with dashes, but routers such as
 * OpenRouter report `claude-opus-4.6`, and some proxies append `-thinking` to
 * the same model at the same price. The aliases come after the exact names so
 * a real catalog id always wins. Other providers are left alone: their ids use
 * dots themselves, and their thinking variants can be priced separately.
 */
function buildClaudeAliases(candidate: string) {
  if (!candidate.startsWith(CLAUDE_MODEL_PREFIX)) {
    return [];
  }

  const dashed = candidate.replace(VERSION_DOT_PATTERN, "$1-");
  const base = dashed.endsWith(CLAUDE_THINKING_SUFFIX)
    ? dashed.slice(0, -CLAUDE_THINKING_SUFFIX.length)
    : dashed;

  return [dashed, base];
}

export function resolveOfficialPricingProviderId(rawModel: string) {
  const candidates = buildModelLookupCandidates(rawModel);

  for (const rule of OFFICIAL_PRICING_PROVIDER_RULES) {
    for (const candidate of candidates) {
      if (rule.matches(candidate)) {
        return rule.providerId;
      }
    }
  }

  return null;
}

export function resolveOfficialPricingProvider(
  catalog: PricingCatalog | null,
  rawModel: string,
): PricingProviderMatch | null {
  if (!catalog) {
    return null;
  }

  const providerId = resolveOfficialPricingProviderId(rawModel);
  if (!providerId) {
    return null;
  }

  const provider = catalog.get(providerId);
  if (!provider) {
    return null;
  }

  return {
    providerId,
    providerName: provider.name,
  };
}

function findCatalogModel(
  catalog: PricingCatalog,
  providerId: string,
  candidates: string[],
): { providerName: string; model: PricingCatalogModel } | null {
  const provider = catalog.get(providerId);
  if (!provider) {
    return null;
  }

  for (const candidate of candidates) {
    const model = provider.modelsByLower.get(candidate);
    if (model) {
      return {
        providerName: provider.name,
        model,
      };
    }
  }

  return null;
}

export function resolveOfficialPricingMatch(
  catalog: PricingCatalog | null,
  rawModel: string,
): PricingModelMatch | null {
  if (!catalog) {
    return null;
  }

  const providerId = resolveOfficialPricingProviderId(rawModel);
  if (!providerId) {
    return null;
  }

  const match = findCatalogModel(
    catalog,
    providerId,
    buildModelLookupCandidates(rawModel),
  );
  if (!match) {
    return null;
  }

  return {
    providerId,
    providerName: match.providerName,
    modelId: match.model.id,
    modelName: match.model.name,
    cost: match.model.cost,
  };
}

export function estimateCostUsd(
  input: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    cacheCreationTokens?: number;
  },
  cost: PricingCost | null | undefined,
): CostEstimate | null {
  if (!cost) {
    return null;
  }

  const inputUsd = (input.inputTokens / 1_000_000) * (cost.input ?? 0);
  const outputUsd = (input.outputTokens / 1_000_000) * (cost.output ?? 0);
  const reasoningUsd =
    (input.reasoningTokens / 1_000_000) * (cost.reasoning ?? cost.output ?? 0);
  const cacheUsd = (input.cachedTokens / 1_000_000) * (cost.cache_read ?? 0);
  // 缓存写入单独计价；目录缺失写入价时保守使用输入价。
  const cacheCreationUsd =
    ((input.cacheCreationTokens ?? 0) / 1_000_000) *
    (cost.cache_write ?? cost.input ?? 0);

  return {
    totalUsd: inputUsd + outputUsd + reasoningUsd + cacheUsd + cacheCreationUsd,
    inputUsd,
    outputUsd,
    reasoningUsd,
    cacheUsd,
    cacheCreationUsd,
  };
}
