import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import {
  renderActivityHeatmapSvg,
  resolveActivityHeatmapSvgTheme,
} from "@/lib/social/heatmap-svg";
import { getPublicProfileActivityShareData } from "@/lib/social/queries";
import { SVG_SECURITY_HEADERS } from "@/lib/social/svg-headers";

export async function GET(
  request: Request,
  context: { params: Promise<{ locale: string; username: string }> },
) {
  const { locale, username } = await context.params;

  // A route handler is not wrapped by `[locale]/layout.tsx`, and the proxy
  // skips paths with a dot, so nothing else has checked this segment. The
  // month labels format with it.
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const { searchParams } = new URL(request.url);
  const theme = resolveActivityHeatmapSvgTheme(searchParams.get("theme"));
  const [t, profile] = await Promise.all([
    getTranslations({ locale, namespace: "social.profile" }),
    getPublicProfileActivityShareData({ username }),
  ]);

  if (!profile) {
    notFound();
  }

  const svg = renderActivityHeatmapSvg({
    locale,
    title: t("activityTitle"),
    username: profile.username,
    days: profile.heatmap,
    lessLabel: t("less"),
    moreLabel: t("more"),
    theme,
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      // Kept short and without stale-while-revalidate: shared caches served
      // the heatmap for up to a day after its profile was made private.
      "Cache-Control": "public, max-age=300, s-maxage=300",
      ...SVG_SECURITY_HEADERS,
    },
  });
}
