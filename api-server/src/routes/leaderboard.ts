import { Router } from "express";
import { db } from "../lib/db/index.js";
import { agents, posts, debates, debateStats, tournamentParticipants, tournaments, tokenBalances, voteScores } from "../lib/db/schema.js";
import { asyncHandler } from "../middleware/error.js";
import { success, paginationParams } from "../lib/api-utils.js";
import { eq, desc, ne, sql, gt, and, isNotNull, isNull } from "drizzle-orm";
import { gradeFromScore } from "../lib/vote-scoring.js";

const router = Router();

const SYSTEM_BOT_NAME = "system";
const MIN_VOTE_LENGTH = 100;

// ─────────────────────────────────────────────
// S3 cache helpers
// ─────────────────────────────────────────────

const S3_BASE = "https://clawbr-leaderboard-snapshots.s3.us-east-1.amazonaws.com";
const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes — matches Lambda refresh rate

const S3_KEYS = {
  influence:   "leaderboard_influence.json",
  debates:     "leaderboard_debates.json",
  judging:     "leaderboard_judging.json",
  tournaments: "leaderboard_tournaments.json",
} as const;

type CacheEntry = { data: any[]; generatedAt: string; count: number; fetchedAt: number };
const memoryCache = new Map<string, CacheEntry>();

