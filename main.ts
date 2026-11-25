// Pump.fun replay bot — momentum entries with a parallel quota lane.
//
// Idea in one paragraph: most new curves go nowhere, so this bot spends
// most batches just watching. It keeps a small ledger for every mint it
// sees, scores the early flow, and only commits real size when several
// independent buyers have already pushed meaningful SOL through a young
// curve without one wallet dominating. In parallel it runs tiny round
// trips on other coins, because the ranking guardrail asks for round
// trips of at least 0.01 SOL on twenty distinct coins and a bot that
// waits for perfect momentum may never reach that count. Exits are
// rule based and checked before any new entry on every batch.
//
// Determinism: no clock, no randomness, no floating point. All money
// maths is bigint, counters are batch counts, and every map is walked
// in insertion order, which follows the order of the replay itself.

import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tuning, all in lamports or batch counts --------------------------

const MOMENTUM_STAKE = LAMPORTS_PER_SOL / 4n; // 0.25 SOL before scaling
const QUOTA_STAKE = LAMPORTS_PER_SOL / 50n; // 0.02 SOL, above the 0.01 bar
const MIN_NET_INFLOW = (LAMPORTS_PER_SOL * 3n) / 2n; // 1.5 SOL
const MAX_YOUNG_RESERVE = LAMPORTS_PER_SOL * 20n;
const EXPOSURE_CEILING = (LAMPORTS_PER_SOL * 5n) / 4n; // 1.25 SOL at cost
const MIN_DISTINCT_BUYERS = 8;
const QUOTA_TARGET = 20;
const MOMENTUM_HOLD_BATCHES = 140;
const QUOTA_HOLD_BATCHES = 30;
const BASE_SLIPPAGE_BPS = 800;
const COMPLETION_RESERVE = LAMPORTS_PER_SOL * 68n;
const EQUITY_SOFT_FLOOR = (LAMPORTS_PER_SOL * 17n) / 2n; // 8.5 SOL
const EQUITY_HARD_FLOOR = (LAMPORTS_PER_SOL * 15n) / 2n; // 7.5 SOL

// Slippage widens each time an exit has to be retried, so a position
// that slipped once is not retried forever on the same tight terms.
function exitSlippage(attempts: number): number {
  if (attempts <= 0) return BASE_SLIPPAGE_BPS;
  if (attempts === 1) return 2_500;
  if (attempts === 2) return 5_000;
  return 10_000;
}

// Rough mark-to-market equity: cash plus every holding at spot. Used
// only as a risk throttle, never as a reported figure.
function markedEquity(
  state: {
    cash: bigint;
    positions: Map<string, { token_amount: bigint; cost_lamports: bigint }>;
    curves: Map<string, { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }>;
  },
): bigint {
  let total = state.cash;
  for (const [mint, pos] of state.positions) {
    const v = spotValue(state, mint, pos.token_amount);
    total += v === null ? pos.cost_lamports : v;
  }
  return total;
}

// ---- per-mint observation ledger --------------------------------------

interface Watch {
  creator: string;
  bornAtBatch: number;
  buyQuote: bigint;
  sellQuote: bigint;
  biggestBuy: bigint;
  buyers: Set<string>;
  tradesSeen: number;
  creatorHasSold: boolean;
  flowAfterEntry: bigint;
}

interface OpenNote {
  lane: 'momentum' | 'quota';
  openedAtBatch: number;
  sellAttempts: number;
  exitWanted: boolean;
}

const watched = new Map<string, Watch>();
const notes = new Map<string, OpenNote>();
const quotaAttempted = new Set<string>();
const roundTripsDone = new Set<string>();
const momentumAttempted = new Set<string>();

let batchCounter = 0;

function noteFor(mint: string, lane: 'momentum' | 'quota'): OpenNote {
  let n = notes.get(mint);
  if (n === undefined) {
    n = { lane, openedAtBatch: batchCounter, sellAttempts: 0, exitWanted: false };
    notes.set(mint, n);
  }
  return n;
}

