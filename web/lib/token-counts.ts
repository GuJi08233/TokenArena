const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/** Range of a PostgreSQL `bigint`, the type of every token column. */
const PG_BIGINT_MAX = BigInt("9223372036854775807");
const PG_BIGINT_MIN = BigInt("-9223372036854775808");

/** Range of a PostgreSQL `integer`, the type of the second and count columns. */
export const PG_INTEGER_MAX = 2_147_483_647;
const PG_INTEGER_MIN = -2_147_483_648;

/**
 * Convert a token count for a `bigint` column, saturating at the column range.
 *
 * Uploaded counts are client-reported, so a sum of them can exceed what the
 * column holds. Writing that sum used to abort the whole transaction; a
 * saturated value keeps one account's numbers from failing a shared write.
 */
export function tokenCountToBigInt(value: number | bigint | null | undefined) {
  if (typeof value === "bigint") {
    if (value > PG_BIGINT_MAX) {
      return PG_BIGINT_MAX;
    }

    return value < PG_BIGINT_MIN ? PG_BIGINT_MIN : value;
  }

  const count = value ?? 0;

  if (Number.isNaN(count)) {
    return BigInt(0);
  }

  if (!Number.isFinite(count)) {
    return count > 0 ? PG_BIGINT_MAX : PG_BIGINT_MIN;
  }

  return tokenCountToBigInt(BigInt(Math.trunc(count)));
}

export function tokenCountToNumber(value: number | bigint | null | undefined) {
  if (typeof value === "bigint") {
    if (value > MAX_SAFE_BIGINT) {
      return Number.MAX_SAFE_INTEGER;
    }

    if (value < MIN_SAFE_BIGINT) {
      return Number.MIN_SAFE_INTEGER;
    }

    return Number(value);
  }

  return value ?? 0;
}

/**
 * Convert a summed duration or count for an `integer` column, saturating at
 * the column range. Same reason as `tokenCountToBigInt`: a sum of reported
 * values must not be able to fail a write shared with other users.
 */
export function countToPgInteger(value: number | bigint | null | undefined) {
  const count = tokenCountToNumber(value);

  if (Number.isNaN(count)) {
    return 0;
  }

  return Math.min(PG_INTEGER_MAX, Math.max(PG_INTEGER_MIN, Math.trunc(count)));
}