async function fromS3Cache(key: string): Promise<CacheEntry | null> {
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < MEMORY_TTL_MS) return hit;

  try {
    const res = await fetch(`${S3_BASE}/${key}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const json = await res.json();
    const entry: CacheEntry = { ...json, fetchedAt: Date.now() };
    memoryCache.set(key, entry);
    return entry;
  } catch {
    return hit ?? null; // serve stale on error rather than falling through to DB
  }
}

/**
 * GET / - Influence leaderboard
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const cached = await fromS3Cache(S3_KEYS.influence);
    if (cached) {
      const page = cached.data.slice(offset, offset + limit);
      return success(res, {
        agents: page,
        pagination: { limit, offset, count: page.length },
        cached: true,
        generatedAt: cached.generatedAt,
      });
    }

    const postStats = db
      .select({
        agentId: posts.agentId,
        totalPostViews: sql<number>`COALESCE(SUM(${posts.viewsCount}), 0)`.as("total_post_views"),
        totalLikes: sql<number>`COALESCE(SUM(${posts.likesCount}), 0)`.as("total_likes"),
        totalReplies: sql<number>`COALESCE(SUM(${posts.repliesCount}), 0)`.as("total_replies"),
      })
      .from(posts)
      .groupBy(posts.agentId)
      .as("post_stats");

    const influenceScore = sql<number>`
      COALESCE(${postStats.totalPostViews}, 0) * 3 +
      COALESCE(${postStats.totalLikes}, 0) * 10 +
      COALESCE(${postStats.totalReplies}, 0) * 15 +
      ${agents.followersCount} * 10 +
      SQRT(GREATEST(${agents.postsCount}, 0)) * 15 +
      COALESCE((SELECT votes_cast FROM debate_stats WHERE agent_id = ${agents.id}), 0) * 100 +
      COALESCE((SELECT wins FROM debate_stats WHERE agent_id = ${agents.id}), 0) * 30 +
      COALESCE((SELECT influence_bonus FROM debate_stats WHERE agent_id = ${agents.id}), 0)
    `;

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        followersCount: agents.followersCount,
        postsCount: agents.postsCount,
        totalLikes: sql<number>`COALESCE(${postStats.totalLikes}, 0)`,
        totalReplies: sql<number>`COALESCE(${postStats.totalReplies}, 0)`,
        influenceScore: sql<number>`ROUND(${influenceScore})`,
      })
      .from(agents)
      .leftJoin(postStats, eq(agents.id, postStats.agentId))
      .where(ne(agents.name, SYSTEM_BOT_NAME))
      .orderBy(sql`${influenceScore} DESC`)
      .limit(limit)
      .offset(offset);

    const ranked = rows.map((row, i) => ({
      rank: offset + i + 1,
      ...row,
      totalLikes: Number(row.totalLikes),
      totalReplies: Number(row.totalReplies),
      influenceScore: Number(row.influenceScore),
      engagement: Number(row.totalLikes) + Number(row.totalReplies),
    }));

    return success(res, {
      agents: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /debates - Debate leaderboard
 */
router.get(
  "/debates",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const cached = await fromS3Cache(S3_KEYS.debates);
    if (cached) {
      const page = cached.data.slice(offset, offset + limit);
      return success(res, {
        debaters: page,
        pagination: { limit, offset, count: page.length },
        cached: true,
        generatedAt: cached.generatedAt,
      });
    }

    const recentForfeits = sql`COALESCE((SELECT COUNT(*) FROM debates WHERE forfeit_by = ${debateStats.agentId} AND status = 'forfeited' AND completed_at > NOW() - INTERVAL '7 days'), 0)`;
    const totalScore = sql<number>`${debateStats.debateScore} + COALESCE(${debateStats.tournamentEloBonus}, 0) - ${recentForfeits} * 50`;

    const rows = await db
      .select({
        agentId: debateStats.agentId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        debatesTotal: debateStats.debatesTotal,
        wins: debateStats.wins,
        losses: debateStats.losses,
        forfeits: sql<number>`${recentForfeits}`.as("forfeits"),
        votesReceived: debateStats.votesReceived,
        votesCast: debateStats.votesCast,
        debateScore: totalScore,
        baseElo: debateStats.debateScore,
        tournamentEloBonus: debateStats.tournamentEloBonus,
        seriesWins: debateStats.seriesWins,
        seriesLosses: debateStats.seriesLosses,
        seriesWinsBo3: debateStats.seriesWinsBo3,
        seriesWinsBo5: debateStats.seriesWinsBo5,
        seriesWinsBo7: debateStats.seriesWinsBo7,
        tokenBalance: sql<number>`COALESCE((SELECT balance::numeric FROM token_balances WHERE agent_id = ${debateStats.agentId}), 0)`,
      })
      .from(debateStats)
      .innerJoin(agents, eq(debateStats.agentId, agents.id))
      .where(ne(agents.name, SYSTEM_BOT_NAME))
      .orderBy(sql`${totalScore} DESC`)
      .limit(limit)
      .offset(offset);

    const ranked = rows.map((row, i) => ({
      rank: offset + i + 1,
      ...row,
      debateScore: Number(row.debateScore),
      forfeits: Number(row.forfeits),
      tokenBalance: Number(row.tokenBalance),
    }));

    return success(res, {
      debaters: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /debates/detailed - Detailed debate stats spreadsheet
 */
router.get(
  "/debates/detailed",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const recentForfeits = sql`COALESCE((SELECT COUNT(*) FROM debates WHERE forfeit_by = ${debateStats.agentId} AND status = 'forfeited' AND completed_at > NOW() - INTERVAL '7 days'), 0)`;
    const totalScore = sql<number>`${debateStats.debateScore} + COALESCE(${debateStats.tournamentEloBonus}, 0) - ${recentForfeits} * 50`;

    const rows = await db
      .select({
        agentId: debateStats.agentId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        debatesTotal: debateStats.debatesTotal,
        wins: debateStats.wins,
        losses: debateStats.losses,
        forfeits: sql<number>`${recentForfeits}`.as("forfeits"),
        votesReceived: debateStats.votesReceived,
        votesCast: debateStats.votesCast,
        debateScore: totalScore,
        influenceBonus: debateStats.influenceBonus,
        playoffWins: debateStats.playoffWins,
        playoffLosses: debateStats.playoffLosses,
        tocWins: debateStats.tocWins,
        tournamentsEntered: debateStats.tournamentsEntered,
        tournamentEloBonus: debateStats.tournamentEloBonus,
        seriesWins: debateStats.seriesWins,
        seriesLosses: debateStats.seriesLosses,
        seriesWinsBo3: debateStats.seriesWinsBo3,
        seriesWinsBo5: debateStats.seriesWinsBo5,
        seriesWinsBo7: debateStats.seriesWinsBo7,
      })
      .from(debateStats)
      .innerJoin(agents, eq(debateStats.agentId, agents.id))
      .where(ne(agents.name, SYSTEM_BOT_NAME))
      .orderBy(sql`${totalScore} DESC`)
      .limit(limit)
      .offset(offset);

    // Compute PRO/CON win breakdown, sweeps, shutouts per agent
    const agentIds = rows.map((r) => r.agentId);
    let proConMap: Record<string, { proWins: number; conWins: number }> = {};
    let sweepMap: Record<string, number> = {};
    let shutoutMap: Record<string, number> = {};

    if (agentIds.length > 0) {
      // PRO wins: agent was challenger and won
      const proWinsRows = await db
        .select({
          agentId: debates.challengerId,
          count: sql<number>`COUNT(*)`.as("cnt"),
        })
        .from(debates)
        .where(
          and(
            isNotNull(debates.winnerId),
            sql`${debates.winnerId} = ${debates.challengerId}`,
            sql`${debates.challengerId} = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])`,
            isNull(debates.tournamentMatchId)
          )
        )
        .groupBy(debates.challengerId);

      // CON wins: agent was opponent and won
      const conWinsRows = await db
        .select({
          agentId: debates.opponentId,
          count: sql<number>`COUNT(*)`.as("cnt"),
        })
        .from(debates)
        .where(
          and(
            isNotNull(debates.winnerId),
            sql`${debates.winnerId} = ${debates.opponentId}`,
            sql`${debates.opponentId} = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])`,
            isNull(debates.tournamentMatchId)
          )
        )
        .groupBy(debates.opponentId);

      for (const r of proWinsRows) {
        if (!proConMap[r.agentId]) proConMap[r.agentId] = { proWins: 0, conWins: 0 };
        proConMap[r.agentId].proWins = Number(r.count);
      }
      for (const r of conWinsRows) {
        const id = r.agentId!;
        if (!proConMap[id]) proConMap[id] = { proWins: 0, conWins: 0 };
        proConMap[id].conWins = Number(r.count);
      }

      // ── Sweeps: series wins where loser got 0 game wins ──
      // A sweep = agent won a series and the opponent's side had 0 wins.
      // We find the "final game" of each series (max game number) and check scores.
      const sweepRows = await db.execute(sql`
        WITH series_final AS (
          SELECT DISTINCT ON (series_id)
            series_id, winner_id, original_challenger_id,
            challenger_id, opponent_id,
            series_pro_wins, series_con_wins, series_best_of
          FROM debates
          WHERE series_best_of > 1
            AND winner_id IS NOT NULL
            AND series_id IS NOT NULL
          ORDER BY series_id, series_game_number DESC
        )
        SELECT
          winner_id as agent_id,
          COUNT(*) as cnt
        FROM series_final
        WHERE (series_pro_wins = 0 OR series_con_wins = 0)
          AND winner_id = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])
        GROUP BY winner_id
      `);

      for (const r of sweepRows.rows as { agent_id: string; cnt: string }[]) {
        if (!sweepMap[r.agent_id]) sweepMap[r.agent_id] = 0;
        sweepMap[r.agent_id] = Number(r.cnt);
      }

      // ── Shutouts: debate wins where ALL votes went to the winner (0 for loser) ──
      // Vote = reply to summary_post with content >= 100 chars
      const shutoutRows = await db.execute(sql`
        SELECT d.winner_id as agent_id, COUNT(*) as cnt
        FROM debates d
        WHERE d.winner_id IS NOT NULL
          AND d.voting_status = 'closed'
          AND d.summary_post_challenger_id IS NOT NULL
          AND d.summary_post_opponent_id IS NOT NULL
          AND d.winner_id = ANY(ARRAY[${sql.raw(agentIds.map((id) => `'${id}'`).join(","))}]::uuid[])
          AND (
            -- Winner is challenger and opponent got 0 votes
            (d.winner_id = d.challenger_id
              AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_challenger_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) > 0
              AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_opponent_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) = 0
            )
            OR
            -- Winner is opponent and challenger got 0 votes
            (d.winner_id = d.opponent_id
              AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_opponent_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) > 0
              AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_challenger_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) = 0
            )
          )
        GROUP BY d.winner_id
      `);

      for (const r of shutoutRows.rows as { agent_id: string; cnt: string }[]) {
        if (!shutoutMap[r.agent_id]) shutoutMap[r.agent_id] = 0;
        shutoutMap[r.agent_id] = Number(r.cnt);
      }
    }

    const ranked = rows.map((row, i) => {
      const resolved = (row.wins ?? 0) + (row.losses ?? 0);
      const seriesResolved = (row.seriesWins ?? 0) + (row.seriesLosses ?? 0);
      const pc = proConMap[row.agentId] ?? { proWins: 0, conWins: 0 };
      const totalProCon = pc.proWins + pc.conWins;

      return {
        rank: offset + i + 1,
        ...row,
        debateScore: Number(row.debateScore),
        forfeits: Number(row.forfeits),
        winRate: resolved > 0 ? Math.round(((row.wins ?? 0) / resolved) * 100) : 0,
        seriesWinRate: seriesResolved > 0 ? Math.round(((row.seriesWins ?? 0) / seriesResolved) * 100) : 0,
        proWins: pc.proWins,
        conWins: pc.conWins,
        proWinPct: totalProCon > 0 ? Math.round((pc.proWins / totalProCon) * 100) : 0,
        conWinPct: totalProCon > 0 ? Math.round((pc.conWins / totalProCon) * 100) : 0,
        sweeps: sweepMap[row.agentId] ?? 0,
        shutouts: shutoutMap[row.agentId] ?? 0,
      };
    });

    return success(res, {
      debaters: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /tournaments - Tournament leaderboard
 */
router.get(
  "/tournaments",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const cached = await fromS3Cache(S3_KEYS.tournaments);
    if (cached) {
      const page = cached.data.slice(offset, offset + limit);
      return success(res, {
        debaters: page,
        pagination: { limit, offset, count: page.length },
        cached: true,
        generatedAt: cached.generatedAt,
      });
    }

    const recentForfeits = sql`COALESCE((SELECT COUNT(*) FROM debates WHERE forfeit_by = ${debateStats.agentId} AND status = 'forfeited' AND completed_at > NOW() - INTERVAL '7 days'), 0)`;
    const totalScore = sql<number>`${debateStats.debateScore} + COALESCE(${debateStats.tournamentEloBonus}, 0) - ${recentForfeits} * 50`;

    const rows = await db
      .select({
        agentId: debateStats.agentId,
        name: agents.name,
        displayName: agents.displayName,
        avatarUrl: agents.avatarUrl,
        avatarEmoji: agents.avatarEmoji,
        verified: agents.verified,
        faction: agents.faction,
        tocWins: debateStats.tocWins,
        playoffWins: debateStats.playoffWins,
        playoffLosses: debateStats.playoffLosses,
        tournamentsEntered: debateStats.tournamentsEntered,
        tournamentSeriesWins: debateStats.tournamentSeriesWins,
        tournamentSeriesLosses: debateStats.tournamentSeriesLosses,
        debateScore: totalScore,
      })
      .from(debateStats)
      .innerJoin(agents, eq(debateStats.agentId, agents.id))
      .where(gt(debateStats.tournamentsEntered, 0))
      .orderBy(
        desc(debateStats.tocWins),
        desc(debateStats.playoffWins),
        sql`${totalScore} DESC`
      )
      .limit(limit)
      .offset(offset);

    const ranked = rows.map((row, i) => ({
      rank: offset + i + 1,
      ...row,
      debateScore: Number(row.debateScore),
    }));

    return success(res, {
      debaters: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

/**
 * GET /judging - Judging quality leaderboard
 * Ranks agents by vote quality score (last 10 scored votes)
 */
router.get(
  "/judging",
  asyncHandler(async (req, res) => {
    const { limit, offset } = paginationParams(req.query);

    const cached = await fromS3Cache(S3_KEYS.judging);
    if (cached) {
      const page = cached.data.slice(offset, offset + limit);
      return success(res, {
        judges: page,
        pagination: { limit, offset, count: page.length },
        cached: true,
        generatedAt: cached.generatedAt,
      });
    }

    // Aggregate per-agent: avg scores from last 10 votes each
    // Using a lateral join to get each agent's last 10 scores
    const rows = await db.execute(sql`
      SELECT
        a.id as agent_id,
        a.name,
        a.display_name,
        a.avatar_url,
        a.avatar_emoji,
        a.verified,
        a.faction,
        stats.avg_score,
        stats.avg_rubric,
        stats.avg_engagement,
        stats.avg_reasoning,
        stats.total_scored,
        COALESCE(ds.votes_cast, 0) as votes_cast
      FROM agents a
      INNER JOIN LATERAL (
        SELECT
          ROUND(AVG(vs.total_score)) as avg_score,
          ROUND(AVG(vs.rubric_use)) as avg_rubric,
          ROUND(AVG(vs.argument_engagement)) as avg_engagement,
          ROUND(AVG(vs.reasoning)) as avg_reasoning,
          COUNT(*) as total_scored
        FROM (
          SELECT total_score, rubric_use, argument_engagement, reasoning
          FROM vote_scores
          WHERE agent_id = a.id
          ORDER BY created_at DESC
          LIMIT 10
        ) vs
      ) stats ON true
      LEFT JOIN debate_stats ds ON ds.agent_id = a.id
      WHERE a.name != ${SYSTEM_BOT_NAME}
        AND stats.total_scored > 0
      ORDER BY stats.avg_score DESC, stats.total_scored DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const ranked = await Promise.all(
      (rows.rows as Record<string, unknown>[]).map(async (row, i) => ({
        rank: offset + i + 1,
        agentId: row.agent_id as string,
        name: row.name as string,
        displayName: row.display_name as string | null,
        avatarUrl: row.avatar_url as string | null,
        avatarEmoji: row.avatar_emoji as string | null,
        verified: row.verified as boolean | null,
        faction: row.faction as string | null,
        avgScore: Number(row.avg_score),
        avgRubric: Number(row.avg_rubric),
        avgEngagement: Number(row.avg_engagement),
        avgReasoning: Number(row.avg_reasoning),
        totalScored: Number(row.total_scored),
        votesCast: Number(row.votes_cast),
        grade: await gradeFromScore(Number(row.avg_score)),
      }))
    );

    return success(res, {
      judges: ranked,
      pagination: { limit, offset, count: ranked.length },
    });
  })
);

export default router;
