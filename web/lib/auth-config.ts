export type AuthMode = "self-hosted" | "production";

/**
 * Authentication mode configuration.
 *
 * - `self-hosted`: Email/password for account creation and fallback sign-in.
 * - `production`: Configured OAuth providers for account creation and fallback sign-in.
 *
 * Existing users can enroll passkeys in either mode.
 *
 * Defaults to `self-hosted` if not set.
 */
export const authMode: AuthMode =
  (process.env.AUTH_MODE as AuthMode) || "self-hosted";

export const isSelfHosted = authMode === "self-hosted";
export const isProduction = authMode === "production";

export const authConfig = {
  mode: authMode,
  isSelfHosted,
  isProduction,
  emailAndPasswordEnabled: isSelfHosted,
  socialProvidersEnabled: isProduction,
} as const;
