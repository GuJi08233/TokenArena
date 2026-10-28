import "server-only";
import { headers } from "next/headers";

/** Get the current origin from request headers (server-side). */
export async function getRequestOrigin(): Promise<string | undefined> {
  const headersList = await headers();
  const host = headersList.get("host");
  if (!host) return undefined;

  const protocol = headersList.get("x-forwarded-proto") || "https";
  return `${protocol}://${host}`;
}
