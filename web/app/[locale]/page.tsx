import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AppShell } from "@/components/app/app-shell";
import {
  LandingFeatures,
  LandingFinalCta,
  LandingHero,
  LandingLeaderboardSection,
  LandingPrivacy,
  LandingStatsStrip,
  LandingSteps,
  LandingTools,
} from "@/components/landing/landing-sections";
import { LeaderboardTable } from "@/components/social/leaderboard-table";
import { LeaderboardWindowBadge } from "@/components/social/leaderboard-window-badge";
import { getAuthenticatedAppPath } from "@/lib/account-setup";
import { getLandingStats } from "@/lib/landing/stats";
import { getLeaderboardPageData } from "@/lib/leaderboard/queries";
import {
  defaultLeaderboardMetric,
  type LeaderboardDataset,
} from "@/lib/leaderboard/types";
import { getRequestOrigin } from "@/lib/request-origin";
import { getOptionalSession } from "@/lib/session";
import { getUsagePreference } from "@/lib/usage/preferences";
import {
  getApiUrl,
  getInitCommand,
  USAGE_EMPTY_INSTALL_COMMAND,
} from "@/lib/usage/usage-empty-guide";

const LANDING_LEADERBOARD_SIZE = 10;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "landing" });

  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
    openGraph: {
      title: t("metaTitle"),
      description: t("metaDescription"),
      type: "website",
    },
  };
}

async function getGlobalBoard(
  period: "week" | "all_time",
): Promise<LeaderboardDataset> {
  const data = await getLeaderboardPageData({
    period,
    metric: defaultLeaderboardMetric,
    viewerUserId: null,
  });

  return data.global;
}

/**
 * This week's board, or the all-time one while the week is still empty (a
 * Monday morning, or a fresh instance), so visitors see real names.
 */
async function getLandingBoard(): Promise<LeaderboardDataset | null> {
  try {
    const week = await getGlobalBoard("week");
    return week.entries.length > 0 ? week : await getGlobalBoard("all_time");
  } catch {
    // The page explains the product either way; a failed board query should
    // cost the preview, not the whole landing page.
    return null;
  }
}

export default async function LocaleHomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, session] = await Promise.all([
    params,
    getOptionalSession(),
  ]);

  if (session) {
    const preference = await getUsagePreference(session.user.id);
    redirect(getAuthenticatedAppPath(preference.locale, session.user));
  }

  const [board, stats, origin, t, tBoard, tCard] = await Promise.all([
    getLandingBoard(),
    getLandingStats().catch(() => null),
    getRequestOrigin(),
    getTranslations({ locale, namespace: "landing" }),
    getTranslations({ locale, namespace: "social.leaderboard" }),
    getTranslations({ locale, namespace: "social.card" }),
  ]);

  return (
    <AppShell locale={locale} viewer={null}>
      <div className="space-y-14 pb-6 sm:space-y-20">
        <div className="space-y-8">
          <LandingHero t={t} />
          <LandingStatsStrip t={t} locale={locale} stats={stats} />
        </div>

        {board ? (
          <LandingLeaderboardSection t={t}>
            <LeaderboardTable
              locale={locale}
              title={
                board.period === "week"
                  ? t("leaderboard.weekTitle")
                  : t("leaderboard.allTimeTitle")
              }
              headerRight={
                <LeaderboardWindowBadge
                  locale={locale}
                  period={board.period}
                  windowStart={board.windowStart}
                  windowEnd={board.windowEnd}
                />
              }
              emptyLabel={t("leaderboard.empty")}
              entries={board.entries.slice(0, LANDING_LEADERBOARD_SIZE)}
              labels={{
                rank: tBoard("table.rank"),
                user: tBoard("table.user"),
                totalTokens: tBoard("table.totalTokens"),
                estimatedCost: tBoard("table.estimatedCost"),
                activeTime: tBoard("table.activeTime"),
                sessions: tBoard("table.sessions"),
                mutual: tCard("mutual"),
                you: tCard("you"),
              }}
            />
          </LandingLeaderboardSection>
        ) : null}

        <LandingFeatures t={t} />
        <LandingSteps
          t={t}
          installCommand={USAGE_EMPTY_INSTALL_COMMAND}
          initCommand={getInitCommand(getApiUrl(origin))}
        />
        <LandingTools t={t} />
        <LandingPrivacy t={t} />
        <LandingFinalCta t={t} />
      </div>
    </AppShell>
  );
}
