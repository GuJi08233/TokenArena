import { cookies, headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { StatusCard } from "@/components/app/status-card";
import { Button } from "@/components/ui/button";
import { getPreferredLocale, localeCookieName } from "@/lib/i18n";

// Handles URLs outside the `[locale]` segment (e.g. `/unknown.txt`), where no
// locale is known yet, so pick one the same way the home redirect does.
export default async function NotFound() {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = getPreferredLocale({
    cookieLocale: cookieStore.get(localeCookieName)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
  const t = await getTranslations({ locale, namespace: "common.notFound" });

  return (
    <StatusCard
      title={t("title")}
      description={t("description")}
      actions={
        <Button asChild variant="outline">
          <Link href={`/${locale}`}>{t("home")}</Link>
        </Button>
      }
    />
  );
}
