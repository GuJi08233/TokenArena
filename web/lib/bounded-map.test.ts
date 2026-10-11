import { describe, expect, it } from "vitest";
import { BoundedMap, createFormatterCache } from "./bounded-map";

describe("BoundedMap", () => {
  it("drops the least recently used entry once full", () => {
    const map = new BoundedMap<string, number>(2);

    map.set("a", 1);
    map.set("b", 2);
    // Reading "a" makes "b" the oldest.
    expect(map.get("a")).toBe(1);
    map.set("c", 3);

    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
    expect(map.has("c")).toBe(true);
    expect(map.size).toBe(2);
  });

  it("updates an existing key without evicting anything", () => {
    const map = new BoundedMap<string, number>(2);

    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10);

    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBe(2);
  });

  it("returns undefined for a missing key", () => {
    expect(new BoundedMap<string, number>(1).get("missing")).toBeUndefined();
  });

  it("caps formatter caches no matter how many keys arrive", () => {
    const cache = createFormatterCache<number>();

    for (let index = 0; index < cache.maxEntries * 3; index++) {
      cache.set(`en-x-${index}`, index);
    }

    expect(cache.size).toBe(cache.maxEntries);
  });
});
