// Flow-scalp bot for the pump.fun bonding-curve replay
// (agent-fun/replay/v2), entered in "Pump.fun Replay Sprint"
// (u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122):
// 10 SOL of paper capital over a 24-hour window. To rank, the
// run needs round trips of at least 0.01 SOL on at least 20
// distinct coins and a max drawdown under 50%; to take the
// prize it needs a positive net PnL.
//
// Why this shape: the dev window is a frozen day of pump.fun
// chain data, and studying it trade by trade showed that most
// fresh coins bleed value once the ~1.25% curve fee and the
// transaction fees are paid — but a minority behave differently.
// A coin that is young yet already holds a real pool of SOL,
// and that is still pulling in more SOL than it loses from
// several different buyers, tends to keep rising for a few
// hundred slots. The bot buys only that pattern, in a fixed
// small size, and leaves quickly: a take-profit, a stop-loss,
// or a hard time limit, whichever fires first. If the pattern
// stays quiet for hours, tiny probe round trips on liquid
// coins keep the run above the 20-coin guardrail on their own.
//
// Tuning, measured on this kit's official grade-local over the
// full dev window (each row re-graded, one change at a time):
//   shipped settings of the sibling 6-hour entry: +0.532 SOL
//   stake 0.25 -> 0.40 SOL:                       +0.772
//   stake 0.40 -> 0.55 SOL:                       +0.797
//   take-profit 40% -> 50% at stake 0.55:         +0.936, DD 5.1%
//   take-profit 50% -> 60%:                       +0.266 (rejected)
//   time limit 250 -> 350 slots:                  +0.222 (rejected)
//   flow filter 1.5 SOL/4 buyers -> 2.5/5:        +0.511 (rejected)
// The shipped bot is the +0.936 row: 394 fills, 133 coins
// round-tripped, and it stays positive with its 3 best coins
// removed (+0.12) and at double fees (+0.20). The 250-slot
// time limit is load-bearing — drift positions decay if held.
// Buys carry a 3% haircut under the harness's 1%-of-reserve
// cap, because the harness checks the cap against reserves
// that include this bot's own fill offsets and can sit below
// the SDK's curve view; without the haircut, buys get refused
// (64 refusals measured on the sibling entry, 0 with it).
//
// Deterministic by construction: no clock, no randomness, no
// I/O. All iteration runs over insertion-ordered maps fed by
// the batch stream, so two runs of the same window produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** Every knob the strategy reads, grouped by the job it does. */
export interface Params {
  ageMinSlots: number; // youngest a coin may be at first entry
  ageMaxSlots: number; // oldest a coin may be at first entry
  reserveMinSol: number; // real SOL the curve must already hold
  reserveMaxSol: number; // ... and no more than this
  lookbackSlots: number; // window the flow test reads
  flowMinSol: number; // net inflow (buys minus sells) inside it
  buyersMin: number; // distinct buyers inside it
  positionSol: number; // SOL staked per entry
  dustSol: number; // smallest buy worth sending
  buySlipBps: number; // slippage allowed on buys; sells use 10000
  gainExit: number; // take-profit, as a fraction of cost
  lossExit: number; // stop-loss, as a fraction of cost
  holdSlots: number; // time limit on a position
  reentryWaitSlots: number; // pause after an exit before re-entry
  entriesPerCoin: number; // most entries on one coin per run
  guardrailCoins: number; // distinct round-tripped coins to pace for
  guardrailPaceSecs: number; // seconds over which the pace target grows
  probeSizeSol: number; // size of one guardrail probe
  probesMax: number; // probes allowed in flight at once
}

export const DEFAULT_PARAMS: Params = {
  ageMinSlots: 100,
  ageMaxSlots: 900,
  reserveMinSol: 12,
  reserveMaxSol: 85,
  lookbackSlots: 60,
  flowMinSol: 1.5,
  buyersMin: 4,
  positionSol: 0.55,
  dustSol: 0.01,
  buySlipBps: 1500,
  gainExit: 0.5,
  lossExit: 0.1,
  holdSlots: 250,
  reentryWaitSlots: 300,
  entriesPerCoin: 1,
  guardrailCoins: 22,
  guardrailPaceSecs: 10_800,
  probeSizeSol: 0.012,
  probesMax: 1,
};

const LAMPORTS_PER_SOL = 1e9;
const CURVE_FEE_FRACTION = 0.0125;
const SELL_SLIP_BPS = 10_000;
const CAP_HAIRCUT = 0.97;

