// Flow-scalp strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2),
// entered in "Pump.fun Replay Sprint" (u-jackxyz72): 10 SOL paper capital,
// 24-hour final window, guardrails = round trips of >= 0.01 SOL on >= 20
// coins and max drawdown <= 50%.
//
// Design (from dataset analysis done for the sibling Paper Sprint entry,
// whose dev window is byte-identical to this kit's — same frozen
// 2026-11-02 24h of chain data, same 1/16 hash sample): naive entries
// almost everywhere decay after fees, but young coins that have already
// pulled in real liquidity keep drifting up for a few hundred slots. So:
// enter only coins aged 100-900 slots whose curve already holds a solid
// real SOL reserve and whose last ~60 slots show net inflow from several
// distinct buyers; take a fixed small stake; get out on a take-profit, a
// stop-loss, or a short time limit, whichever comes first. Guardrail
// probes (tiny round trips on liquid coins) keep the run above the
// 20-coin round-trip minimum if the main signal trades too rarely.
//
// PASS 1 (measured first, on this kit's official grade-local, process
// driver): the sibling entry's shipped settings, unchanged — tp 0.40,
// sl 0.10, hold 250 slots, stake 0.25 SOL, plus the 3% haircut under the
// 1%-of-reserve order cap (the harness checks the cap against reserves
// carrying this bot's own fill offsets, which drift below the SDK's
// curve view; the haircut took cap refusals from 64 to 0 there). It
// scored +0.532 SOL here, drawdown 5.6%, 133 coins round-tripped,
// guardrails met — already ahead of every baseline in this kit
// (hold-cash 0, equal-weight -0.019, pilot sniper -0.475, pilot
// reversion -3.995, pilot momentum -9.489 and over the drawdown bar).
//
// PASS 2 (the shipped settings below): one change at a time, each
// re-graded on this kit's grade-local over the full dev window:
//   stake 0.25 -> 0.40: +0.772 (same 394 fills; the 1%-of-reserve cap
//     saturates, so size only grows on mid/large-reserve coins)
//   stake 0.40 -> 0.55: +0.797 (nearly saturated; +0.025)
//   takeProfit 0.40 -> 0.50 (at stake 0.55): +0.936, drawdown 5.1%,
//     and the score no longer depends on the top coins: without its
//     3 best coins the run still nets +0.12, and at 2x fees +0.20.
//   takeProfit 0.50 -> 0.60: +0.266 — rejected; winners seldom reach
//     +60% before the stop or the clock cuts them.
//   maxHold 250 -> 350 (at tp 0.50): +0.222 — rejected; the 250-slot
//     time limit is load-bearing, drift positions decay if held.
//   flow filter 1.5 SOL / 4 buyers -> 2.5 / 5: +0.511 — rejected;
//     the marginal trades it removes are net positive at tp 0.50.
//   stake 0.40 re-checked at tp 0.50: +0.910 vs 0.55's +0.936, so the
//     shipped stake is 0.55 (drawdown 5.1% against a 50% bar; worst
//     case 5 open x 0.55 = 2.75 SOL of the 10 SOL capital).
// Probe pacing (paceSecs 10800) was left alone: the main signal round-
// trips 133 coins on this window, so probes almost never fire; on a
// quieter final window they pace across the first hours and the 20-coin
// bar has the full 24 hours to clear.
//
// Deterministic by construction: no clock, no randomness, no I/O;
// iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Age window (slots since CreateEvent) for a first entry. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Net inflow (buys minus sells, SOL) over the last flowWindow slots. */
  flowWindow: number;
  minFlowSol: number;
  /** Distinct buyers inside the flow window. */
  minBuyers: number;
  /** SOL per position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells go out at 10000. */
  buySlipBps: number;
  /** Exits, against position cost: take profit, stop loss, time limit (slots). */
  takeProfit: number;
  stopLoss: number;
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be re-entered. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Guardrail probes: pace targets and probe size. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 100,
  maxAge: 900,
  minRqSol: 12,
  maxRqSol: 85,
  flowWindow: 60,
  minFlowSol: 1.5,
  minBuyers: 4,
  stakeSol: 0.55,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 0.5,
  stopLoss: 0.1,
  maxHold: 250,
  cooldown: 300,
  maxEntries: 1,
  targetCoins: 22,
  paceSecs: 10_800,
  probeSol: 0.012,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight: mint -> true once the sell has been sent. */
  const probes = new Map<Pubkey, boolean>();
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = p.flowWindow + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net inflow and distinct buyers over the last flowWindow slots. */
  const flowStats = (t: Tape, now: number): { net: number; buyers: number } => {
    let net = 0;
    const buyers = new Set<string>();
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - p.flowWindow) break;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buyers.add(tr.user);
    }
    return { net, buyers: buyers.size };
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          tapeOf(e.mint).trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop loss, or time limit, valued at the mark.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe exits: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        if (t.created === null) continue;
        const age = now - t.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const { net, buyers } = flowStats(t, now);
        if (net < p.minFlowSol || buyers < p.minBuyers) continue;
        // The cap is read off the SDK's curve view, but the harness checks it
        // against reserves that also carry this bot's own earlier fill
        // offsets, which can sit a little lower; a 3% haircut keeps buys
        // from being refused on that drift (measured: 64 refusals at
        // stake 0.25 without it, on mints with a stale negative offset).
        const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS) * 0.97;
        const amount = Math.min(capSol, p.stakeSol, free - tx);
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        held.set(mint, { opened: now, exiting: false, filled: false });
        t.entries++;
        free -= amount + tx;
        slotsLeft--;
      }

      // Guardrail pacing: if distinct traded coins lag the pace, open a tiny
      // probe round trip on a liquid coin that is trading right now.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // The probe buy must clear the 1%-of-reserve cap with room to spare.
            if (Number(curve.real_quote_reserves) / LAMPORTS < (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
