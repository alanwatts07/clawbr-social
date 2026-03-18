import { db } from "./db/index.js";
import { tokenBalances, tokenTransactions } from "./db/schema.js";
import { eq, sql, desc } from "drizzle-orm";

// ─── Reward Constants ($CLAWBR amounts) ─────────────────────
export const TOKEN_REWARDS = {
  // Debate rewards
  DEBATE_WIN_BO1: 250_000,
  SERIES_WIN_BO3: 500_000,
  SERIES_WIN_BO5: 750_000,
  SERIES_WIN_BO7: 1_000_000,
  QUALIFYING_VOTE: 100_000,

  // Tournament rewards
  TOURNAMENT_MATCH_WIN: 250_000,
  TOURNAMENT_SEMIFINALIST: 500_000,
  TOURNAMENT_RUNNER_UP: 1_000_000,
  TOURNAMENT_CHAMPION_8P: 1_500_000,
  TOURNAMENT_CHAMPION_16P: 2_000_000,
} as const;

// Reason strings used in the transaction log
export type TokenReason =
  | "debate_win"
  | "series_win"
  | "qualifying_vote"
  | "tournament_match_win"
  | "tournament_semifinalist"
  | "tournament_runner_up"
  | "tournament_champion"
  | "tip_sent"
  | "tip_received"
  | "withdraw"
  | "wager_escrow"
  | "wager_payout"
  | "wager_refund";

// Map reason → which stat counter to increment on credit
const STAT_COUNTER_MAP: Partial<Record<TokenReason, keyof typeof tokenBalances.$inferSelect>> = {
  debate_win: "totalDebateWinnings",
  series_win: "totalDebateWinnings",
  qualifying_vote: "totalVoteRewards",
  tournament_match_win: "totalTournamentWinnings",
  tournament_semifinalist: "totalTournamentWinnings",
  tournament_runner_up: "totalTournamentWinnings",
  tournament_champion: "totalTournamentWinnings",
  tip_received: "totalTipsReceived",
  wager_payout: "totalDebateWinnings",
};

/**
 * Credit tokens to an agent. Upserts balance row, increments appropriate stat counter, appends tx.
 */
export async function creditTokens({
  agentId,
  amount,
  reason,
  counterpartyId,
  referenceId,
}: {
  agentId: string;
  amount: number;
  reason: TokenReason;
  counterpartyId?: string;
  referenceId?: string;
}): Promise<void> {
  const amountStr = String(amount);
  const statColumn = STAT_COUNTER_MAP[reason];

  // Upsert balance row
  await db
    .insert(tokenBalances)
    .values({
      agentId,
      balance: amountStr,
      totalEarned: amountStr,
      ...(statColumn ? { [statColumn]: amountStr } : {}),
    })
    .onConflictDoUpdate({
      target: tokenBalances.agentId,
      set: {
        balance: sql`${tokenBalances.balance}::numeric + ${amountStr}::numeric`,
        totalEarned: sql`${tokenBalances.totalEarned}::numeric + ${amountStr}::numeric`,
        ...(statColumn
          ? {
              [statColumn]: sql`COALESCE(${tokenBalances[statColumn as keyof typeof tokenBalances]}::numeric, 0) + ${amountStr}::numeric`,
            }
          : {}),
        updatedAt: new Date(),
      },
    });

  // Append transaction log
  await db.insert(tokenTransactions).values({
    agentId,
    type: "earn",
    amount: amountStr,
    reason,
    counterpartyId: counterpartyId ?? null,
    referenceId: referenceId ?? null,
  });
}

/**
 * Debit tokens from an agent. Checks balance, deducts, increments spend counter, appends tx.
 * Returns true if successful, false if insufficient balance.
 */
export async function debitTokens({
  agentId,
  amount,
  reason,
  counterpartyId,
  referenceId,
}: {
  agentId: string;
  amount: number;
  reason: TokenReason;
  counterpartyId?: string;
  referenceId?: string;
}): Promise<boolean> {
  const amountStr = String(amount);

  // Atomic check-and-debit: only succeeds if balance >= amount
  const result = await db
    .update(tokenBalances)
    .set({
      balance: sql`${tokenBalances.balance}::numeric - ${amountStr}::numeric`,
      totalSpent: sql`${tokenBalances.totalSpent}::numeric + ${amountStr}::numeric`,
      ...(reason === "tip_sent"
        ? {
            totalTipsSent: sql`${tokenBalances.totalTipsSent}::numeric + ${amountStr}::numeric`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      sql`${tokenBalances.agentId} = ${agentId} AND ${tokenBalances.balance}::numeric >= ${amountStr}::numeric`
    )
    .returning({ agentId: tokenBalances.agentId });

  if (result.length === 0) return false;

  // Append transaction log
  await db.insert(tokenTransactions).values({
    agentId,
    type: reason === "tip_sent" ? "tip_sent" : reason === "wager_escrow" ? "wager_escrow" : "withdraw",
    amount: amountStr,
    reason,
    counterpartyId: counterpartyId ?? null,
    referenceId: referenceId ?? null,
  });

  return true;
}

/**
 * Get an agent's current balance.
 */
export async function getBalance(agentId: string): Promise<number> {
  const [row] = await db
    .select({ balance: tokenBalances.balance })
    .from(tokenBalances)
    .where(eq(tokenBalances.agentId, agentId))
    .limit(1);
  return row ? Number(row.balance) : 0;
}

/**
 * Get full token stats for an agent.
 *
 * balance        — from token_balances (authoritative, atomic after debits)
 * all breakdowns — computed from token_transactions ledger (single source of truth,
 *                  never drifts from the actual transaction history)
 */
export async function getTokenStats(agentId: string) {
  // balance is still the authoritative current balance (atomic debit/credit)
  const [balRow] = await db
    .select({ balance: tokenBalances.balance })
    .from(tokenBalances)
    .where(eq(tokenBalances.agentId, agentId))
    .limit(1);

  // All breakdowns computed from the append-only ledger
  const txRows = await db
    .select({
      reason: tokenTransactions.reason,
      total: sql<string>`SUM(${tokenTransactions.amount}::numeric)`,
    })
    .from(tokenTransactions)
    .where(eq(tokenTransactions.agentId, agentId))
    .groupBy(tokenTransactions.reason);

  const byReason: Record<string, number> = {};
  for (const row of txRows) {
    byReason[row.reason] = Number(row.total);
  }

  const DEBATE_WIN_REASONS = ["debate_win", "series_win", "wager_payout"];
  const TOURNAMENT_REASONS = ["tournament_match_win", "tournament_semifinalist", "tournament_runner_up", "tournament_champion"];
  const DEBIT_REASONS = ["withdraw", "wager_escrow"];

  const sum = (reasons: string[]) => reasons.reduce((acc, r) => acc + (byReason[r] ?? 0), 0);

  return {
    balance: balRow ? Number(balRow.balance) : 0,
    totalEarned: sum(Object.keys(byReason).filter(r => !DEBIT_REASONS.includes(r) && r !== "tip_sent")),
    totalSpent: sum([...DEBIT_REASONS, "tip_sent"]),
    totalTipsReceived: byReason["tip_received"] ?? 0,
    totalTipsSent: byReason["tip_sent"] ?? 0,
    totalDebateWinnings: sum(DEBATE_WIN_REASONS),
    totalTournamentWinnings: sum(TOURNAMENT_REASONS),
    totalVoteRewards: byReason["qualifying_vote"] ?? 0,
    totalWagerRefunds: byReason["wager_refund"] ?? 0,
  };
}
