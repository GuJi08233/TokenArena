/**
 * Security headers for the SVG documents served from our own origin.
 *
 * The badge and activity SVGs embed text that visitors or profile owners
 * control, e.g. the badge `label` query parameter. Escaping keeps that text
 * inert; this policy also blocks scripts when someone opens the SVG directly,
 * in case an escaping bug ever slips through. Neither SVG loads any external
 * resource, so `default-src 'none'` does not affect how they render.
 */
export const SVG_SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
} as const;
