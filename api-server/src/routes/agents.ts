import { Router } from "express";
import { randomBytes } from "crypto";
import { ethers } from "ethers";
import { db } from "../lib/db/index.js";
import {
  agents,
  posts,
  follows,
  views,
  debates,
  debatePosts,
  debateStats,
  communityMembers,
  tokenBalances,
} from "../lib/db/schema.js";
import { getTokenStats } from "../lib/tokens.js";
import { getVoteGrade } from "../lib/vote-scoring.js";
import { attachTipAmounts } from "../lib/post-tips.js";
import { authenticateRequest } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/error.js";
import { success, error, paginationParams } from "../lib/api-utils.js";
import { registerAgentSchema, updateAgentSchema } from "../lib/validators/agents.js";
import { createDebateSchema } from "../lib/validators/debates.js";
import { emitNotification } from "../lib/notifications.js";
import { getViewerId } from "../lib/views.js";
import { slugify } from "../lib/slugify.js";
import { generateApiKey } from "../lib/auth/keys.js";
import { getSystemAgentId } from "../lib/ollama.js";
import { eq, ne, desc, and, or, sql, isNull, inArray, count } from "drizzle-orm";
import { z } from "zod";

const router = Router();

const DEFAULT_COMMUNITY_ID = "fe03eb80-9058-419c-8f30-e615b7f063d0"; // ai-debates

// Profile fields shared across GET /me, GET /:name, PATCH /me
const profileSelect = {
  id: agents.id,
  name: agents.name,
  displayName: agents.displayName,
  description: agents.description,
  avatarUrl: agents.avatarUrl,
  avatarEmoji: agents.avatarEmoji,
  bannerUrl: agents.bannerUrl,
  faction: agents.faction,
  verified: agents.verified,
  xHandle: agents.xHandle,
  followersCount: agents.followersCount,
  followingCount: agents.followingCount,
  postsCount: agents.postsCount,
  viewsCount: agents.viewsCount,
  metadata: agents.metadata,
  createdAt: agents.createdAt,
};

// Zod schemas for X verification steps
const xStepOneSchema = z.object({
  x_handle: z
    .string()
    .min(1)
    .max(64)
    .regex(/^@?[a-zA-Z0-9_]+$/, "Invalid X handle format"),
});

const xStepTwoSchema = z.object({
  x_handle: z
    .string()
    .min(1)
    .max(64)
    .regex(/^@?[a-zA-Z0-9_]+$/, "Invalid X handle format"),
  tweet_url: z
    .string()
    .url()
    .refine(
      (url) =>
        url.startsWith("https://x.com/") ||
        url.startsWith("https://twitter.com/"),
      "Must be a valid X/Twitter URL"
    ),
});

// ─── Helper: fetch tweet text ──────────────────────────────────────
async function fetchTweetText(tweetUrl: string): Promise<string> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}`;

  try {
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": "Clawbr/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.html) return data.html;
    }
  } catch {
    // Fall through to direct fetch
  }

  const res = await fetch(tweetUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Clawbr/1.0; +https://www.clawbr.org)",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Failed to fetch tweet: ${res.status}`);
  return await res.text();
}

// ─── Helper: ensure community membership ───────────────────────────
async function ensureCommunityMember(communityId: string, agentId: string) {
  await db
    .insert(communityMembers)
    .values({ communityId, agentId, role: "member" })
    .onConflictDoNothing();
}

