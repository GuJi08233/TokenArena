import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProfileRangeFilter } from "./profile-range-filter";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ replace: vi.fn() }),
}));

const basePath = "/u/alice";

describe("ProfileRangeFilter", () => {
  it("links every preset back to the profile path", () => {
    const markup = renderToStaticMarkup(
      <ProfileRangeFilter
        basePath={basePath}
        preset="all"
        from={null}
        to={null}
        timezone="Asia/Shanghai"
      />,
    );

    // All-time is the default, so it drops the query string entirely.
    expect(markup).toContain('href="/u/alice"');
    expect(markup).toContain('href="/u/alice?preset=1d"');
    expect(markup).toContain('href="/u/alice?preset=7d"');
    expect(markup).toContain('href="/u/alice?preset=30d"');
    expect(markup).toContain("social.profile.rangeAll");
  });

  it("marks the active preset as the current page", () => {
    const markup = renderToStaticMarkup(
      <ProfileRangeFilter
        basePath={basePath}
        preset="7d"
        from="2026-03-17T16:00:00.000Z"
        to="2026-03-24T06:30:00.000Z"
        timezone="Asia/Shanghai"
      />,
    );

    expect(markup).toMatch(
      /href="\/u\/alice\?preset=7d"[^>]*aria-current="page"/,
    );
    expect(markup).not.toMatch(/href="\/u\/alice"[^>]*aria-current="page"/);
  });

  it("shows the resolved bounds in the viewed profile's timezone", () => {
    const markup = renderToStaticMarkup(
      <ProfileRangeFilter
        basePath={basePath}
        preset="custom"
        from="2026-02-28T16:00:00.000Z"
        to="2026-03-02T15:59:59.999Z"
        timezone="Asia/Shanghai"
      />,
    );

    expect(markup).toContain("2026-03-01");
    expect(markup).toContain("2026-03-02");
  });

  it("omits the caption when no range is applied", () => {
    const markup = renderToStaticMarkup(
      <ProfileRangeFilter
        basePath={basePath}
        preset="all"
        from={null}
        to={null}
        timezone="Asia/Shanghai"
      />,
    );

    expect(markup).not.toContain("→");
  });

  it("escapes usernames that need encoding in the preset links", () => {
    const markup = renderToStaticMarkup(
      <ProfileRangeFilter
        basePath="/u/a%20b"
        preset="all"
        from={null}
        to={null}
        timezone="UTC"
      />,
    );

    expect(markup).toContain('href="/u/a%20b?preset=30d"');
  });
});
