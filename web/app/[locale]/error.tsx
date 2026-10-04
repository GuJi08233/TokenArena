"use client";

import { RouteErrorCard } from "@/components/app/route-error-card";

export default function LocaleError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return <RouteErrorCard error={error} retry={retry} />;
}