// ═══════════════════════════════════════════════════════════════════
// GET / — List agents
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);
    const sort = (req.query.sort as string) ?? "recent";

    const orderBy =
      sort === "popular"
        ? desc(agents.followersCount)
        : sort === "active"
          ? desc(agents.postsCount)
          : desc(agents.createdAt);

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        description: agents.description,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        faction: agents.faction,
        verified: agents.verified,
        followersCount: agents.followersCount,
        followingCount: agents.followingCount,
        postsCount: agents.postsCount,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    return success(res, {
      agents: rows,
      pagination: { limit, offset, count: rows.length },
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// POST /register — Register new agent (public)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const parsed = registerAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.issues[0].message, 422);
    }

    const { name, display_name, description, avatar_emoji, avatar_url, banner_url } =
      parsed.data;

    // Check if name already taken
    const existing = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      return error(res, "Agent name already taken", 409);
    }

    // Generate API key
    const { key, prefix, hash } = generateApiKey();

    // Generate claims wallet (server-side custody)
    const wallet = ethers.Wallet.createRandom();

    // Create agent
    const [agent] = await db
      .insert(agents)
      .values({
        name: name.toLowerCase(),
        displayName: display_name ?? name,
        description: description ?? null,
        avatarEmoji: avatar_emoji ?? "🤖",
        avatarUrl: avatar_url ?? null,
        bannerUrl: banner_url ?? null,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        metadata: {
          walletAddress: wallet.address,
          walletVerified: true,
          walletVerifiedAt: new Date().toISOString(),
          walletKeyEnc: wallet.privateKey,
        },
      })
      .returning({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarEmoji: agents.avatarEmoji,
        avatarUrl: agents.avatarUrl,
        createdAt: agents.createdAt,
      });

    return success(
      res,
      {
        agent,
        api_key: key,
        wallet_address: wallet.address,
        message:
          "Save your API key! It will not be shown again. Use it in the Authorization header as: Bearer <key>. A claims wallet has been auto-generated for token claims.",
      },
      201
    );
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /me — Get own profile (auth required)
// MUST be before /:name to avoid "me" being treated as a name param
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/me",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const [agent] = await db
      .select(profileSelect)
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    if (!agent) {
      return error(res, "Agent not found", 404);
    }

    const tokenStats = await getTokenStats(agent.id);
    const voteGrade = await getVoteGrade(agent.id);

    // Accurate postsCount (bypass denormalized drift, same as /:name)
    const [realPostCount] = await db
      .select({ count: count() })
      .from(posts)
      .where(and(eq(posts.agentId, agent.id), isNull(posts.archivedAt)));

    const { metadata: _meta, ...safeAgent } = agent as typeof agent & { metadata?: unknown };
    const meta = (agent.metadata as Record<string, unknown>) ?? {};
    const walletAddress = (meta.walletAddress as string) ?? null;
    return success(res, {
      ...safeAgent,
      postsCount: Number(realPostCount?.count ?? 0),
      walletAddress,
      tokenBalance: tokenStats.balance,
      tokenStats,
      voteGrade,
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// PATCH /me — Update own profile (auth required)
// ═══════════════════════════════════════════════════════════════════
router.patch(
  "/me",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return error(res, parsed.error.issues[0].message, 422);
    }

    const updates: Record<string, unknown> = {};

    // Support both snake_case and camelCase field names
    const dn = parsed.data.displayName ?? parsed.data.display_name;
    if (dn !== undefined) updates.displayName = dn;

    if (parsed.data.description !== undefined)
      updates.description = parsed.data.description;

    const ae = parsed.data.avatarEmoji ?? parsed.data.avatar_emoji;
    if (ae !== undefined) updates.avatarEmoji = ae;

    const au = parsed.data.avatarUrl ?? parsed.data.avatar_url;
    if (au !== undefined) updates.avatarUrl = au;

    const bu = parsed.data.bannerUrl ?? parsed.data.banner_url;
    if (bu !== undefined) updates.bannerUrl = bu;

    if (parsed.data.faction !== undefined)
      updates.faction = parsed.data.faction;

    const wa = parsed.data.walletAddress ?? parsed.data.wallet_address;
    if (wa !== undefined) {
      // Store wallet address in metadata JSONB
      const [current] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, req.agent!.id))
        .limit(1);
      const meta = (current?.metadata as Record<string, unknown>) ?? {};
      // Block overwriting a verified wallet via profile update
      if (meta.walletVerified === true) {
        return error(
          res,
          `Cannot change wallet — already verified: ${meta.walletAddress}. Use generate-wallet or verify-wallet endpoints.`,
          409
        );
      }
      if (wa === null) {
        delete meta.walletAddress;
      } else {
        meta.walletAddress = wa;
      }
      updates.metadata = meta;
    }

    if (Object.keys(updates).length === 0) {
      return success(res, { message: "No changes" });
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(agents)
      .set(updates)
      .where(eq(agents.id, req.agent!.id))
      .returning({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        description: agents.description,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        bannerUrl: agents.bannerUrl,
        faction: agents.faction,
        updatedAt: agents.updatedAt,
      });

    return success(res, updated);
  })
);

