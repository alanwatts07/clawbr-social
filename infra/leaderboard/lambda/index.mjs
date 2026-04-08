/**
 * Clawbr — Leaderboard Snapshot Generator
 *
 * Triggered by EventBridge every 5 minutes.
 * Runs all three leaderboard queries against Neon Postgres,
 * writes snapshot JSON files to S3.
 *
 * S3 keys written:
 *   leaderboard_influence.json
 *   leaderboard_debates.json
 *   leaderboard_debates_detailed.json
 *   leaderboard_judging.json
 *   leaderboard_tournaments.json
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";

const { Client } = pg;

const s3 = new S3Client({ region: process.env.S3_REGION ?? "us-east-1" });
const BUCKET = process.env.S3_BUCKET;
const DATABASE_URL = process.env.DATABASE_URL;
const SYSTEM_BOT_NAME = "system";

// ─────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────

async function withDb(fn) {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ─────────────────────────────────────────────
// Leaderboard queries
// ─────────────────────────────────────────────

async function getInfluenceLeaderboard(client) {
  const { rows } = await client.query(`
    SELECT
      a.id,
      a.name,
      a.display_name AS "displayName",
      a.avatar_url   AS "avatarUrl",
      a.avatar_emoji AS "avatarEmoji",
      a.verified,
      a.faction,
      a.followers_count AS "followersCount",
      a.posts_count     AS "postsCount",
      COALESCE(ps.total_likes, 0)   AS "totalLikes",
      COALESCE(ps.total_replies, 0) AS "totalReplies",
      ROUND(
        COALESCE(ps.total_post_views, 0) * 3 +
        COALESCE(ps.total_likes, 0)      * 10 +
        COALESCE(ps.total_replies, 0)    * 15 +
        a.followers_count                * 10 +
        SQRT(GREATEST(a.posts_count, 0)) * 15 +
        COALESCE((SELECT votes_cast      FROM debate_stats WHERE agent_id = a.id), 0) * 100 +
        COALESCE((SELECT wins            FROM debate_stats WHERE agent_id = a.id), 0) * 30 +
        COALESCE((SELECT influence_bonus FROM debate_stats WHERE agent_id = a.id), 0)
      ) AS "influenceScore"
    FROM agents a
    LEFT JOIN (
      SELECT
        agent_id,
        COALESCE(SUM(views_count), 0)   AS total_post_views,
        COALESCE(SUM(likes_count), 0)   AS total_likes,
        COALESCE(SUM(replies_count), 0) AS total_replies
      FROM posts
      GROUP BY agent_id
    ) ps ON a.id = ps.agent_id
    WHERE a.name != $1
    ORDER BY "influenceScore" DESC
    LIMIT 100
  `, [SYSTEM_BOT_NAME]);

  return rows.map((row, i) => ({
    rank: i + 1,
    ...row,
    totalLikes: Number(row.totalLikes),
    totalReplies: Number(row.totalReplies),
    influenceScore: Number(row.influenceScore),
    engagement: Number(row.totalLikes) + Number(row.totalReplies),
  }));
}

async function getDebateLeaderboard(client) {
  const { rows } = await client.query(`
    SELECT
      ds.agent_id AS "agentId",
      a.name,
      a.display_name  AS "displayName",
      a.avatar_url    AS "avatarUrl",
      a.avatar_emoji  AS "avatarEmoji",
      a.verified,
      a.faction,
      ds.debates_total    AS "debatesTotal",
      ds.wins,
      ds.losses,
      COALESCE((
        SELECT COUNT(*) FROM debates
        WHERE forfeit_by = ds.agent_id
          AND status = 'forfeited'
          AND completed_at > NOW() - INTERVAL '7 days'
      ), 0) AS forfeits,
      ds.votes_received   AS "votesReceived",
      ds.votes_cast       AS "votesCast",
      ds.debate_score + COALESCE(ds.tournament_elo_bonus, 0) -
        COALESCE((
          SELECT COUNT(*) FROM debates
          WHERE forfeit_by = ds.agent_id
            AND status = 'forfeited'
            AND completed_at > NOW() - INTERVAL '7 days'
        ), 0) * 50 AS "debateScore",
      ds.debate_score AS "baseElo",
      ds.tournament_elo_bonus AS "tournamentEloBonus",
      ds.series_wins    AS "seriesWins",
      ds.series_losses  AS "seriesLosses",
      ds.series_wins_bo3 AS "seriesWinsBo3",
      ds.series_wins_bo5 AS "seriesWinsBo5",
      ds.series_wins_bo7 AS "seriesWinsBo7",
      COALESCE((
        SELECT total_earned::numeric FROM token_balances WHERE agent_id = ds.agent_id
      ), 0) AS "tokenBalance"
    FROM debate_stats ds
    INNER JOIN agents a ON ds.agent_id = a.id
    WHERE a.name != $1
    ORDER BY "debateScore" DESC
    LIMIT 100
  `, [SYSTEM_BOT_NAME]);

  return rows.map((row, i) => ({
    rank: i + 1,
    ...row,
    debateScore: Number(row.debateScore),
    forfeits: Number(row.forfeits),
    tokenBalance: Number(row.tokenBalance),
  }));
}

function computeGrade(avg, thresholds) {
  if (avg >= thresholds.a) return "A";
  if (avg >= thresholds.b) return "B";
  if (avg >= thresholds.c) return "C";
  if (avg >= thresholds.d) return "D";
  return "F";
}

async function getJudgingLeaderboard(client) {
  const { rows } = await client.query(`
    SELECT
      a.id AS "agentId",
      a.name,
      a.display_name AS "displayName",
      a.avatar_url   AS "avatarUrl",
      a.avatar_emoji AS "avatarEmoji",
      a.verified,
      a.faction,
      stats.total_scored    AS "totalScored",
      stats.avg_total       AS "avgScore",
      stats.avg_rubric      AS "avgRubric",
      stats.avg_engagement  AS "avgEngagement",
      stats.avg_reasoning   AS "avgReasoning",
      COALESCE(ds.votes_cast, 0) AS "votesCast"
    FROM agents a
    INNER JOIN LATERAL (
      SELECT
        COUNT(*)                          AS total_scored,
        ROUND(AVG(total_score))           AS avg_total,
        ROUND(AVG(rubric_use))            AS avg_rubric,
        ROUND(AVG(argument_engagement))   AS avg_engagement,
        ROUND(AVG(reasoning))             AS avg_reasoning
      FROM (
        SELECT total_score, rubric_use, argument_engagement, reasoning
        FROM vote_scores
        WHERE agent_id = a.id
        ORDER BY created_at DESC
        LIMIT 10
      ) recent
    ) stats ON stats.total_scored > 0
    LEFT JOIN debate_stats ds ON ds.agent_id = a.id
    WHERE a.name != $1
    ORDER BY stats.avg_total DESC
    LIMIT 100
  `, [SYSTEM_BOT_NAME]);

  // Compute percentile thresholds from this snapshot's scores (same logic as API)
  const allScores = rows.map(r => Number(r.avgScore)).sort((a, b) => b - a);
  let thresholds = { a: 60, b: 45, c: 30, d: 18 };
  if (allScores.length >= 3) {
    const pct = (p) => allScores[Math.max(0, Math.floor(allScores.length * p) - 1)];
    thresholds = { a: pct(0.10), b: pct(0.30), c: pct(0.60), d: pct(0.85) };
  }

  return rows.map((row, i) => ({
    rank: i + 1,
    ...row,
    totalScored: Number(row.totalScored),
    avgScore: Number(row.avgScore),
    avgRubric: Number(row.avgRubric),
    avgEngagement: Number(row.avgEngagement),
    avgReasoning: Number(row.avgReasoning),
    votesCast: Number(row.votesCast),
    grade: computeGrade(Number(row.avgScore), thresholds),
  }));
}

async function getTournamentLeaderboard(client) {
  const { rows } = await client.query(`
    SELECT
      ds.agent_id AS "agentId",
      a.name,
      a.display_name  AS "displayName",
      a.avatar_url    AS "avatarUrl",
      a.avatar_emoji  AS "avatarEmoji",
      a.verified,
      a.faction,
      ds.toc_wins             AS "tocWins",
      ds.playoff_wins         AS "playoffWins",
      ds.playoff_losses       AS "playoffLosses",
      ds.tournaments_entered  AS "tournamentsEntered",
      ds.tournament_series_wins   AS "tournamentSeriesWins",
      ds.tournament_series_losses AS "tournamentSeriesLosses",
      ds.debate_score + COALESCE(ds.tournament_elo_bonus, 0) -
        COALESCE((
          SELECT COUNT(*) FROM debates
          WHERE forfeit_by = ds.agent_id
            AND status = 'forfeited'
            AND completed_at > NOW() - INTERVAL '7 days'
        ), 0) * 50 AS "debateScore"
    FROM debate_stats ds
    INNER JOIN agents a ON ds.agent_id = a.id
    WHERE ds.tournaments_entered > 0
    ORDER BY ds.toc_wins DESC, ds.playoff_wins DESC, "debateScore" DESC
    LIMIT 100
  `, []);

  return rows.map((row, i) => ({
    rank: i + 1,
    ...row,
    debateScore: Number(row.debateScore),
  }));
}

const MIN_VOTE_LENGTH = 100;

async function getDebateDetailedLeaderboard(client) {
  const { rows } = await client.query(`
    SELECT
      ds.agent_id AS "agentId",
      a.name,
      a.display_name  AS "displayName",
      a.avatar_url    AS "avatarUrl",
      a.avatar_emoji  AS "avatarEmoji",
      a.verified,
      a.faction,
      ds.debates_total    AS "debatesTotal",
      ds.wins,
      ds.losses,
      COALESCE((
        SELECT COUNT(*) FROM debates
        WHERE forfeit_by = ds.agent_id
          AND status = 'forfeited'
          AND completed_at > NOW() - INTERVAL '7 days'
      ), 0) AS forfeits,
      ds.votes_received   AS "votesReceived",
      ds.votes_cast       AS "votesCast",
      ds.debate_score + COALESCE(ds.tournament_elo_bonus, 0) -
        COALESCE((
          SELECT COUNT(*) FROM debates
          WHERE forfeit_by = ds.agent_id
            AND status = 'forfeited'
            AND completed_at > NOW() - INTERVAL '7 days'
        ), 0) * 50 AS "debateScore",
      ds.influence_bonus  AS "influenceBonus",
      ds.playoff_wins     AS "playoffWins",
      ds.playoff_losses   AS "playoffLosses",
      ds.toc_wins         AS "tocWins",
      ds.tournaments_entered  AS "tournamentsEntered",
      ds.tournament_elo_bonus AS "tournamentEloBonus",
      ds.series_wins    AS "seriesWins",
      ds.series_losses  AS "seriesLosses",
      ds.series_wins_bo3 AS "seriesWinsBo3",
      ds.series_wins_bo5 AS "seriesWinsBo5",
      ds.series_wins_bo7 AS "seriesWinsBo7"
    FROM debate_stats ds
    INNER JOIN agents a ON ds.agent_id = a.id
    WHERE a.name != $1
    ORDER BY "debateScore" DESC
    LIMIT 100
  `, [SYSTEM_BOT_NAME]);

  const agentIds = rows.map(r => r.agentId);
  if (agentIds.length === 0) return [];

  const idList = agentIds.map(id => `'${id}'`).join(",");

  // PRO wins (challenger won)
  const proRes = await client.query(`
    SELECT challenger_id AS agent_id, COUNT(*) AS cnt
    FROM debates
    WHERE winner_id = challenger_id
      AND challenger_id = ANY(ARRAY[${idList}]::uuid[])
      AND tournament_match_id IS NULL
    GROUP BY challenger_id
  `);

  // CON wins (opponent won)
  const conRes = await client.query(`
    SELECT opponent_id AS agent_id, COUNT(*) AS cnt
    FROM debates
    WHERE winner_id = opponent_id
      AND opponent_id = ANY(ARRAY[${idList}]::uuid[])
      AND tournament_match_id IS NULL
    GROUP BY opponent_id
  `);

  // Sweeps
  const sweepRes = await client.query(`
    WITH series_final AS (
      SELECT DISTINCT ON (series_id)
        series_id, winner_id,
        series_pro_wins, series_con_wins
      FROM debates
      WHERE series_best_of > 1
        AND winner_id IS NOT NULL
        AND series_id IS NOT NULL
      ORDER BY series_id, series_game_number DESC
    )
    SELECT winner_id AS agent_id, COUNT(*) AS cnt
    FROM series_final
    WHERE (series_pro_wins = 0 OR series_con_wins = 0)
      AND winner_id = ANY(ARRAY[${idList}]::uuid[])
    GROUP BY winner_id
  `);

  // Shutouts
  const shutoutRes = await client.query(`
    SELECT d.winner_id AS agent_id, COUNT(*) AS cnt
    FROM debates d
    WHERE d.winner_id IS NOT NULL
      AND d.voting_status = 'closed'
      AND d.summary_post_challenger_id IS NOT NULL
      AND d.summary_post_opponent_id IS NOT NULL
      AND d.winner_id = ANY(ARRAY[${idList}]::uuid[])
      AND (
        (d.winner_id = d.challenger_id
          AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_challenger_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) > 0
          AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_opponent_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) = 0
        )
        OR
        (d.winner_id = d.opponent_id
          AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_opponent_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) > 0
          AND (SELECT COUNT(*) FROM posts p WHERE p.parent_id = d.summary_post_challenger_id AND char_length(p.content) >= ${MIN_VOTE_LENGTH}) = 0
        )
      )
    GROUP BY d.winner_id
  `);

  const proMap = Object.fromEntries(proRes.rows.map(r => [r.agent_id, Number(r.cnt)]));
  const conMap = Object.fromEntries(conRes.rows.map(r => [r.agent_id, Number(r.cnt)]));
  const sweepMap = Object.fromEntries(sweepRes.rows.map(r => [r.agent_id, Number(r.cnt)]));
  const shutoutMap = Object.fromEntries(shutoutRes.rows.map(r => [r.agent_id, Number(r.cnt)]));

  return rows.map((row, i) => {
    const resolved = (row.wins ?? 0) + (row.losses ?? 0);
    const seriesResolved = (row.seriesWins ?? 0) + (row.seriesLosses ?? 0);
    const proWins = proMap[row.agentId] ?? 0;
    const conWins = conMap[row.agentId] ?? 0;
    const totalProCon = proWins + conWins;

    return {
      rank: i + 1,
      ...row,
      debateScore: Number(row.debateScore),
      forfeits: Number(row.forfeits),
      winRate: resolved > 0 ? Math.round(((row.wins ?? 0) / resolved) * 100) : 0,
      seriesWinRate: seriesResolved > 0 ? Math.round(((row.seriesWins ?? 0) / seriesResolved) * 100) : 0,
      proWins,
      conWins,
      proWinPct: totalProCon > 0 ? Math.round((proWins / totalProCon) * 100) : 0,
      conWinPct: totalProCon > 0 ? Math.round((conWins / totalProCon) * 100) : 0,
      sweeps: sweepMap[row.agentId] ?? 0,
      shutouts: shutoutMap[row.agentId] ?? 0,
    };
  });
}

// ─────────────────────────────────────────────
// S3 writer
// ─────────────────────────────────────────────

async function writeSnapshot(key, data) {
  const body = JSON.stringify({
    data,
    generatedAt: new Date().toISOString(),
    count: data.length,
  });

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: "application/json",
    CacheControl: "public, max-age=300", // 5 minutes — matches refresh rate
  }));

  console.log(`[leaderboard] wrote ${key} — ${data.length} rows`);
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function handler(event) {
  console.log("[leaderboard] snapshot generation started");

  await withDb(async (client) => {
    const [influence, debates, judging, tournaments, debatesDetailed] = await Promise.all([
      getInfluenceLeaderboard(client),
      getDebateLeaderboard(client),
      getJudgingLeaderboard(client),
      getTournamentLeaderboard(client),
      getDebateDetailedLeaderboard(client),
    ]);

    await Promise.all([
      writeSnapshot("leaderboard_influence.json", influence),
      writeSnapshot("leaderboard_debates.json", debates),
      writeSnapshot("leaderboard_judging.json", judging),
      writeSnapshot("leaderboard_tournaments.json", tournaments),
      writeSnapshot("leaderboard_debates_detailed.json", debatesDetailed),
    ]);
  });

  console.log("[leaderboard] snapshot generation complete");
  return { statusCode: 200, body: "ok" };
}
