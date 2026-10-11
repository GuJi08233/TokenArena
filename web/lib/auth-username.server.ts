import { randomUUID } from "node:crypto";
import {
  isValidUsername,
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@/lib/auth-username";

type UsernameLookupResult = {
  id: string;
};

type FindUserByUsername = (
  username: string,
) => Promise<UsernameLookupResult | null>;

type GenerateUniqueUsernameOptions = {
  findUserByUsername: FindUserByUsername;
  createRandomSuffix?: () => string;
  maxAttempts?: number;
};

type ResolveCreatedUsernameOptions = {
  providedUsername?: string | null;
  seed: string;
  findUserByUsername: FindUserByUsername;
  createRandomSuffix?: () => string;
};

export type ResolvedCreatedUsername = {
  username: string;
  usernameNeedsSetup: boolean;
  usernameAutoAdjusted: boolean;
};

function createRandomSuffix() {
  return randomUUID().slice(0, 6);
}

/**
 * How much of a seed is considered. A username holds at most
 * `USERNAME_MAX_LENGTH` characters, so a longer seed only costs time: the seed
 * comes from the email local part, which sign-up does not bound.
 */
const USERNAME_SEED_MAX_LENGTH = 64;

function isSeparator(char: string) {
  return char === "." || char === "_";
}

/**
 * Drop leading and trailing separators in one pass. `/[._]+$/` backtracks
 * quadratically on a long run of separators that does not reach the end.
 */
function trimSeparators(value: string) {
  let start = 0;
  let end = value.length;

  while (start < end && isSeparator(value[start])) start++;
  while (end > start && isSeparator(value[end - 1])) end--;

  return value.slice(start, end);
}

function createUsernameCandidateBase(value: string) {
  return trimSeparators(
    value
      .trim()
      .slice(0, USERNAME_SEED_MAX_LENGTH)
      .toLowerCase()
      .replace(/[^a-z0-9_.]+/g, ".")
      .replace(/[.]{2,}/g, "."),
  );
}

/**
 * A provider's username rewritten to satisfy local username rules, or `null`
 * when nothing usable remains. Providers allow characters ours do not:
 * Linux.do accepts `-`, for one.
 */
export function toUsernameCandidate(value: string) {
  const candidate = trimSeparators(
    createUsernameCandidateBase(value).slice(0, USERNAME_MAX_LENGTH),
  );

  return candidate.length >= USERNAME_MIN_LENGTH && isValidUsername(candidate)
    ? candidate
    : null;
}

export async function generateUniqueUsername(
  seed: string,
  {
    findUserByUsername,
    createRandomSuffix: createSuffix = createRandomSuffix,
    maxAttempts = 12,
  }: GenerateUniqueUsernameOptions,
) {
  const fallbackBase = "user";
  const normalizedBase = createUsernameCandidateBase(seed);
  const base =
    normalizedBase.length >= USERNAME_MIN_LENGTH
      ? normalizedBase
      : fallbackBase;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const suffix = attempt === 0 ? "" : `.${createSuffix()}`;
    const maxBaseLength = USERNAME_MAX_LENGTH - suffix.length;
    const candidateBase = base.slice(0, Math.max(maxBaseLength, 0)).trim();
    const candidate = `${candidateBase || fallbackBase}${suffix}`;
    const existingUser = await findUserByUsername(candidate);

    if (!existingUser) {
      return candidate;
    }
  }

  return `user.${createSuffix()}`;
}

export async function resolveCreatedUsername({
  providedUsername,
  seed,
  findUserByUsername,
  createRandomSuffix,
}: ResolveCreatedUsernameOptions): Promise<ResolvedCreatedUsername> {
  const normalizedProvidedUsername =
    typeof providedUsername === "string"
      ? normalizeUsername(providedUsername)
      : "";

  if (!normalizedProvidedUsername) {
    return {
      username: await generateUniqueUsername(seed, {
        findUserByUsername,
        createRandomSuffix,
      }),
      usernameNeedsSetup: true,
      usernameAutoAdjusted: false,
    };
  }

  const existingUser = await findUserByUsername(normalizedProvidedUsername);

  if (!existingUser) {
    return {
      username: normalizedProvidedUsername,
      usernameNeedsSetup: false,
      usernameAutoAdjusted: false,
    };
  }

  return {
    username: await generateUniqueUsername(normalizedProvidedUsername, {
      findUserByUsername,
      createRandomSuffix,
    }),
    usernameNeedsSetup: false,
    usernameAutoAdjusted: true,
  };
}