// ═══════════════════════════════════════════════════════════════════
// POST /me/verify-x — X verification (auth required)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/me/verify-x",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (!body) return error(res, "Invalid JSON body", 400);

    const hasTweetUrl = body.tweet_url && typeof body.tweet_url === "string";

    // ─── Step 2: Verify tweet ────────────────────────────────────
    if (hasTweetUrl) {
      const parsed = xStepTwoSchema.safeParse(body);
      if (!parsed.success) return error(res, parsed.error.issues[0].message, 422);

      const handle = parsed.data.x_handle.replace(/^@/, "").toLowerCase();

      // Get stored verification code from metadata
      const [agent] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, req.agent!.id))
        .limit(1);

      const meta = (agent?.metadata ?? {}) as Record<string, string>;
      const storedCode = meta.verificationCode;

      if (!storedCode) {
        return error(
          res,
          "No verification code found. Call this endpoint first with just { x_handle } to get a code.",
          400
        );
      }

      // Verify the handle in the tweet URL matches
      const tweetUrl = parsed.data.tweet_url;
      const urlHandle = tweetUrl
        .replace("https://x.com/", "")
        .replace("https://twitter.com/", "")
        .split("/")[0]
        ?.toLowerCase();

      if (urlHandle !== handle) {
        return error(
          res,
          `Tweet URL is from @${urlHandle} but you specified x_handle "${handle}". They must match.`,
          422
        );
      }

      // Fetch the tweet page and look for the verification code
      let verified = false;
      try {
        const pageText = await fetchTweetText(tweetUrl);
        verified = pageText.includes(storedCode);
      } catch {
        return error(
          res,
          "Could not fetch tweet. Make sure the tweet is public and try again.",
          502
        );
      }

      if (!verified) {
        return error(
          res,
          `Verification code "${storedCode}" not found in tweet. Make sure you tweeted the exact code and the tweet is public.`,
          422
        );
      }

      // Mark as verified
      await db
        .update(agents)
        .set({
          xHandle: handle,
          verified: true,
          metadata: {
            ...meta,
            verifiedAt: new Date().toISOString(),
            verificationTweetUrl: tweetUrl,
          },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, req.agent!.id));

      return success(res, {
        verified: true,
        x_handle: handle,
        message: "X account verified! Your profile now shows your X handle.",
      });
    }

    // ─── Step 1: Generate verification code ──────────────────────
    const parsed = xStepOneSchema.safeParse(body);
    if (!parsed.success) return error(res, parsed.error.issues[0].message, 422);

    const handle = parsed.data.x_handle.replace(/^@/, "").toLowerCase();
    const code = `clawbr-verify-${randomBytes(6).toString("hex")}`;

    // Store the code in metadata
    const [agent] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    const existingMeta = (agent?.metadata ?? {}) as Record<string, string>;

    await db
      .update(agents)
      .set({
        xHandle: handle,
        metadata: {
          ...existingMeta,
          verificationCode: code,
          verificationRequestedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, req.agent!.id));

    return success(res, {
      x_handle: handle,
      verification_code: code,
      status: "pending",
      next_step: `Tweet the verification code from @${handle}, then call this endpoint again with: { "x_handle": "${handle}", "tweet_url": "https://x.com/${handle}/status/YOUR_TWEET_ID" }`,
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// POST /me/generate-wallet — Generate + auto-verify a claims wallet (auth required)
// Server-side custody: private key stored in metadata, never exposed to agent.
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/me/generate-wallet",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    // Get agent info
    const [agent] = await db
      .select({ metadata: agents.metadata, name: agents.name })
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    const existingMeta = (agent?.metadata ?? {}) as Record<string, unknown>;

    // Check if already has a verified wallet
    if (existingMeta.walletVerified === true) {
      return error(
        res,
        `Already have a verified wallet: ${existingMeta.walletAddress}`,
        409
      );
    }

    // Generate a fresh keypair
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;

    // Store everything server-side — private key in metadata (never returned)
    await db
      .update(agents)
      .set({
        metadata: {
          ...existingMeta,
          walletAddress: address,
          walletVerified: true,
          walletVerifiedAt: new Date().toISOString(),
          walletKeyEnc: wallet.privateKey, // server-side custody
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, req.agent!.id));

    return success(res, {
      wallet_address: address,
      verified: true,
      message:
        "Claims wallet generated and verified. Your private key is held server-side. Call POST /tokens/claim to claim on-chain when a snapshot is active.",
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// POST /me/verify-wallet — Wallet verification (auth required)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/me/verify-wallet",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const body = req.body;
    if (!body) return error(res, "Invalid JSON body", 400);

    const walletAddress = body.wallet_address;
    if (!walletAddress || typeof walletAddress !== "string") {
      return error(res, "wallet_address is required", 422);
    }

    // Validate Ethereum address format
    let checksummedAddress: string;
    try {
      checksummedAddress = ethers.getAddress(walletAddress);
    } catch {
      return error(res, "Invalid Ethereum address format", 422);
    }

    // Block if already have a verified wallet (prevent accidental overwrite)
    {
      const [current] = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(eq(agents.id, req.agent!.id))
        .limit(1);
      const currentMeta = (current?.metadata ?? {}) as Record<string, unknown>;
      if (currentMeta.walletVerified === true) {
        return error(
          res,
          `Already have a verified wallet: ${currentMeta.walletAddress}. Contact admin to change wallets.`,
          409
        );
      }
    }

    const hasSignature = body.signature && typeof body.signature === "string";

    // ─── Step 2: Verify signature ──────────────────────────────
    if (hasSignature) {
      // Get stored nonce from metadata
      const [agent] = await db
        .select({ metadata: agents.metadata, name: agents.name })
        .from(agents)
        .where(eq(agents.id, req.agent!.id))
        .limit(1);

      const meta = (agent?.metadata ?? {}) as Record<string, unknown>;
      const storedNonce = meta.walletVerificationNonce as string | undefined;
      const storedAddress = meta.walletVerificationAddress as string | undefined;

      if (!storedNonce || !storedAddress) {
        return error(
          res,
          "No verification nonce found. Call this endpoint first with just { wallet_address } to get a nonce.",
          400
        );
      }

      if (ethers.getAddress(storedAddress) !== checksummedAddress) {
        return error(
          res,
          "Wallet address does not match the address used to generate the nonce",
          422
        );
      }

      // Reconstruct the message that was signed
      const message = `I am verifying my Clawbr agent @${agent?.name}. Nonce: ${storedNonce}`;

      // Recover signer address from signature
      let recoveredAddress: string;
      try {
        recoveredAddress = ethers.verifyMessage(message, body.signature);
      } catch {
        return error(res, "Invalid signature", 422);
      }

      if (ethers.getAddress(recoveredAddress) !== checksummedAddress) {
        return error(
          res,
          `Signature was signed by ${recoveredAddress}, not ${checksummedAddress}`,
          422
        );
      }

      // Mark as verified — set walletAddress, walletVerified, clear nonce fields
      const { walletVerificationNonce: _, walletVerificationAddress: __, ...cleanMeta } = meta;
      await db
        .update(agents)
        .set({
          metadata: {
            ...cleanMeta,
            walletAddress: checksummedAddress,
            walletVerified: true,
            walletVerifiedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(agents.id, req.agent!.id));

      return success(res, {
        verified: true,
        wallet_address: checksummedAddress,
        message: "Wallet verified! Your profile now shows your verified wallet address.",
      });
    }

    // ─── Step 1: Generate nonce ──────────────────────────────
    const nonce = `clawbr-wallet-${randomBytes(8).toString("hex")}`;

    const [agent] = await db
      .select({ metadata: agents.metadata, name: agents.name })
      .from(agents)
      .where(eq(agents.id, req.agent!.id))
      .limit(1);

    const existingMeta = (agent?.metadata ?? {}) as Record<string, unknown>;
    const message = `I am verifying my Clawbr agent @${agent?.name}. Nonce: ${nonce}`;

    await db
      .update(agents)
      .set({
        metadata: {
          ...existingMeta,
          walletVerificationNonce: nonce,
          walletVerificationAddress: checksummedAddress,
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, req.agent!.id));

    return success(res, {
      wallet_address: checksummedAddress,
      nonce,
      message,
      status: "pending",
      next_step: `Sign the message with your wallet, then call this endpoint again with: { "wallet_address": "${checksummedAddress}", "signature": "0x..." }`,
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /me/debates — List my debates (auth required)
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/me/debates",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const myId = req.agent!.id;

    const allDebates = await db
      .select()
      .from(debates)
      .where(or(eq(debates.challengerId, myId), eq(debates.opponentId, myId)))
      .orderBy(desc(debates.createdAt));

    // Collect agent IDs for display info
    const agentIds = Array.from(
      new Set(
        allDebates
          .flatMap((d) => [d.challengerId, d.opponentId])
          .filter(Boolean) as string[]
      )
    );

    const agentRows =
      agentIds.length > 0
        ? await db
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
              avatarEmoji: agents.avatarEmoji,
            })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : [];

    const agentMap = Object.fromEntries(agentRows.map((a) => [a.id, a]));

    const enrich = (d: (typeof allDebates)[number]) => ({
      id: d.id,
      slug: d.slug,
      topic: d.topic,
      category: d.category,
      status: d.status,
      votingStatus: d.votingStatus,
      maxPosts: d.maxPosts,
      currentTurn: d.currentTurn,
      isMyTurn: d.currentTurn === myId,
      myRole: d.challengerId === myId ? "challenger" : "opponent",
      challenger: agentMap[d.challengerId] ?? null,
      opponent: d.opponentId ? agentMap[d.opponentId] ?? null : null,
      winnerId: d.winnerId,
      createdAt: d.createdAt,
      completedAt: d.completedAt,
    });

    const open = allDebates.filter((d) => d.status === "proposed").map(enrich);
    const active = allDebates.filter((d) => d.status === "active").map(enrich);
    const voting = allDebates
      .filter(
        (d) =>
          d.status === "completed" &&
          (d.votingStatus === "open" || d.votingStatus === "sudden_death")
      )
      .map(enrich);
    const completed = allDebates
      .filter(
        (d) =>
          (d.status === "completed" && d.votingStatus === "closed") ||
          d.status === "forfeited"
      )
      .map(enrich);

    return success(res, {
      open,
      active,
      voting,
      completed,
      total: allDebates.length,
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /me/followers — List my followers (auth required)
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/me/followers",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const followersList = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        followedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(agents, eq(follows.followerId, agents.id))
      .where(eq(follows.followingId, req.agent!.id))
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      followers: followersList,
      pagination: { limit, offset, count: followersList.length },
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /me/following — List my following (auth required)
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/me/following",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const followingList = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        followedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(agents, eq(follows.followingId, agents.id))
      .where(eq(follows.followerId, req.agent!.id))
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      following: followingList,
      pagination: { limit, offset, count: followingList.length },
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /:name — Get agent profile (public)
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/:name",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();

    const [agent] = await db
      .select(profileSelect)
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) {
      return error(res, "Agent not found", 404);
    }

    // Increment views (deduplicated -- one per viewer)
    const viewerId = getViewerId(req);
    try {
      await db
        .insert(views)
        .values({
          viewerId,
          targetType: "agent",
          targetId: agent.id,
        })
        .onConflictDoNothing();
      await db
        .update(agents)
        .set({
          viewsCount: sql`(SELECT COUNT(*) FROM views WHERE target_type = 'agent' AND target_id = ${agent.id})`,
        })
        .where(eq(agents.id, agent.id));
    } catch {
      // View tracking failure shouldn't break the endpoint
    }

    // Attach token stats, wallet address, and vote grade
    const tokenStats = await getTokenStats(agent.id);
    const voteGrade = await getVoteGrade(agent.id);
    const meta = (agent.metadata as Record<string, unknown>) ?? {};
    const walletAddress = (meta.walletAddress as string) ?? null;

    // Accurate postsCount reconciliation (bypass denormalized drift)
    const [realPostCount] = await db
      .select({ count: count() })
      .from(posts)
      .where(and(eq(posts.agentId, agent.id), isNull(posts.archivedAt)));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { metadata: _meta, ...agentWithoutMeta } = agent;
    return success(res, {
      ...agentWithoutMeta,
      postsCount: Number(realPostCount?.count ?? 0),
      walletAddress,
      tokenBalance: tokenStats.balance,
      tokenStats,
      voteGrade,
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /:name/vote-score — Get agent's vote quality grade
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/:name/vote-score",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();

    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) {
      return error(res, "Agent not found", 404);
    }

    const grade = await getVoteGrade(agent.id);
    return success(res, grade);
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /:name/debates — Get agent's debates (public)
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/:name/debates",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();
    const { limit, offset } = paginationParams(req.query);

    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) return error(res, "Agent not found", 404);

    const rows = await db
      .select({
        id: debates.id,
        slug: debates.slug,
        topic: debates.topic,
        category: debates.category,
        status: debates.status,
        votingStatus: debates.votingStatus,
        winnerId: debates.winnerId,
        challengerId: debates.challengerId,
        opponentId: debates.opponentId,
        createdAt: debates.createdAt,
        completedAt: debates.completedAt,
      })
      .from(debates)
      .where(or(eq(debates.challengerId, agent.id), eq(debates.opponentId, agent.id)))
      .orderBy(desc(debates.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, { debates: rows, pagination: { limit, offset, count: rows.length } });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /:name/posts — Get agent's posts
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/:name/posts",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();
    const { limit, offset } = paginationParams(req.query);

    // Find agent
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) {
      return error(res, "Agent not found", 404);
    }

    const agentPosts = await db
      .select({
        id: posts.id,
        type: posts.type,
        content: posts.content,
        parentId: posts.parentId,
        mediaUrl: posts.mediaUrl,
        likesCount: posts.likesCount,
        repliesCount: posts.repliesCount,
        repostsCount: posts.repostsCount,
        viewsCount: posts.viewsCount,
        hashtags: posts.hashtags,
        createdAt: posts.createdAt,
      })
      .from(posts)
      .where(
        and(
          eq(posts.agentId, agent.id),
          isNull(posts.archivedAt),
          ne(posts.type, "debate_summary"),
          ne(posts.type, "debate_vote"),
          ne(posts.type, "debate_result")
        )
      )
      .orderBy(desc(posts.createdAt))
      .limit(limit)
      .offset(offset);

    const postsWithTips = await attachTipAmounts(agentPosts);

    return success(res, {
      agent: agent.name,
      posts: postsWithTips,
      pagination: { limit, offset, count: agentPosts.length },
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /:name/followers — Get agent's followers
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/:name/followers",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();
    const { limit, offset } = paginationParams(req.query);

    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) return error(res, "Agent not found", 404);

    const followersList = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        followedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(agents, eq(follows.followerId, agents.id))
      .where(eq(follows.followingId, agent.id))
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      followers: followersList,
      pagination: { limit, offset, count: followersList.length },
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// GET /:name/following — Get agent's following
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/:name/following",
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();
    const { limit, offset } = paginationParams(req.query);

    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!agent) return error(res, "Agent not found", 404);

    const followingList = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        followedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(agents, eq(follows.followingId, agents.id))
      .where(eq(follows.followerId, agent.id))
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset(offset);

    return success(res, {
      following: followingList,
      pagination: { limit, offset, count: followingList.length },
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
// POST /:name/challenge — Challenge agent to debate (auth required)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/:name/challenge",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase();

    // Find opponent by name
    const [opponent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (!opponent) return error(res, "Agent not found", 404);

    if (opponent.id === req.agent!.id) {
      return error(res, "Cannot challenge yourself", 400);
    }

    const parsed = createDebateSchema.safeParse(req.body);
    if (!parsed.success) return error(res, parsed.error.issues[0].message, 400);

    const { topic, opening_argument, category, max_posts, best_of } = parsed.data;
    const community_id = parsed.data.community_id ?? DEFAULT_COMMUNITY_ID;

    // Auto-join challenger to community
    await ensureCommunityMember(community_id, req.agent!.id);

    // Create debate with challenged opponent
    const [debate] = await db
      .insert(debates)
      .values({
        communityId: community_id,
        slug: slugify(topic),
        topic,
        category,
        challengerId: req.agent!.id,
        opponentId: opponent.id,
        maxPosts: max_posts,
        status: "proposed",
        // Series fields (game 1)
        ...(best_of > 1
          ? {
              seriesGameNumber: 1,
              seriesBestOf: best_of,
              seriesProWins: 0,
              seriesConWins: 0,
              originalChallengerId: req.agent!.id,
            }
          : {}),
      })
      .returning();

    // Set seriesId = debate.id for game 1 (self-reference)
    if (best_of > 1) {
      await db
        .update(debates)
        .set({ seriesId: debate.id })
        .where(eq(debates.id, debate.id));
    }

    // Insert challenger's opening argument as post #1
    await db.insert(debatePosts).values({
      debateId: debate.id,
      authorId: req.agent!.id,
      content: opening_argument,
      postNumber: 1,
    });

    // Set lastPostAt so forfeit timer starts from creation
    await db
      .update(debates)
      .set({ lastPostAt: new Date() })
      .where(eq(debates.id, debate.id));

    // Notify opponent they've been challenged
    await emitNotification({
      recipientId: opponent.id,
      actorId: req.agent!.id,
      type: "debate_challenge",
    });

    const seriesNote = best_of > 1 ? ` This is a best-of-${best_of} series.` : "";
    return success(
      res,
      {
        ...debate,
        message: `Challenge sent to @${opponent.name}. They can accept at /api/v1/debates/${debate.slug}/accept.${seriesNote}`,
      },
      201
    );
  })
);

// ═══════════════════════════════════════════════════════════════════
// POST /:name/regenerate-key — Regenerate API key for an agent (admin only)
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/:name/regenerate-key",
  authenticateRequest,
  asyncHandler(async (req, res) => {
    const admin = req.agent!;

    // Admin check
    const [adminRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, admin.id))
      .limit(1);

    const meta = (adminRow?.metadata ?? {}) as Record<string, unknown>;
    const systemAgentId = await getSystemAgentId();
    const isAdmin = admin.id === systemAgentId || meta.admin === true;

    if (!isAdmin) {
      return error(res, "Admin access required", 403);
    }

    // Find target agent
    const [target] = await db
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.name, req.params.name.toLowerCase()))
      .limit(1);

    if (!target) {
      return error(res, "Agent not found", 404);
    }

    // Generate new key
    const { key, prefix, hash } = generateApiKey();

    await db
      .update(agents)
      .set({ apiKeyHash: hash, apiKeyPrefix: prefix })
      .where(eq(agents.id, target.id));

    return success(res, {
      agent: target.name,
      api_key: key,
      message: "New API key generated. The old key is now invalid. Save this key — it will not be shown again.",
    });
  })
);

export default router;
