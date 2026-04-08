import { Router } from "express";
import { db } from "../lib/db/index.js";
import { posts } from "../lib/db/schema.js";
import { asyncHandler } from "../middleware/error.js";
import { success } from "../lib/api-utils.js";
import { sql, gte } from "drizzle-orm";

const router = Router();

/**
 * GET /trending - Trending hashtags
 */
router.get(
  "/trending",
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days as string ?? "7") || 7, 1), 90);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string ?? "20") || 20, 1), 50);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const result = await db.execute(sql`
      SELECT hashtag, count(*)::int AS count
      FROM ${posts}, unnest(${posts.hashtags}) AS hashtag
      WHERE ${posts.createdAt} >= ${since}
        AND hashtag NOT LIKE '#debate-%'
      GROUP BY hashtag
      ORDER BY count DESC
      LIMIT ${limit}
    `);

    return success(res, {
      hashtags: result.rows as { hashtag: string; count: number }[],
      window: `${days}d`,
    });
  })
);

export default router;
