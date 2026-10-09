import { afterEach, describe, expect, it, vi } from "vitest";
import { getTransactionTimeoutMs } from "./transaction-timeout";

describe("getTransactionTimeoutMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps Prisma's default when unset", () => {
    vi.stubEnv("TRANSACTION_TIMEOUT", "");
    expect(getTransactionTimeoutMs()).toBe(5_000);
  });

  it("uses a configured positive value", () => {
    vi.stubEnv("TRANSACTION_TIMEOUT", "15000");
    expect(getTransactionTimeoutMs()).toBe(15_000);
  });

  it("ignores values Prisma would reject", () => {
    for (const value of ["abc", "-1", "0", "Infinity"]) {
      vi.stubEnv("TRANSACTION_TIMEOUT", value);
      expect(getTransactionTimeoutMs()).toBe(5_000);
    }
  });
});
