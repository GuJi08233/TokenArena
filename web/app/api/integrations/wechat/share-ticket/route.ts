import { NextResponse } from "next/server";
import { normalizeLocale } from "@/lib/i18n";
import { parseJsonBody } from "@/lib/json-body";
import { prisma } from "@/lib/prisma";
import { getOptionalSession } from "@/lib/session";
import {
  createWechatProfileShareTicketPayload,
  isWechatShareConfigured,
  wechatShareTicketRequestSchema,
} from "@/lib/wechat/share-server";

export async function POST(request: Request) {
  const session = await getOptionalSession();

  if (!session) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  if (!isWechatShareConfigured()) {
    return NextResponse.json(
      { error: "WECHAT_SHARE_NOT_CONFIGURED" },
      { status: 503 },
    );
  }

  // An empty or malformed body still means "use the defaults".
  const parsedBody = await parseJsonBody(
    request,
    wechatShareTicketRequestSchema,
  );

  if (!parsedBody.success) {
    return parsedBody.response;
  }

  const body = parsedBody.data;

  const user = await prisma.user.findUnique({
    where: {
      id: session.user.id,
    },
    select: {
      name: true,
      username: true,
      usagePreference: {
        select: {
          bio: true,
          publicProfileEnabled: true,
          locale: true,
        },
      },
    },
  });

  if (!user?.username) {
    return NextResponse.json({ error: "USERNAME_REQUIRED" }, { status: 400 });
  }

  if (!user.usagePreference?.publicProfileEnabled) {
    return NextResponse.json({ error: "PROFILE_PRIVATE" }, { status: 403 });
  }

  try {
    const payload = await createWechatProfileShareTicketPayload({
      username: user.username,
      displayName: user.name?.trim() || `@${user.username}`,
      bio: user.usagePreference?.bio,
      locale:
        normalizeLocale(body?.locale) ??
        normalizeLocale(user.usagePreference?.locale) ??
        "en",
      source: body?.source,
    });

    return NextResponse.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "WECHAT_SHARE_FAILED";
    const status = message === "APP_ORIGIN_NOT_CONFIGURED" ? 503 : 502;

    return NextResponse.json({ error: message }, { status });
  }
}
