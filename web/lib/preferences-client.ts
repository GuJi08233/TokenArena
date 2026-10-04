"use client";

import type { AppLocale } from "@/lib/i18n";
import { localeCookieName } from "@/lib/i18n";
import { type ThemeMode, themeCookieName, themeStorageKey } from "@/lib/theme";
import type { ProjectMode } from "@/lib/usage/types";

const oneYearInSeconds = 60 * 60 * 24 * 365;

type PreferenceUpdate = {
  locale?: AppLocale;
  theme?: ThemeMode;
  timezone?: string;
  projectMode?: ProjectMode;
};

/** Best-effort: never rejects, so callers can fire and forget. */
async function writeCookie(name: string, value: string) {
  try {
    if (typeof cookieStore !== "undefined") {
      await cookieStore.set({
        name,
        value,
        path: "/",
        expires: Date.now() + oneYearInSeconds * 1000,
        sameSite: "lax",
      });
      return;
    }

    // The Cookie Store API only exists in secure contexts, so self-hosted
    // instances served over plain HTTP fall back to document.cookie.
    // biome-ignore lint/suspicious/noDocumentCookie: fallback for contexts without the Cookie Store API
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${oneYearInSeconds}; samesite=lax`;
  } catch (error) {
    console.error(error);
  }
}

export async function persistClientLocale(locale: AppLocale) {
  await writeCookie(localeCookieName, locale);
}

export async function persistClientTheme(theme: ThemeMode) {
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // Storage can be disabled; the cookie below still carries the choice.
  }

  await writeCookie(themeCookieName, theme);
}

export async function persistServerPreference(update: PreferenceUpdate) {
  const response = await fetch("/api/usage/preferences", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to save preferences.");
  }

  return payload;
}