// Spot value of a holding from the virtual reserves of its curve.
// Returns null when the curve is unknown or has no usable reserves.
function spotValue(
  state: { curves: Map<string, { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }> },
  mint: string,
  tokenAmount: bigint,
): bigint | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) return null;
  return (tokenAmount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

function hasPending(state: { pending: Map<string, { order: { mint: string; side: string } }> }, mint: string, side: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function costExposure(state: { positions: Map<string, { cost_lamports: bigint }> }): bigint {
  let total = 0n;
  for (const pos of state.positions.values()) total += pos.cost_lamports;
  return total;
}

await runBot({
  onBatch(state, batch) {
    batchCounter += 1;
    const caps = state.hello.caps;
    const fee = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // Learn from fills first: a filled sell closes a round trip.
    for (const fill of batch.fills) {
      if (fill.side === 'sell' && fill.status === 'filled') {
        roundTripsDone.add(fill.mint);
        notes.delete(fill.mint);
      }
      if (fill.side === 'buy' && fill.status === 'filled') {
        // Lane was recorded when the order was sent; keep the note.
        if (!notes.has(fill.mint)) noteFor(fill.mint, 'quota');
      }
    }

    // Fold this batch's events into the watch ledger.
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        if (!watched.has(ev.mint)) {
          watched.set(ev.mint, {
            creator: ev.creator,
            bornAtBatch: batchCounter,
            buyQuote: 0n,
            sellQuote: 0n,
            biggestBuy: 0n,
            buyers: new Set<string>(),
            tradesSeen: 0,
            creatorHasSold: false,
            flowAfterEntry: 0n,
          });
        }
        continue;
      }
      if (ev.event !== 'TradeEvent') continue;
      let w = watched.get(ev.mint);
      if (w === undefined) {
        w = {
          creator: ev.creator,
          bornAtBatch: batchCounter,
          buyQuote: 0n,
          sellQuote: 0n,
          biggestBuy: 0n,
          buyers: new Set<string>(),
          tradesSeen: 0,
          creatorHasSold: false,
          flowAfterEntry: 0n,
        };
        watched.set(ev.mint, w);
      }
      const amount = BigInt(ev.quote_amount ?? ev.sol_amount);
      w.tradesSeen += 1;
      if (ev.is_buy) {
        w.buyQuote += amount;
        w.buyers.add(ev.user);
        if (amount > w.biggestBuy) w.biggestBuy = amount;
      } else {
        w.sellQuote += amount;
        if (ev.user === w.creator) w.creatorHasSold = true;
      }
      if (notes.has(ev.mint)) {
        w.flowAfterEntry += ev.is_buy ? amount : -amount;
      }
    }

    // ---- exits before entries --------------------------------------
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (hasPending(state, mint, 'sell')) continue;
      const note = notes.get(mint) ?? noteFor(mint, 'quota');
      const heldFor = batchCounter - note.openedAtBatch;
      const value = spotValue(state, mint, pos.token_amount);
      let wantOut = note.exitWanted;
      if (value !== null && pos.cost_lamports > 0n) {
        if (value * 10n >= pos.cost_lamports * 14n) wantOut = true; // +40%
        if (value * 10n <= pos.cost_lamports * 8n) wantOut = true; // -20%
      }
      const w = watched.get(mint);
      if (w !== undefined && w.creatorHasSold) wantOut = true;
      if (w !== undefined && w.flowAfterEntry < 0n && heldFor > 5) wantOut = true;
      // Completion guard: a curve approaching migration can gap, so
      // leave while there is still a reserve to sell into.
      const curveNow = state.curves.get(mint);
      if (curveNow !== undefined && curveNow.real_quote_reserves >= COMPLETION_RESERVE) wantOut = true;
      if (curveNow !== undefined && curveNow.complete) wantOut = true;
      const limit = note.lane === 'quota' ? QUOTA_HOLD_BATCHES : MOMENTUM_HOLD_BATCHES;
      if (heldFor >= limit) wantOut = true;
      if (!wantOut) continue;
      note.exitWanted = true;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: exitSlippage(note.sellAttempts),
      });
      note.sellAttempts += 1;
    }

    // ---- shared budget view ----------------------------------------
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    let exposure = costExposure(state);
    const reserveRoom = (mint: string, want: bigint): bigint => {
      const cap = state.maxBuyLamports(mint);
      return cap < want ? cap : want;
    };
    const canAfford = (amount: bigint): boolean =>
      orders.length < caps.max_orders_per_batch && openSlots > 0 && free >= amount + fee && amount > 0n;

    // ---- quota lane --------------------------------------------------
    // Fill the twenty-coin bar early while it is cheap to do so. One
    // slot is effectively shared: quota only takes a slot when a round
    // trip is still missing and the coin shows at least a little life.
    if (roundTripsDone.size + countActiveQuota() < QUOTA_TARGET) {
      for (const [mint, w] of watched) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (quotaAttempted.has(mint) || momentumAttempted.has(mint)) continue;
        if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (w.tradesSeen < 3) continue;
        if (w.creatorHasSold) continue;
        const amount = reserveRoom(mint, QUOTA_STAKE);
        if (amount < LAMPORTS_PER_SOL / 100n) continue;
        if (!canAfford(amount)) break;
        quotaAttempted.add(mint);
        noteFor(mint, 'quota');
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BASE_SLIPPAGE_BPS });
        free -= amount + fee;
        openSlots -= 1;
        exposure += amount;
        break; // at most one new quota coin per batch keeps flow readable
      }
    }

    // ---- momentum lane ----------------------------------------------
    // Equity throttle: a drawdown shrinks momentum first and stops it
    // entirely before it can threaten the drawdown guardrail. The
    // quota lane above is unaffected, since its trips are tiny.
    const equityNow = markedEquity(state);
    if (equityNow < EQUITY_HARD_FLOOR) return orders;
    const sizeScale = equityNow < EQUITY_SOFT_FLOOR ? 2n : 1n;
    for (const [mint, w] of watched) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (momentumAttempted.has(mint) || quotaAttempted.has(mint)) continue;
      if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves > MAX_YOUNG_RESERVE) continue;
      if (w.creatorHasSold) continue;
      const net = w.buyQuote - w.sellQuote;
      if (net < MIN_NET_INFLOW) continue;
      if (w.buyers.size < MIN_DISTINCT_BUYERS) continue;
      if (w.buyQuote > 0n && w.biggestBuy * 10n > w.buyQuote * 3n) continue;
      if (exposure >= EXPOSURE_CEILING) break;
      let stake = MOMENTUM_STAKE / sizeScale;
      // The 3%-of-bankroll guide: never let one momentum ticket exceed
      // three percent of the starting capital either.
      const bankrollCap = (LAMPORTS_PER_SOL * 10n * 3n) / 100n;
      if (stake > bankrollCap) stake = bankrollCap;
      const room = EXPOSURE_CEILING - exposure;
      if (stake > room) stake = room;
      const amount = reserveRoom(mint, stake);
      if (amount < LAMPORTS_PER_SOL / 100n) continue;
      if (!canAfford(amount)) continue;
      momentumAttempted.add(mint);
      noteFor(mint, 'momentum');
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BASE_SLIPPAGE_BPS });
      free -= amount + fee;
      openSlots -= 1;
      exposure += amount;
    }

    return orders;
  },
});

function countActiveQuota(): number {
  let n = 0;
  for (const note of notes.values()) if (note.lane === 'quota') n += 1;
  return n;
}