/** One trade printed on a coin's curve, as the flow test needs it. */
interface Print {
  slot: number;
  isBuy: boolean;
  sol: number;
  trader: string;
}

/** Everything remembered about one coin across the run. */
interface CoinBook {
  bornSlot: number | null;
  prints: Print[];
  timesEntered: number;
  exitedSlot: number;
}

/** A position the bot opened and has not finished closing. */
interface OpenPosition {
  openedSlot: number;
  closeSent: boolean;
  everFilled: boolean;
}

function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/**
 * Net inflow and distinct-buyer count over the lookback window.
 * Prints are stored oldest first, so the scan runs backwards
 * and stops at the first print older than the window.
 */
function recentFlow(book: CoinBook, now: number, cfg: Params): { netSol: number; buyerCount: number } {
  let netSol = 0;
  const buyers = new Set<string>();
  for (let i = book.prints.length - 1; i >= 0; i--) {
    const print = book.prints[i]!;
    if (print.slot <= now - cfg.lookbackSlots) break;
    netSol += print.isBuy ? print.sol : -print.sol;
    if (print.isBuy) buyers.add(print.trader);
  }
  return { netSol, buyerCount: buyers.size };
}

/**
 * What a position would fetch if sold at the mark right now:
 * the curve quote for its tokens, less the curve fee and the
 * transaction fee. Compared against cost to drive the exits.
 */
function markValueSol(state: BotState, mint: Pubkey, marks: Map<Pubkey, Batch['marks'][number]>): number | null {
  const position = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (position === undefined || curve === undefined) return null;
  const mark = marks.get(mint);
  const quoteReserves = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
  const tokenReserves = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
  const tokensHeld = Number(position.token_amount);
  const gross = (tokensHeld * quoteReserves) / (tokenReserves + tokensHeld) / LAMPORTS_PER_SOL;
  return gross * (1 - CURVE_FEE_FRACTION) - lamportsToSol(state.txFeeLamports());
}

/** Whether a held position has reached any of its three exits. */
function exitDue(valueSol: number, costSol: number, openedSlot: number, now: number, cfg: Params): boolean {
  if (valueSol >= costSol * (1 + cfg.gainExit)) return true;
  if (valueSol <= costSol * (1 - cfg.lossExit)) return true;
  return now - openedSlot > cfg.holdSlots;
}

