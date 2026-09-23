import { createHash } from "node:crypto";

const LINUXDO_LOOKUP_TIMEOUT_MS = 1_000;
const LINUXDO_SUCCESS_TTL_MS = 60 * 60 * 1_000;
const LINUXDO_FAILURE_TTL_MS = 60 * 1_000;
const LINUXDO_CACHE_MAX_ENTRIES = 256;

type LinuxdoUsernameCacheEntry = {
  username: string | null;
  expiresAt: number;
};

// The public profile is reachable by anyone. Keep resolved usernames in a
// bounded process-local cache so repeated views do not call the provider with
// the owner's access token. Keys contain a token digest, never the token.
const linuxdoUsernameCache = new Map<string, LinuxdoUsernameCacheEntry>();
const linuxdoLookups = new Map<string, Promise<string | null>>();

function cacheLinuxdoUsername(key: string, username: string | null) {
  linuxdoUsernameCache.delete(key);
  linuxdoUsernameCache.set(key, {
    username,
    expiresAt:
      Date.now() + (username ? LINUXDO_SUCCESS_TTL_MS : LINUXDO_FAILURE_TTL_MS),
  });

  if (linuxdoUsernameCache.size > LINUXDO_CACHE_MAX_ENTRIES) {
    const oldestKey = linuxdoUsernameCache.keys().next().value;
    if (oldestKey) linuxdoUsernameCache.delete(oldestKey);
  }
}

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

  try {
    const response = await fetch(`https://api.github.com/user/${trimmed}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tokenarena-web",
      },
      next: { revalidate: 86_400 },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { html_url?: string };
    return typeof data.html_url === "string" ? data.html_url : null;
  } catch {
    return null;
  }
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
  const cacheKey = `${accountId}:${tokenDigest}`;
  const cached = linuxdoUsernameCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      // Refresh insertion order so the cap evicts the least recently used key.
      linuxdoUsernameCache.delete(cacheKey);
      linuxdoUsernameCache.set(cacheKey, cached);
      return cached.username;
    }
    linuxdoUsernameCache.delete(cacheKey);
  }

  const pending = linuxdoLookups.get(cacheKey);
  if (pending) return pending;

  const lookup = (async () => {
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
  })();
  linuxdoLookups.set(cacheKey, lookup);

  try {
    const username = await lookup;
    cacheLinuxdoUsername(cacheKey, username);
    return username;
  } finally {
    linuxdoLookups.delete(cacheKey);
  }
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
