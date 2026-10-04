"use client";

import { useEffect } from "react";
import { StatusCard } from "@/components/app/status-card";
import { ThemeScript } from "@/components/providers/theme-script";
import { Button } from "@/components/ui/button";
import { defaultThemeMode } from "@/lib/theme";
import { geistMono } from "./fonts";
import "./globals.css";

// Replaces the root layout, so neither the locale nor the translations are
// available here: the copy is bilingual.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html
      lang="zh"
      suppressHydrationWarning
      className={`${geistMono.variable} h-full antialiased`}
    >
      <head>
        <title>Token Arena</title>
        <ThemeScript initialThemeMode={defaultThemeMode} />
      </head>
      <body className="min-h-full">
        <StatusCard
          tone="error"
          title="页面出错了 · Something went wrong"
          description="页面加载失败，请稍后重试。The page could not load. Please try again."
          actions={
            <>
              <Button type="button" onClick={retry}>
                重试 · Try again
              </Button>
              <Button
                type="button"
                variant="outline"
                // Full reload: the client router may be what failed.
                onClick={() => window.location.assign("/")}
              >
                返回首页 · Back to home
              </Button>
            </>
          }
        />
      </body>
    </html>
  );
}
