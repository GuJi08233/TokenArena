/**
 * Bind a timestamp as an explicit UTC literal.
 *
 * `DateTime` lives in a `timestamp(3)` column — no time zone — holding the UTC
 * wall-clock value, and `::timestamp` ignores any offset in its input rather
 * than applying it. An ISO string therefore casts to exactly the value Prisma
 * writes. A bound `Date` lands on the same value today because the adapter
 * serializes via `getUTC*`, but that is its internal detail; spelling the
 * intent out keeps hand-written statements correct regardless.
 */
export function toUtcTimestampLiteral(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
