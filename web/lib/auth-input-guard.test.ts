import { describe, expect, it } from "vitest";
import {
  assertUserInputWithinBounds,
  EMAIL_MAX_LENGTH,
  NAME_MAX_LENGTH,
} from "./auth-input-guard";

describe("assertUserInputWithinBounds", () => {
  it("accepts the fields the register and account forms send", () => {
    expect(() =>
      assertUserInputWithinBounds("/sign-up/email", {
        name: "Alice",
        username: "alice",
        email: "alice@example.com",
        password: "correct-horse-battery",
      }),
    ).not.toThrow();
    expect(() =>
      assertUserInputWithinBounds("/update-user", {
        name: "Alice",
        username: "alice",
      }),
    ).not.toThrow();
  });

  it("rejects an email longer than an address can be", () => {
    expect(() =>
      assertUserInputWithinBounds("/sign-up/email", {
        name: "Alice",
        email: `${"a".repeat(EMAIL_MAX_LENGTH)}@example.com`,
        password: "correct-horse-battery",
      }),
    ).toThrow("Email is too long.");
  });

  it("rejects a blank, non-string or oversized name", () => {
    expect(() =>
      assertUserInputWithinBounds("/update-user", { name: "   " }),
    ).toThrow("Name is required.");
    expect(() =>
      assertUserInputWithinBounds("/update-user", { name: 42 }),
    ).toThrow("Name is required.");
    expect(() =>
      assertUserInputWithinBounds("/update-user", {
        name: "x".repeat(NAME_MAX_LENGTH + 1),
      }),
    ).toThrow("Name is too long.");
  });

  it("rejects a client-supplied profile image but allows clearing it", () => {
    for (const path of ["/sign-up/email", "/update-user"]) {
      expect(() =>
        assertUserInputWithinBounds(path, {
          image: "https://tracker.example/pixel.gif",
        }),
      ).toThrow("The profile image comes from the linked account.");
    }
    expect(() =>
      assertUserInputWithinBounds("/update-user", { image: null }),
    ).not.toThrow();
  });

  it("leaves every other endpoint alone", () => {
    expect(() =>
      assertUserInputWithinBounds("/sign-in/email", {
        email: `${"a".repeat(1_000)}@example.com`,
      }),
    ).not.toThrow();
    expect(() => assertUserInputWithinBounds(undefined, null)).not.toThrow();
  });
});
