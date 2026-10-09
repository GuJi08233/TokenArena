import { createHash } from "node:crypto";

const LINUXDO_LOOKUP_TIMEOUT_MS = 1_000;
const LINUXDO_SUCCESS_TTL_MS = 60 * 60 * 1_000;
const GITHUB_LOOKUP_TIMEOUT_MS = 2_000;
const GITHUB_SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_LOOKUP_FAILURE_TTL_MS = 60 * 1_000;
const PROVIDER_LOOKUP_CACHE_MAX_ENTRIES = 256;

type ProviderLookupCacheEntry = {
  value: string | null;
  expiresAt: number;
};

/**
 * A bounded, process-local cache for one provider's profile lookups.
 *
 * The public profile is reachable by anyone and waits for these lookups, so
 * repeated views must not call the provider again — failures included, or an
 * unreachable provider would hold up every view until its request gave up.
 * Concurrent views of one profile share a single pending request.
 */
function createProviderLookup(successTtlMs: number) {
  const entries = new Map<string, ProviderLookupCacheEntry>();
  const pending = new Map<string, Promise<string | null>>();

  function remember(key: string, value: string | null) {
    entries.delete(key);
    entries.set(key, {
      value,
      expiresAt:
        Date.now() + (value ? successTtlMs : PROVIDER_LOOKUP_FAILURE_TTL_MS),
    });

    if (entries.size > PROVIDER_LOOKUP_CACHE_MAX_ENTRIES) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey) entries.delete(oldestKey);
    }
  }

  return async function lookup(
    key: string,
    load: () => Promise<string | null>,
  ): Promise<string | null> {
    const cached = entries.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        // Refresh insertion order so the cap evicts the least recently used key.
        entries.delete(key);
        entries.set(key, cached);
        return cached.value;
      }
      entries.delete(key);
    }

    const inflight = pending.get(key);
    if (inflight) return inflight;

    const request = load();
    pending.set(key, request);

    try {
      const value = await request;
      remember(key, value);
      return value;
    } finally {
      pending.delete(key);
    }
  };
}

// Keys contain a digest of the owner's access token, never the token.
const lookupLinuxdoUsername = createProviderLookup(LINUXDO_SUCCESS_TTL_MS);
const lookupGithubProfileUrl = createProviderLookup(GITHUB_SUCCESS_TTL_MS);

export const LINKED_PROFILE_PROVIDER_IDS = [
  "github",
  "linuxdo",
  "watcha",
] as const;

export type LinkedProfileProviderId =
  (typeof LINKED_PROFILE_PROVIDER_IDS)[number];

export function pickLinkedAccount(
  accounts: Array<{
    providerId: string;
    accountId: string;
    accessToken?: string | null;
  }>,
): {
  providerId: LinkedProfileProviderId;
  accountId: string;
  accessToken?: string | null;
} | null {
  const order: LinkedProfileProviderId[] = ["github", "linuxdo", "watcha"];
  const accountMap = new Map(accounts.map((a) => [a.providerId, a] as const));

  for (const providerId of order) {
    const found = accountMap.get(providerId);
    if (found?.accountId?.trim()) {
      return {
        providerId,
        accountId: found.accountId,
        accessToken: found.accessToken,
      };
    }
  }

  return null;
}

async function resolveGithubProfileUrl(
  accountId: string,
): Promise<string | null> {
  const trimmed = accountId.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^\d+$/.test(trimmed)) {
    return `https://github.com/${encodeURIComponent(trimmed)}`;
  }

  // GitHub OAuth stores the numeric user id, so every GitHub-linked profile
  // takes this path.
  return lookupGithubProfileUrl(trimmed, async () => {
    try {
      const response = await fetch(`https://api.github.com/user/${trimmed}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "tokenarena-web",
        },
        next: { revalidate: 86_400 },
        signal: AbortSignal.timeout(GITHUB_LOOKUP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { html_url?: string };
      return typeof data.html_url === "string" ? data.html_url : null;
    } catch {
      return null;
    }
  });
}

async function resolveLinuxdoUsernameFromAccessToken(
  accountId: string,
  accessToken?: string | null,
): Promise<string | null> {
  const trimmedToken = accessToken?.trim();

  if (!trimmedToken) {
    return null;
  }

  const tokenDigest = createHash("sha256").update(trimmedToken).digest("hex");

  return lookupLinuxdoUsername(`${accountId}:${tokenDigest}`, async () => {
    try {
      const response = await fetch("https://connect.linux.do/api/user", {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${trimmedToken}`,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(LINUXDO_LOOKUP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { username?: string };
      const username =
        typeof data.username === "string" ? data.username.trim() : "";

      return username || null;
    } catch {
      return null;
    }
  });
}

async function resolveLinuxdoProfileUrl(
  accountId: string,
  accessToken?: string | null,
): Promise<string | null> {
  const trimmed = accountId.trim();

  if (!trimmed) {
    return null;
  }

  const slug = /^\d+$/.test(trimmed)
    ? await resolveLinuxdoUsernameFromAccessToken(trimmed, accessToken)
    : trimmed;

  return slug ? `https://linux.do/u/${encodeURIComponent(slug)}/summary` : null;
}

function resolveWatchaProfileUrl(accountId: string): string {
  return `https://watcha.cn/user/${encodeURIComponent(accountId.trim())}`;
}

export async function resolveLinkedProfileUrl(
  providerId: string,
  accountId: string,
  accessToken?: string | null,
): Promise<string | null> {
  switch (providerId) {
    case "github":
      return resolveGithubProfileUrl(accountId);
    case "linuxdo":
      return resolveLinuxdoProfileUrl(accountId, accessToken);
    case "watcha":
      return resolveWatchaProfileUrl(accountId);
    default:
      return null;
  }
}
