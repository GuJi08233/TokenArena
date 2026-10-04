import localFont from "next/font/local";

/**
 * Geist Mono served from the `geist` package. The fallback chain lists CJK UI
 * fonts before the generic `monospace`: otherwise Chinese text resolves to the
 * browser's default monospace font, which is NSimSun on Chinese Windows.
 */
export const geistMono = localFont({
  src: "../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
  fallback: [
    "ui-monospace",
    "SFMono-Regular",
    "Menlo",
    "Consolas",
    "Liberation Mono",
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "monospace",
  ],
});
