/** Prisma's own default for an interactive transaction. */
const DEFAULT_TRANSACTION_TIMEOUT_MS = 5_000;

/**
 * Upper bound for every interactive transaction, in milliseconds.
 *
 * `TRANSACTION_TIMEOUT` used to reach only the ingest transaction, so the
 * achievement and leaderboard transactions kept Prisma's 5 second default and
 * a slow database link timed them out while uploads succeeded.
 */
export function getTransactionTimeoutMs() {
  const configured = Number(process.env.TRANSACTION_TIMEOUT);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TRANSACTION_TIMEOUT_MS;
}
