import { describe, expect, it } from "vitest";
import {
  countToPgInteger,
  PG_INTEGER_MAX,
  tokenCountToBigInt,
  tokenCountToNumber,
} from "./token-counts";

const PG_BIGINT_MAX = BigInt("9223372036854775807");

describe("tokenCountToBigInt", () => {
  it("converts numbers to bigint for Prisma writes", () => {
    expect(tokenCountToBigInt(6_355_629_440)).toBe(BigInt(6_355_629_440));
  });

  it("saturates sums that a bigint column cannot hold", () => {
    expect(tokenCountToBigInt(1e20)).toBe(PG_BIGINT_MAX);
    expect(tokenCountToBigInt(PG_BIGINT_MAX + BigInt(1))).toBe(PG_BIGINT_MAX);
    expect(tokenCountToBigInt(Number.POSITIVE_INFINITY)).toBe(PG_BIGINT_MAX);
    expect(tokenCountToBigInt(-1e20)).toBe(BigInt("-9223372036854775808"));
  });

  it("writes NaN as zero instead of throwing", () => {
    expect(tokenCountToBigInt(Number.NaN)).toBe(BigInt(0));
  });

  it("returns BigInt(0) when value is null", () => {
    expect(tokenCountToBigInt(null)).toBe(BigInt(0));
  });

  it("returns BigInt(0) when value is undefined", () => {
    expect(tokenCountToBigInt(undefined)).toBe(BigInt(0));
  });

  it("returns a bigint as-is when value is already bigint", () => {
    expect(tokenCountToBigInt(BigInt(100))).toBe(BigInt(100));
  });
});

describe("tokenCountToNumber", () => {
  it("converts bigint values back to numbers for UI reads", () => {
    expect(tokenCountToNumber(BigInt(2_272_772_480))).toBe(2_272_772_480);
  });

  it("clamps values above the safe integer limit", () => {
    expect(
      tokenCountToNumber(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("clamps values below the safe integer limit", () => {
    expect(
      tokenCountToNumber(BigInt(Number.MIN_SAFE_INTEGER) - BigInt(1)),
    ).toBe(Number.MIN_SAFE_INTEGER);
  });

  it("returns 0 when value is null", () => {
    expect(tokenCountToNumber(null)).toBe(0);
  });

  it("returns 0 when value is undefined", () => {
    expect(tokenCountToNumber(undefined)).toBe(0);
  });

  it("returns a plain number as-is", () => {
    expect(tokenCountToNumber(42)).toBe(42);
  });
});

describe("countToPgInteger", () => {
  it("keeps counts inside the integer column range", () => {
    expect(countToPgInteger(3_600)).toBe(3_600);
    expect(countToPgInteger(2 * PG_INTEGER_MAX)).toBe(PG_INTEGER_MAX);
    expect(countToPgInteger(BigInt(PG_INTEGER_MAX) * BigInt(3))).toBe(
      PG_INTEGER_MAX,
    );
    expect(countToPgInteger(-1e12)).toBe(-2_147_483_648);
  });

  it("treats missing and NaN values as zero", () => {
    expect(countToPgInteger(null)).toBe(0);
    expect(countToPgInteger(undefined)).toBe(0);
    expect(countToPgInteger(Number.NaN)).toBe(0);
  });
});
