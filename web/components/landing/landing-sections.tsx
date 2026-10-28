import {
  ArrowRight,
  ChartColumn,
  Code,
  EyeOff,
  Hash,
  Medal,
  ShieldCheck,
  Trophy,
  UserRound,
} from "lucide-react";
import type { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UsageEmptyCopyableCommand } from "@/components/usage/usage-empty-copyable-command";
import { Link } from "@/i18n/navigation";
import type { LandingStats } from "@/lib/landing/stats";
import { SUPPORTED_TOOLS } from "@/lib/landing/supported-tools";
import { formatTokenCount } from "@/lib/usage/format";

type LandingTranslator = Awaited<ReturnType<typeof getTranslations>>;

type SectionProps = {
  t: LandingTranslator;
};

function SectionHeading({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1.5">
        <h2
          id={id}
          className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
        >
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ?? null}
    </div>
  );
}

export function LandingHero({ t }: SectionProps) {
  return (
    <section
      aria-labelledby="landing-hero-title"
      className="space-y-6 pt-4 sm:pt-10"
    >
      <p className="text-sm font-medium text-muted-foreground">
        {t("hero.eyebrow")}
      </p>
      <h1
        id="landing-hero-title"
        className="max-w-4xl text-3xl font-semibold tracking-tight text-foreground sm:text-5xl"
      >
        {t("hero.title")}
      </h1>
      <p className="max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
        {t("hero.description", { count: SUPPORTED_TOOLS.length })}
      </p>
      <div className="flex flex-wrap gap-3">
        <Button asChild size="lg" className="px-4">
          <Link href="/login">
            {t("hero.primaryCta")}
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="px-4">
          <Link href="/leaderboard">
            <Trophy data-icon="inline-start" aria-hidden="true" />
            {t("hero.secondaryCta")}
          </Link>
        </Button>
      </div>
    </section>
  );
}

export function LandingStatsStrip({
  t,
  locale,
  stats,
}: SectionProps & { locale: string; stats: LandingStats | null }) {
  // A fresh instance has nothing worth bragging about yet.
  if (!stats || stats.developers === 0) {
    return null;
  }

  const items = [
    {
      key: "developers",
      label: t("stats.developers"),
      value: stats.developers.toLocaleString(locale),
    },
    {
      key: "totalTokens",
      label: t("stats.totalTokens"),
      value: formatTokenCount(stats.totalTokens, locale),
    },
    {
      key: "weekTokens",
      label: t("stats.weekTokens"),
      value: formatTokenCount(stats.weekTokens, locale),
    },
    {
      key: "activeHours",
      label: t("stats.activeHours"),
      value: Math.floor(stats.activeSeconds / 3600).toLocaleString(locale),
    },
  ];

  return (
    <section aria-label={t("stats.label")} className="space-y-2">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((item) => (
          <div
            key={item.key}
            className="rounded-xl bg-background px-4 py-3 shadow-sm ring-1 ring-border/60"
          >
            <dt className="text-sm text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("stats.note")}</p>
    </section>
  );
}

export function LandingLeaderboardSection({
  t,
  children,
}: SectionProps & { children: ReactNode }) {
  return (
    <section aria-labelledby="landing-leaderboard-title" className="space-y-4">
      <SectionHeading
        id="landing-leaderboard-title"
        title={t("leaderboard.title")}
        description={t("leaderboard.description")}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/leaderboard">
              {t("leaderboard.viewAll")}
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      {children}
    </section>
  );
}

const FEATURES = [
  { key: "dashboard", icon: ChartColumn },
  { key: "leaderboard", icon: Trophy },
  { key: "achievements", icon: Medal },
  { key: "profile", icon: UserRound },
] as const;

export function LandingFeatures({ t }: SectionProps) {
  return (
    <section aria-labelledby="landing-features-title" className="space-y-4">
      <SectionHeading id="landing-features-title" title={t("features.title")} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {FEATURES.map(({ key, icon: Icon }) => (
          <li key={key}>
            <Card className="h-full shadow-sm ring-1 ring-border/60">
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <Icon
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <h3>{t(`features.${key}.title`)}</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t(`features.${key}.description`)}
                </p>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LandingSteps({
  t,
  installCommand,
  initCommand,
}: SectionProps & { installCommand: string; initCommand: string }) {
  const steps = [
    {
      key: "step1",
      command: null,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/login">{t("hero.primaryCta")}</Link>
        </Button>
      ),
    },
    { key: "step2", command: installCommand, action: null },
    { key: "step3", command: initCommand, action: null },
  ];

  return (
    <section aria-labelledby="landing-steps-title" className="space-y-4">
      <SectionHeading
        id="landing-steps-title"
        title={t("steps.title")}
        description={t("steps.description")}
      />
      <ol className="grid gap-3 lg:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.key}>
            <Card className="h-full shadow-sm ring-1 ring-border/60">
              <CardContent className="flex h-full flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-background"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <h3 className="font-medium text-foreground">
                    {t(`steps.${step.key}Title`)}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t(`steps.${step.key}Description`)}
                </p>
                <div className="mt-auto">
                  {step.command ? (
                    <UsageEmptyCopyableCommand command={step.command} />
                  ) : (
                    step.action
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function LandingTools({ t }: SectionProps) {
  return (
    <section aria-labelledby="landing-tools-title" className="space-y-4">
      <SectionHeading
        id="landing-tools-title"
        title={t("tools.title", { count: SUPPORTED_TOOLS.length })}
        description={t("tools.description")}
      />
      <ul className="flex flex-wrap gap-2">
        {SUPPORTED_TOOLS.map((tool) => (
          <li
            key={tool.id}
            className="rounded-full bg-background px-3 py-1 text-sm text-foreground shadow-xs ring-1 ring-border/60"
          >
            {tool.name}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PRIVACY_POINTS = [
  { key: "uploads", icon: ShieldCheck },
  { key: "projects", icon: Hash },
  { key: "profile", icon: EyeOff },
  { key: "openSource", icon: Code },
] as const;

export function LandingPrivacy({ t }: SectionProps) {
  return (
    <section aria-labelledby="landing-privacy-title" className="space-y-4">
      <SectionHeading id="landing-privacy-title" title={t("privacy.title")} />
      <ul className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {PRIVACY_POINTS.map(({ key, icon: Icon }) => (
          <li key={key} className="flex gap-3">
            <Icon
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <h3 className="font-medium text-foreground">
                {t(`privacy.${key}.title`)}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t(`privacy.${key}.description`)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LandingFinalCta({ t }: SectionProps) {
  return (
    <section aria-labelledby="landing-final-cta-title">
      <Card className="shadow-sm ring-1 ring-border/60">
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2
              id="landing-final-cta-title"
              className="text-lg font-semibold tracking-tight text-foreground"
            >
              {t("finalCta.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("finalCta.description")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/login">
                {t("finalCta.button")}
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/leaderboard">{t("hero.secondaryCta")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
