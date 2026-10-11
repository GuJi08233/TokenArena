import { APIError } from "better-auth";

/** RFC 5321 limits a forward path to 256 octets, so an address to 254. */
export const EMAIL_MAX_LENGTH = 254;

/** The register and account forms enforce the same limit. */
export const NAME_MAX_LENGTH = 50;

const GUARDED_PATHS = new Set(["/sign-up/email", "/update-user"]);

function reject(message: string): never {
  throw APIError.from("BAD_REQUEST", {
    code: "INVALID_USER_INPUT",
    message,
  });
}

/**
 * Bound the profile fields the email sign-up and update-user endpoints accept.
 *
 * better-auth only checks that an email is well formed and stores any `name`
 * and `image` it is given:
 * - the email local part seeds username generation, so an unbounded one let a
 *   single sign-up request spend arbitrary CPU;
 * - `image` is rendered on public pages as is, so any URL placed there loaded
 *   in every visitor's browser. Avatars come from the linked OAuth account, so
 *   neither endpoint needs to accept one.
 */
export function assertUserInputWithinBounds(
  path: string | undefined,
  body: unknown,
) {
  if (!path || !GUARDED_PATHS.has(path) || !body || typeof body !== "object") {
    return;
  }

  const input = body as Record<string, unknown>;

  if (
    path === "/sign-up/email" &&
    typeof input.email === "string" &&
    input.email.length > EMAIL_MAX_LENGTH
  ) {
    reject("Email is too long.");
  }

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";

    if (!name) {
      reject("Name is required.");
    }

    if (name.length > NAME_MAX_LENGTH) {
      reject("Name is too long.");
    }
  }

  if (input.image !== undefined && input.image !== null) {
    reject("The profile image comes from the linked account.");
  }
}
