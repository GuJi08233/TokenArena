import { after, NextResponse } from "next/server";
import { synchronizeAchievementsInBackground } from "@/lib/achievements/queries";
import { normalizeUsername } from "@/lib/auth-username";
import { prisma } from "@/lib/prisma";
import { getOptionalSession } from "@/lib/session";
import { followTagUpdateSchema } from "@/lib/social/contracts";

/**
 * Re-evaluate both sides' social achievements once the response is sent.
 *
 * Only a follow that actually changed reaches this: repeating a request used
 * to replay the other account's whole history every time, and a failed
 * replay reported a follow that had already been saved as failed.
 */
function synchronizeSocialAchievements(
  followerId: string,
  followingId: string,
) {
  after(async () => {
    await synchronizeAchievementsInBackground(followerId, "social");
    await synchronizeAchievementsInBackground(followingId, "social");
  });
}

async function getTargetUser(username: string) {
  return prisma.user.findUnique({
    where: {
      username: normalizeUsername(username),
    },
    select: {
      id: true,
      usagePreference: {
        select: {
          publicProfileEnabled: true,
        },
      },
    },
  });
}

export async function POST(
  _request: Request,
  context: RouteContext<"/api/social/follows/[username]">,
) {
  const session = await getOptionalSession();

  if (!session) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const { username } = await context.params;
  const targetUser = await getTargetUser(username);

  if (!targetUser) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  if (targetUser.id === session.user.id) {
    return NextResponse.json({ error: "INVALID_TARGET" }, { status: 400 });
  }

  if (!targetUser.usagePreference?.publicProfileEnabled) {
    return NextResponse.json({ error: "PROFILE_PRIVATE" }, { status: 403 });
  }

  const created = await prisma.follow.createMany({
    data: [
      {
        followerId: session.user.id,
        followingId: targetUser.id,
      },
    ],
    skipDuplicates: true,
  });

  if (created.count > 0) {
    synchronizeSocialAchievements(session.user.id, targetUser.id);
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/social/follows/[username]">,
) {
  const session = await getOptionalSession();

  if (!session) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const { username } = await context.params;
  const targetUser = await getTargetUser(username);

  if (!targetUser) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const removed = await prisma.follow.deleteMany({
    where: {
      followerId: session.user.id,
      followingId: targetUser.id,
    },
  });

  if (removed.count > 0) {
    synchronizeSocialAchievements(session.user.id, targetUser.id);
  }

  return NextResponse.json({ success: true });
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/social/follows/[username]">,
) {
  const session = await getOptionalSession();

  if (!session) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = followTagUpdateSchema.parse(await request.json());
  const { username } = await context.params;
  const targetUser = await getTargetUser(username);

  if (!targetUser) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  if (targetUser.id === session.user.id) {
    return NextResponse.json({ error: "INVALID_TARGET" }, { status: 400 });
  }

  const result = await prisma.follow.updateMany({
    where: {
      followerId: session.user.id,
      followingId: targetUser.id,
    },
    data: {
      tag: body.tag,
    },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    success: true,
    tag: body.tag,
  });
}
