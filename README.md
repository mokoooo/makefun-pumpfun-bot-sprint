[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/mokoooo/makefun-pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/mokoooo/makefun-pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — momentum + quota bot

A deterministic paper-trading bot for the pump.fun replay harness
(agent-fun/replay/v2, Node 22). It trades a 6-hour replay of pump.fun
chain data recorded after entries close, ranked on net PnL.

## Strategy

- **Momentum entries:** only young coins that already show real
  momentum — at least 15 observed trades, net inflow of at least
  1.5 SOL, at least 8 distinct buyers, and no single trade above 30%
  of gross buy volume.
- **Exits:** take profit at +40%, stop loss at -20%, time stops,
  creator-sold and negative-flow exits, and a completion-reserve guard.
- **Quota trades:** small 0.02 SOL round trips run in parallel so the
  bot reaches the guardrail of at least 20 coins with a round trip of
  at least 0.01 SOL.
- **Risk:** total exposure at cost is capped at 1.25 SOL against the
  10 SOL paper bankroll, position size shrinks as equity falls, and
  below 7.5 SOL equity only quota trades continue.

The bot is deterministic: identical replay input produces an identical
action log.

## Files

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bot.ts` — the kit SDK, byte-identical copy

## License

MIT — see `LICENSE`.

---
<sub>Entered on [make.fun](https://make.fun/?ref=4dg0frxj&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
