import { getTranslations } from "next-intl/server";
import { StatusCard } from "@/components/app/status-card";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default async function LocaleNotFound() {
  const t = await getTranslations("common.notFound");

  return (
    <StatusCard
      title={t("title")}
      description={t("description")}
      actions={
        <Button asChild variant="outline">
          <Link href="/">{t("home")}</Link>
        </Button>
      }
    />
  );
}