export function createStrategy(cfg: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, CoinBook>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight: mint -> true once its sell is sent. */
  const probesInFlight = new Map<Pubkey, boolean>();
  const coinsTraded = new Set<Pubkey>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  const keepSlots = cfg.lookbackSlots + 5;

  function bookOf(mint: Pubkey): CoinBook {
    let book = books.get(mint);
    if (book === undefined) {
      book = { bornSlot: null, prints: [], timesEntered: 0, exitedSlot: -1e12 };
      books.set(mint, book);
    }
    return book;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const activeMints = new Set<Pubkey>();

      // Learn from this batch: which of my orders filled, when
      // coins were born, and every trade printed since last time.
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) coinsTraded.add(fill.mint);
      }
      for (const event of batch.events) {
        if (event.block_time !== null) {
          if (windowStart === null) windowStart = event.block_time;
          if (windowEnd === null || event.block_time > windowEnd) windowEnd = event.block_time;
        }
        if (event.event === 'CreateEvent') {
          bookOf(event.mint).bornSlot = event.slot;
        } else if (event.event === 'TradeEvent') {
          bookOf(event.mint).prints.push({
            slot: event.slot,
            isBuy: event.is_buy,
            sol: lamportsToSol(event.sol_amount),
            trader: event.user,
          });
          activeMints.add(event.mint);
        }
      }
      // Forget prints too old for the flow test to ever read.
      for (const mint of activeMints) {
        const prints = books.get(mint)!.prints;
        let stale = 0;
        while (stale < prints.length && prints[stale]!.slot <= now - keepSlots) stale++;
        if (stale > 0) prints.splice(0, stale);
      }

      const marksByMint = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingCount = new Map<Pubkey, number>();
      for (const pending of state.pending.values()) {
        pendingCount.set(pending.order.mint, (pendingCount.get(pending.order.mint) ?? 0) + 1);
      }
      const hasPending = (mint: Pubkey): boolean => pendingCount.has(mint);
      const sellPending = (mint: Pubkey): boolean => {
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === 'sell') return true;
        }
        return false;
      };

      const orders: OrderInput[] = [];
      const batchCap = state.hello.caps.max_orders_per_batch;
      const txFeeSol = lamportsToSol(state.txFeeLamports());

      // --- Exits before entries: a coin leaving frees its slot.
      for (const [mint, position] of open) {
        const held = state.positions.get(mint);
        if (held === undefined) {
          // The position is gone; only bookkeeping remains.
          if (!hasPending(mint)) {
            open.delete(mint);
            const book = bookOf(mint);
            if (position.everFilled) book.exitedSlot = now;
            else book.timesEntered--;
          }
          continue;
        }
        position.everFilled = true;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const value = markValueSol(state, mint, marksByMint);
        if (value === null) continue;
        const costSol = lamportsToSol(held.cost_lamports);
        if (!position.closeSent && !exitDue(value, costSol, position.openedSlot, now, cfg)) continue;
        position.closeSent = true;
        if (sellPending(mint)) continue;
        if (orders.length >= batchCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: SELL_SLIP_BPS });
      }

      // --- Probe exits: a probe sells as soon as its buy lands.
      for (const [mint, sellSent] of probesInFlight) {
        const held = state.positions.get(mint);
        if (held === undefined) {
          if (!hasPending(mint)) probesInFlight.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || hasPending(mint)) continue;
        if (orders.length >= batchCap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        if (!sellSent) probesInFlight.set(mint, true);
      }

      // --- Entries: the flow-scalp pattern, one stake per coin.
      let cashSol = lamportsToSol(state.freeCashLamports());
      let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of activeMints) {
        if (orders.length >= batchCap || freeSlots <= 0) break;
        if (open.has(mint) || probesInFlight.has(mint) || hasPending(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const book = books.get(mint)!;
        if (book.bornSlot === null) continue;
        const ageSlots = now - book.bornSlot;
        if (ageSlots < cfg.ageMinSlots || ageSlots > cfg.ageMaxSlots) continue;
        if (book.timesEntered >= cfg.entriesPerCoin) continue;
        if (now - book.exitedSlot < cfg.reentryWaitSlots) continue;
        const reserveSol = lamportsToSol(curve.real_quote_reserves);
        if (reserveSol < cfg.reserveMinSol || reserveSol > cfg.reserveMaxSol) continue;
        const flow = recentFlow(book, now, cfg);
        if (flow.netSol < cfg.flowMinSol || flow.buyerCount < cfg.buyersMin) continue;
        // Size under the reserve cap with the haircut described
        // in the header: the harness's cap view can sit below
        // the SDK's, and an oversized buy is refused outright.
        const capSol = lamportsToSol(BigInt(Math.floor(Number(state.maxBuyLamports(mint))))) * CAP_HAIRCUT;
        const stakeSol = Math.min(capSol, cfg.positionSol, cashSol - txFeeSol);
        if (stakeSol < cfg.dustSol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(stakeSol * LAMPORTS_PER_SOL)),
          max_slippage_bps: cfg.buySlipBps,
        });
        open.set(mint, { openedSlot: now, closeSent: false, everFilled: false });
        book.timesEntered++;
        cashSol -= stakeSol + txFeeSol;
        freeSlots--;
      }

      // --- Guardrail pacing: if distinct traded coins lag the
      // pace the window allows, open one tiny probe round trip
      // on a liquid coin that is trading in this very batch.
      const paceApplies =
        probesInFlight.size < cfg.probesMax && freeSlots > 0 && windowStart !== null && windowEnd !== null;
      if (paceApplies) {
        const elapsedFraction = Math.min(1, (windowEnd! - windowStart!) / cfg.guardrailPaceSecs);
        const coinsDue = Math.ceil(cfg.guardrailCoins * elapsedFraction);
        if (coinsTraded.size < coinsDue) {
          for (const mint of activeMints) {
            if (orders.length >= batchCap || probesInFlight.size >= cfg.probesMax) break;
            if (open.has(mint) || probesInFlight.has(mint) || hasPending(mint)) continue;
            if (state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // The probe must clear the 1%-of-reserve cap with
            // room to spare, or its buy is refused and wasted.
            const reserveFloor =
              ((cfg.probeSizeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve) * 1.5;
            if (lamportsToSol(curve.real_quote_reserves) < reserveFloor) continue;
            if (cashSol < cfg.probeSizeSol + 2 * txFeeSol) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(cfg.probeSizeSol * LAMPORTS_PER_SOL)),
              max_slippage_bps: cfg.buySlipBps,
            });
            probesInFlight.set(mint, false);
            cashSol -= cfg.probeSizeSol + txFeeSol;
          }
        }
      }

      return orders;
    },
  };
}
