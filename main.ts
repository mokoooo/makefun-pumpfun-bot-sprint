// main.ts — deterministic momentum + quota paper-trading bot for agent-fun/replay/v2
import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

// ───────────────────────── Parameters ─────────────────────────
const SOL = LAMPORTS_PER_SOL as bigint;
const START_EQUITY = 10n * SOL;
const OBS_MIN_TRADES = 15; // trades observed before momentum entry
const MIN_NET_INFLOW = (SOL * 3n) / 2n; // 1.5 SOL
const MIN_DISTINCT_BUYERS = 8;
const MAX_SINGLE_TRADE_SHARE_BPS = 3000n; // 30% of gross buy volume
const MAX_REAL_RESERVE_AT_ENTRY = 20n * SOL;
const MAX_ENTRY_AGE_BATCHES = 30; // must be young (tape time in batches)
const BASE_SIZE = SOL / 4n; // 0.25 SOL
const MAX_SIZE_BPS_OF_EQUITY = 300n; // 3%
const QUOTA_SIZE = SOL / 50n; // 0.02 SOL
const MIN_ROUND_TRIP = SOL / 100n; // 0.01 SOL
const QUOTA_TARGET = 20;
const QUOTA_MIN_TRADES = 3; // a mint must show some life for a quota trade
const QUOTA_MAX_AGE_BATCHES = 60;
const TAKE_PROFIT_BPS = 4000n; // +40%
const STOP_LOSS_BPS = 2000n; // -20%
const TIME_STOP_BATCHES = 40;
const QUOTA_TIME_STOP_BATCHES = 12;
const NEG_FLOW_EXIT = -(SOL * 1n); // net -1 SOL flow over recent window
const COMPLETION_GUARD_RESERVE = 68n * SOL; // ~80% of completion reserve
const BUY_SLIPPAGE_BPS = 300;
const SELL_SLIPPAGE_BPS = 800;
const SELL_RETRY_SLIPPAGE_BPS = 1500;
const SELL_RETRY_AFTER_BATCHES = 2;
const FEE_RESERVE = SOL / 20n; // 0.05 SOL
const HALF_SIZE_EQUITY = (SOL * 85n) / 10n; // 8.5 SOL
const QUOTA_ONLY_EQUITY = (SOL * 75n) / 10n; // 7.5 SOL
const MAX_TOTAL_EXPOSURE = (SOL * 125n) / 100n; // 1.25 SOL at cost
const PENDING_BUY_TIMEOUT_BATCHES = 5;

// ───────────────────────── Helpers ─────────────────────────
function big(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return undefined;
}

