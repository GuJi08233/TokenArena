/**
 * Commands shown in the usage dashboard empty-state setup guide (copyable blocks).
 *
 * URL resolution priority:
 * 1. Environment variable `NEXT_PUBLIC_APP_ORIGIN` (via getAppOrigin)
 * 2. Dynamic detection from request headers (server-side)
 * 3. Fallback to default: https://token.guji.uno
 */

import { getAppOrigin } from "@/lib/site-url";

const DEFAULT_API_URL = "https://token.guji.uno";

/** Normalize URL by removing trailing slash. */
function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Get the API URL for CLI commands.
 * Priority: env var > provided origin > default
 */
export function getApiUrl(origin?: string): string {
  const envUrl = getAppOrigin();
  if (envUrl) return normalizeUrl(envUrl);
  if (origin) return normalizeUrl(origin);
  return DEFAULT_API_URL;
}

/** npm install command */
export const USAGE_EMPTY_INSTALL_COMMAND =
  "npm install -g @yishiguji/tokenarena";

/**
 * Generate init command with API URL.
 * Usage: getInitCommand("https://token.guji.uno")
 */
export function getInitCommand(apiUrl: string): string {
  return `tokenarena init --api-url ${apiUrl}`;
}

/**
 * Generate detailed setup guide with comments.
 * Shows environment variable option and direct command.
 */
export function getDetailedInitGuide(apiUrl: string): string {
  return `# 方式一：直接指定服务器地址（推荐）
tokenarena init --api-url ${apiUrl}

# 方式二：先设置环境变量，再初始化
export TOKEN_ARENA_API_URL=${apiUrl}
tokenarena init`;
}

/** Default init command for backward compatibility. */
export const USAGE_EMPTY_INIT_COMMAND = getInitCommand(
  getAppOrigin() || DEFAULT_API_URL,
);
