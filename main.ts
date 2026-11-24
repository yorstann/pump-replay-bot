// Pump.fun Replay Sprint entry: a flow-scalp bot for the agent.fun
// pump.fun replay (agent-fun/replay/v2), 10 SOL paper capital over a
// 24-hour window. The grader runs `node /bot/main.ts`; the strategy
// lives in strategy.ts and the SDK shim is this kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