function pick(o: any, ...keys: string[]): any {
  if (o == null) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function minB(...xs: bigint[]): bigint {
  let m = xs[0];
  for (const x of xs) if (x < m) m = x;
  return m;
}

function maxB(a: bigint, b: bigint): bigint { return a > b ? a : b; }

function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

type Kind = 'create' | 'trade' | 'complete' | 'other';

function eventKind(ev: any): Kind {
  const raw = String(pick(ev, 'kind', 'type', 'event', 'event_type', 'name') ?? ev?.constructor?.name ?? '').toLowerCase();
  if (raw.includes('complete')) return 'complete';
  if (raw.includes('create')) return 'create';
  if (raw.includes('trade')) return 'trade';
  if (pick(ev, 'is_buy', 'isBuy') !== undefined) return 'trade';
  return 'other';
}

// ───────────────────────── State ─────────────────────────
interface MintStats {
  mint: string;
  createdBatch: number;
  creator?: string;
  trades: number;
  buyers: Set<string>;
  netInflow: bigint;
  grossBuy: bigint;
  maxBuyTrade: bigint;
  creatorSold: boolean;
  priceNum: bigint; // lamports
  priceDen: bigint; // tokens
  realSol: bigint;
  complete: boolean;
  recentFlow: bigint[]; // per-batch net flow, last few batches
}

interface PosMeta {
  mint: string;
  entryBatch: number;
  costIntent: bigint;
  quota: boolean;
  filled: boolean;
  sellBatch: number; // -1 = not selling
  sellAttempts: number;
}

const stats = new Map<string, MintStats>();
const meta = new Map<string, PosMeta>();
const everEntered = new Set<string>();
const roundTripped = new Set<string>();
let batchNo = 0;

function getStats(mint: string): MintStats {
  let s = stats.get(mint);
  if (!s) {
    s = {
      mint, createdBatch: batchNo, trades: 0, buyers: new Set(), netInflow: 0n, grossBuy: 0n,
      maxBuyTrade: 0n, creatorSold: false, priceNum: 0n, priceDen: 0n, realSol: 0n,
      complete: false, recentFlow: [],
    };
    stats.set(mint, s);
  }
  return s;
}

function ingest(ev: any, flowThisBatch: Map<string, bigint>): void {
  const mint = String(pick(ev, 'mint'));
  if (!mint || mint === 'undefined') return;
  const k = eventKind(ev);
  const s = getStats(mint);
  if (k === 'create') {
    s.createdBatch = batchNo;
    const c = pick(ev, 'creator', 'user', 'owner');
    if (c !== undefined) s.creator = String(c);
  } else if (k === 'complete') {
    s.complete = true;
  } else if (k === 'trade') {
    const isBuy = Boolean(pick(ev, 'is_buy', 'isBuy') ?? (pick(ev, 'side') === 'buy'));
    const sol = big(pick(ev, 'sol_amount', 'solAmount', 'quote_lamports', 'lamports')) ?? 0n;
    const tok = big(pick(ev, 'token_amount', 'tokenAmount')) ?? 0n;
    const user = String(pick(ev, 'user', 'trader', 'wallet', 'signer') ?? '');
    s.trades++;
    if (isBuy) {
      s.netInflow += sol;
      s.grossBuy += sol;
      if (sol > s.maxBuyTrade) s.maxBuyTrade = sol;
      if (user) s.buyers.add(user);
    } else {
      s.netInflow -= sol;
      if (s.creator && user === s.creator) s.creatorSold = true;
    }
    flowThisBatch.set(mint, (flowThisBatch.get(mint) ?? 0n) + (isBuy ? sol : -sol));
    const vSol = big(pick(ev, 'virtual_sol_reserves', 'virtualSolReserves'));
    const vTok = big(pick(ev, 'virtual_token_reserves', 'virtualTokenReserves'));
    if (vSol !== undefined && vTok !== undefined && vTok > 0n) {
      s.priceNum = vSol; s.priceDen = vTok;
    } else if (sol > 0n && tok > 0n) {
      s.priceNum = sol; s.priceDen = tok;
    }
    const rs = big(pick(ev, 'real_sol_reserves', 'realSolReserves'));
    if (rs !== undefined) s.realSol = rs;
  }
}

function refreshFromCurve(state: any, s: MintStats): void {
  const c = state.curves?.get?.(s.mint);
  if (!c) return;
  if (c.complete) s.complete = true;
  const vSol = big(pick(c, 'virtual_sol_reserves', 'virtualSolReserves'));
  const vTok = big(pick(c, 'virtual_token_reserves', 'virtualTokenReserves'));
  if (vSol !== undefined && vTok !== undefined && vTok > 0n) { s.priceNum = vSol; s.priceDen = vTok; }
  const rs = big(pick(c, 'real_sol_reserves', 'realSolReserves'));
  if (rs !== undefined) s.realSol = rs;
}

function markValue(s: MintStats | undefined, tokens: bigint, fallbackCost: bigint): bigint {
  if (!s || s.priceDen === 0n) return fallbackCost;
  return (tokens * s.priceNum) / s.priceDen;
}

function recentFlowSum(s: MintStats): bigint {
  let t = 0n;
  for (const f of s.recentFlow) t += f;
  return t;
}

function posOf(state: any, mint: string): { tokens: bigint; cost: bigint } | undefined {
  const p = state.positions?.get?.(mint);
  if (!p) return undefined;
  const tokens = big(p.token_amount) ?? 0n;
  if (tokens <= 0n) return undefined;
  return { tokens, cost: big(p.cost_lamports) ?? 0n };
}

function capSellTokens(state: any, s: MintStats | undefined, tokens: bigint, value: bigint): bigint {
  const bps = big(state.hello?.caps?.max_order_bps_of_real_reserve);
  if (!s || bps === undefined || bps <= 0n || s.realSol <= 0n || value <= 0n) return tokens;
  const maxVal = (s.realSol * bps) / 10000n;
  if (value <= maxVal) return tokens;
  const t = (tokens * maxVal) / value;
  return t > 0n ? t : tokens;
}

// ───────────────────────── Bot ─────────────────────────
runBot({
  onBatch(state: any, batch: any): any[] {
    batchNo++;
    const caps = state.hello?.caps ?? {};
    const maxOrders = Math.max(0, Number(caps.max_orders_per_batch ?? 1));
    const maxOpen = Math.min(5, Number(caps.max_open_positions ?? 5));
    const orders: any[] = [];
    // 1. Ingest events in tape order
    const flow = new Map<string, bigint>();
    for (const ev of batch?.events ?? []) ingest(ev, flow);
    for (const s of stats.values()) {
      s.recentFlow.push(flow.get(s.mint) ?? 0n);
      if (s.recentFlow.length > 5) s.recentFlow.shift();
    }
    // 2. Reconcile positions with our metadata (sorted for determinism)
    const metaMints = Array.from(meta.keys()).sort(cmpStr);
    for (const mint of metaMints) {
      const m = meta.get(mint)!;
      const s = stats.get(mint);
      if (s) refreshFromCurve(state, s);
      const p = posOf(state, mint);
      if (p) {
        m.filled = true;
        continue;
      }
      if (m.sellBatch >= 0 || m.filled) {
        // Position gone after selling → round trip closed
        if (m.costIntent >= MIN_ROUND_TRIP) roundTripped.add(mint);
        meta.delete(mint);
      } else if (batchNo - m.entryBatch > PENDING_BUY_TIMEOUT_BATCHES) {
        meta.delete(mint); // buy never filled
      }
    }
    // Positions we hold but have no meta for (defensive)
    const heldMints: string[] = [];
    const posKeys: string[] = [];
    if (state.positions && typeof state.positions.keys === 'function') {
      for (const k of state.positions.keys()) posKeys.push(String(k));
    }
    posKeys.sort(cmpStr);
    for (const mint of posKeys) {
      const p = posOf(state, mint);
      if (!p) continue;
      heldMints.push(mint);
      if (!meta.has(mint)) {
        meta.set(mint, { mint, entryBatch: batchNo, costIntent: p.cost, quota: false, filled: true, sellBatch: -1, sellAttempts: 0, });
        everEntered.add(mint);
      }
    }
    // 3. Equity estimate
    let free = big(state.freeCashLamports?.()) ?? 0n;
    let marked = 0n;
    let exposureCost = 0n;
    for (const mint of heldMints) {
      const p = posOf(state, mint)!;
      marked += markValue(stats.get(mint), p.tokens, p.cost);
      exposureCost += p.cost;
    }
    for (const m of meta.values()) if (!m.filled) exposureCost += m.costIntent;
    const equity = free + marked;
    // 4. Exits (priority over entries)
    const sellingNow = new Set<string>();
    for (const mint of heldMints) {
      if (orders.length >= maxOrders) break;
      const p = posOf(state, mint)!;
      const m = meta.get(mint)!;
      const s = stats.get(mint);
      const value = markValue(s, p.tokens, p.cost);
      const cost = p.cost > 0n ? p.cost : m.costIntent;
      const held = batchNo - m.entryBatch;
      let exit = false;
      if (s?.complete) exit = true;
      else if (s && s.realSol >= COMPLETION_GUARD_RESERVE) exit = true;
      else if (cost > 0n && value * 10000n >= cost * (10000n + TAKE_PROFIT_BPS)) exit = true;
      else if (cost > 0n && value * 10000n <= cost * (10000n - STOP_LOSS_BPS)) exit = true;
      else if (held >= (m.quota ? QUOTA_TIME_STOP_BATCHES : TIME_STOP_BATCHES)) exit = true;
      else if (s && s.creatorSold && !m.quota) exit = true;
      else if (s && recentFlowSum(s) <= NEG_FLOW_EXIT) exit = true;
      if (!exit) continue;
      if (m.sellBatch >= 0 && batchNo - m.sellBatch < SELL_RETRY_AFTER_BATCHES) continue;
      const retry = m.sellAttempts > 0;
      const tokens = capSellTokens(state, s, p.tokens, value);
      if (tokens <= 0n) continue;
      orders.push({
        side: 'sell', mint, token_amount: tokens,
        max_slippage_bps: retry ? SELL_RETRY_SLIPPAGE_BPS : SELL_SLIPPAGE_BPS,
      });
      m.sellBatch = batchNo;
      m.sellAttempts++;
      sellingNow.add(mint);
    }
    // 5. Entries
    if (orders.length >= maxOrders) return orders;
    const committed = Number(state.committedPositionCount?.() ?? 0);
    let openCount = Math.max(committed, meta.size);
    const fee = big(state.txFeeLamports?.()) ?? 0n;
    const inFlightQuota = Array.from(meta.values()).filter(m => m.quota).length;
    const quotaNeeded = roundTripped.size + inFlightQuota < QUOTA_TARGET;
    const momentumAllowed = equity >= QUOTA_ONLY_EQUITY;
    const candidates: { mint: string; score: bigint; momentum: boolean }[] = [];
    const statMints = Array.from(stats.keys()).sort(cmpStr);
    for (const mint of statMints) {
      const s = stats.get(mint)!;
      if (everEntered.has(mint) || roundTripped.has(mint) || meta.has(mint)) continue;
      refreshFromCurve(state, s);
      if (s.complete || s.priceDen === 0n) continue;
      const age = batchNo - s.createdBatch;
      if (s.creatorSold) continue;
      const momentum =
        momentumAllowed &&
        age <= MAX_ENTRY_AGE_BATCHES &&
        s.trades >= OBS_MIN_TRADES &&
        s.netInflow >= MIN_NET_INFLOW &&
        s.buyers.size >= MIN_DISTINCT_BUYERS &&
        s.grossBuy > 0n &&
        s.maxBuyTrade * 10000n <= s.grossBuy * MAX_SINGLE_TRADE_SHARE_BPS &&
        (s.realSol === 0n || s.realSol <= MAX_REAL_RESERVE_AT_ENTRY);
      const quotaOk =
        quotaNeeded && age <= QUOTA_MAX_AGE_BATCHES && s.trades >= QUOTA_MIN_TRADES &&
        s.netInflow > 0n && (s.realSol === 0n || s.realSol < COMPLETION_GUARD_RESERVE);
      if (!momentum && !quotaOk) continue;
      candidates.push({ mint, score: s.netInflow + BigInt(s.buyers.size) * (SOL / 10n), momentum });
    }
    candidates.sort((a, b) => {
      if (a.momentum !== b.momentum) return a.momentum ? -1 : 1;
      if (a.score !== b.score) return a.score > b.score ? -1 : 1;
      return cmpStr(a.mint, b.mint);
    });
    for (const c of candidates) {
      if (orders.length >= maxOrders) break;
      if (openCount >= maxOpen) break;
      // keep one slot for quota trades while quota unmet
      if (c.momentum && quotaNeeded && openCount >= maxOpen - 1) continue;
      let size: bigint;
      if (c.momentum) {
        size = minB(BASE_SIZE, (equity * MAX_SIZE_BPS_OF_EQUITY) / 10000n);
        if (equity < HALF_SIZE_EQUITY) size = size / 2n;
        if (exposureCost + size > MAX_TOTAL_EXPOSURE) continue;
      } else {
        size = QUOTA_SIZE;
      }
      const capBuy = big(state.maxBuyLamports?.(c.mint));
      if (capBuy !== undefined) size = minB(size, capBuy);
      const spendable = free - FEE_RESERVE - fee * 2n;
      if (spendable <= 0n) break;
      size = minB(size, spendable);
      if (size < MIN_ROUND_TRIP) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
      meta.set(c.mint, {
        mint: c.mint, entryBatch: batchNo, costIntent: size, quota: !c.momentum,
        filled: false, sellBatch: -1, sellAttempts: 0,
      });
      everEntered.add(c.mint);
      free -= size + fee;
      exposureCost += size;
      openCount++;
    }
    return orders;
  },
});
