/**
 * A `Map` that keeps at most `maxEntries` entries, dropping the least recently
 * used one first.
 *
 * Module-level `Intl` formatter caches are keyed by locale and time zone, and
 * both come in unbounded valid variety: BCP 47 private-use tags, letter-case
 * variants of zone names. Each cached formatter holds about 30 kB outside the
 * JS heap, so an unbounded cache let a stream of distinct keys grow the server
 * process without limit.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly maxEntries: number;

  constructor(maxEntries: number) {
    super();
    this.maxEntries = maxEntries;
  }

  override get(key: K) {
    if (!super.has(key)) {
      return undefined;
    }

    // Re-insert so iteration order tracks recency.
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V) {
    if (super.has(key)) {
      super.delete(key);
    } else if (this.size >= this.maxEntries) {
      const oldest = this.keys().next();
      if (!oldest.done) {
        super.delete(oldest.value);
      }
    }

    return super.set(key, value);
  }
}

/** Room for every locale and zone a deployment really serves at once. */
export const FORMATTER_CACHE_MAX_ENTRIES = 128;

export function createFormatterCache<V>() {
  return new BoundedMap<string, V>(FORMATTER_CACHE_MAX_ENTRIES);
}
