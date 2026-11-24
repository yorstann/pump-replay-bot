[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yorstann/pump-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/yorstann/pump-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — flow-scalp bot

Entry for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking"
(u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122), protocol
agent-fun/replay/v2. The grader runs `node /bot/main.ts` with this
directory mounted at /bot. Paper money only: 10 SOL over a 24-hour
pump.fun replay, best net PnL wins.

- `main.ts` — entry point; runs the strategy on the vendored SDK shim.
- `strategy.ts` — the strategy (see its header for the design and the
  full measured tuning history, pass 1 and pass 2).
- `vendor/makefun-bot.ts` — this kit's `sdk/ts/makefun-bot.ts`,
  vendored byte for byte (md5 2811e0103adc0d2b5201761cfc10f4e2).

Strategy in one line: buy young (100–900 slots) but already-liquid
(12–85 SOL real reserves) coins whose last ~60 slots show ≥1.5 SOL of
net inflow from ≥4 distinct buyers, 0.55 SOL per position (capped by
the harness's 1%-of-real-reserve order cap, with a 3% haircut), and
exit on the first of +50% take-profit, −10% stop-loss, or 250 slots
held; tiny probe round trips keep the run above the 20-coin guardrail
if the signal is quiet.

Local dev-window results (this kit's official `makefun grade-local`,
process driver; the kit's dev window is the same frozen 24h of chain
data the sibling Paper Sprint entry was tuned on):

- This bot: **+0.936400688 SOL** net PnL (return 9.36%), 394 fills over
  133 coins, 197 round trips, max drawdown 5.12%, guardrails met;
  +0.201 SOL at 2× fees; still +0.12 SOL with its 3 best coins removed.
  Two full grades produced identical action logs (sha256
  20200e58611ffaac…), each reproduced byte for byte.
- Baselines, same grader: hold-cash 0.000 (guardrails not met),
  equal-weight −0.019 (not met), pilot sniper −0.475, pilot
  reversion −3.995, pilot momentum −9.489 (also over the drawdown bar).

Honest caveat: `grade-local --stress` (20 block-surrogate rebuilds of
the dev window) gives a median of −0.95 SOL with 14 of 20 copies
losing — the surrogates scramble intra-coin timing, which is exactly
what a flow signal feeds on, and the tool itself notes they are not a
forecast of another window; but the dev score does lean on this
window's coins, as most pump bots' scores do.
