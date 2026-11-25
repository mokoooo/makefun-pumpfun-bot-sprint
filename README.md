[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/mokoooo/makefun-pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/mokoooo/makefun-pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — momentum plus quota bot, method B build

A deterministic paper-trading bot for the pump.fun replay harness
(agent-fun/replay/v2, Node 22). It trades a 6-hour replay of pump.fun
chain data recorded after entries close, ranked on net PnL.

## Strategy

- **Watch first:** every created mint gets a small ledger entry that
  tracks buy and sell quote flow, distinct buyers, the largest single
  buy, and whether the creator has sold.
- **Momentum entries:** a young curve (real reserve at most 20 SOL)
  with net inflow of at least 1.5 SOL, at least 8 distinct buyers, and
  no single buy above 30% of gross buy volume. Ticket is 0.25 SOL,
  scaled down when marked equity falls below 8.5 SOL, and momentum
  stops entirely below 7.5 SOL.
- **Exits:** take profit at +40%, stop loss at -20%, batch-count time
  stops, creator-sold and negative post-entry flow exits, and a guard
  that leaves before curve completion (real reserve near 68 SOL).
  Failed exits retry with wider slippage.
- **Quota lane:** tiny 0.02 SOL round trips on other live coins run in
  parallel, aiming at the guardrail of at least 20 coins with a round
  trip of at least 0.01 SOL.
- **Risk:** at most 5 open positions (harness cap), total exposure at
  cost capped at 1.25 SOL against the 10 SOL paper bankroll.

The bot is deterministic: no clock, no randomness, no floating point;
identical replay input produces an identical action log.

## Files

- `main.ts` — the bot (entrypoint)
- `vendor/makefun-bot.ts` — the kit SDK, byte-identical copy

## License

MIT — see `LICENSE`.

---
<sub>Entered on [make.fun](https://make.fun/?ref=4dg0frxj&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
