import { NextResponse } from "next/server";

import { parseJsonBody } from "@/lib/json-body";
import { getOptionalSession } from "@/lib/session";
import { createUsageApiKey, listUsageApiKeys } from "@/lib/usage/api-keys";
import { usageKeyCreateSchema } from "@/lib/usage/contracts";

async function getSessionUserId() {
  const session = await getOptionalSession();

  return session?.user.id ?? null;
}

export async function GET() {
  const userId = await getSessionUserId();

  if (!userId) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const keys = await listUsageApiKeys(userId);

  return NextResponse.json({ keys });
}

export async function POST(request: Request) {
  const userId = await getSessionUserId();

  if (!userId) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = await parseJsonBody(request, usageKeyCreateSchema);

  if (!body.success) {
    return body.response;
  }

  const result = await createUsageApiKey(userId, body.data.name);

  return NextResponse.json({
    key: result.apiKey,
    rawKey: result.rawKey,
  });
}
