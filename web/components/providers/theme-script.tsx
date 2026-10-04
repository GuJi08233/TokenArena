"use client";

import {
  defaultThemeMode,
  type ThemeMode,
  themeModes,
  themeStorageKey,
} from "@/lib/theme";

type ThemeScriptProps = {
  initialThemeMode: ThemeMode;
};

export function buildThemeInitScript(initialThemeMode: ThemeMode) {
  return `
(() => {
  try {
    const root = document.documentElement;
    let storedTheme = null;
    try {
      storedTheme = window.localStorage.getItem(${JSON.stringify(themeStorageKey)});
    } catch {}
    const theme = ${JSON.stringify(themeModes)}.includes(storedTheme)
      ? storedTheme
      : ${JSON.stringify(initialThemeMode ?? defaultThemeMode)};
    const resolvedTheme = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";

    root.classList.toggle("dark", resolvedTheme === "dark");
    root.dataset.themeMode = theme;
    root.style.colorScheme = resolvedTheme;
  } catch {}
})();
`;
}

/**
 * Applies the saved theme while the HTML is still being parsed, so dark-mode
 * users never see a light first paint. Render it inside `<head>`: `next/script`
 * would defer inline code until after hydration.
 *
 * Only the server-rendered copy is executable. When React renders the tree on
 * the client (e.g. 404 responses) it gets `text/plain`, which never runs and
 * avoids React's script-tag warning; the type mismatch is expected.
 */
export function ThemeScript({ initialThemeMode }: ThemeScriptProps) {
  // biome-ignore-start lint/security/noDangerouslySetInnerHtml: static script built from constants; it must run before first paint
  return (
    // react-doctor-disable-next-line react-doctor/nextjs-no-native-script -- next/script defers inline code until after hydration
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      // react-doctor-disable-next-line react/no-danger -- static script built from constants; it must run before first paint
      dangerouslySetInnerHTML={{
        __html: buildThemeInitScript(initialThemeMode),
      }}
    />
  );
  // biome-ignore-end lint/security/noDangerouslySetInnerHtml: static script built from constants; it must run before first paint
}
