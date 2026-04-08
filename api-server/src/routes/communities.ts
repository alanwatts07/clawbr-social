import { Router } from "express";
import { db } from "../lib/db/index.js";
import { communities, communityMembers, agents } from "../lib/db/schema.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { createCommunitySchema } from "../lib/validators/communities.js";
import { isValidUuid } from "../lib/validators/uuid.js";
import { eq, desc, and, sql } from "drizzle-orm";

const router = Router();

const communityColumns = {
  id: communities.id,
  name: communities.name,
  displayName: communities.displayName,
  description: communities.description,
  avatarUrl: communities.avatarUrl,
  membersCount: communities.membersCount,
  createdAt: communities.createdAt,
};

/**
 * GET / - List communities
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const rows = await db
      .select(communityColumns)
      .from(communities)
      .orderBy(desc(communities.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      communities: rows,
      pagination: { limit, offset, count: rows.length },
    });
  })
);

/**
 * POST / - Create community (auth required)
 */
router.post(
  "/",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const parsed = createCommunitySchema.safeParse(req.body);
    if (!parsed.success) return error(res, parsed.error.issues[0].message, 422);

    const { name, display_name, description } = parsed.data;

    const [existing] = await db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.name, name.toLowerCase()))
      .limit(1);

    if (existing) return error(res, "Community name already taken", 409);

    const [community] = await db
      .insert(communities)
      .values({
        name: name.toLowerCase(),
        displayName: display_name ?? name,
        description: description ?? null,
        creatorId: agent.id,
      })
      .returning();

    await db.insert(communityMembers).values({
      communityId: community.id,
      agentId: agent.id,
      role: "admin",
    });

    await db
      .update(communities)
      .set({ membersCount: 1 })
      .where(eq(communities.id, community.id));

    return success(res, community, 201);
  })
);

// Helper to find community by UUID or name
async function findCommunity(id: string) {
  const [community] = isValidUuid(id)
    ? await db.select(communityColumns).from(communities).where(eq(communities.id, id)).limit(1)
    : await db.select(communityColumns).from(communities).where(eq(communities.name, id)).limit(1);
  return community ?? null;
}

/**
 * GET /:id - Get community detail
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const community = await findCommunity(req.params.id);
    if (!community) return error(res, "Community not found", 404);
    return success(res, community);
  })
);

/**
 * POST /:id/join - Join community (auth required)
 */
router.post(
  "/:id/join",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const community = await findCommunity(req.params.id);
    if (!community) return error(res, "Community not found", 404);

    const [existing] = await db
      .select({ agentId: communityMembers.agentId })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, community.id),
          eq(communityMembers.agentId, agent.id)
        )
      )
      .limit(1);

    if (existing) return error(res, "Already a member", 409);

    await db.insert(communityMembers).values({
      communityId: community.id,
      agentId: agent.id,
      role: "member",
    });

    await db
      .update(communities)
      .set({ membersCount: sql`${communities.membersCount} + 1` })
      .where(eq(communities.id, community.id));

    return success(res, { joined: true }, 201);
  })
);

/**
 * POST /:id/leave - Leave community (auth required)
 */
router.post(
  "/:id/leave",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const community = await findCommunity(req.params.id);
    if (!community) return error(res, "Community not found", 404);

    const deleted = await db
      .delete(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, community.id),
          eq(communityMembers.agentId, agent.id)
        )
      )
      .returning();

    if (deleted.length === 0) return error(res, "Not a member", 404);

    await db
      .update(communities)
      .set({ membersCount: sql`GREATEST(${communities.membersCount} - 1, 0)` })
      .where(eq(communities.id, community.id));

    return success(res, { left: true });
  })
);

/**
 * GET /:id/members - List community members
 */
router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const community = await findCommunity(req.params.id);
    if (!community) return error(res, "Community not found", 404);

    const { limit, offset } = paginationParams(req.query);

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        role: communityMembers.role,
        joinedAt: communityMembers.joinedAt,
      })
      .from(communityMembers)
      .innerJoin(agents, eq(communityMembers.agentId, agents.id))
      .where(eq(communityMembers.communityId, community.id))
      .orderBy(desc(communityMembers.joinedAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      members: rows,
      pagination: { limit, offset, count: rows.length },
    });
  })
);

export default router;
