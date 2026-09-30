#!/usr/bin/env node
// Lists pump.fun coins whose RSI is between MIN_RSI and MAX_RSI (default 55-70).
//
// Data source: GeckoTerminal (free, no API key).
//   1. Candidate coins = the most active pools on pump.fun's bonding curve (dex "pump-fun") and on PumpSwap
//      (dex "pumpswap", where pump.fun coins trade after they graduate).
//   2. For each candidate, fetch price candles and compute RSI (Wilder's smoothing, like TradingView).
//
// The free API allows only a few calls per minute, so every coin costs ~6 seconds. Keep MAX_COINS modest.
//
// Usage:
//   node rsi-pumpfun.js                    # one-time list
//   node rsi-pumpfun.js --watch            # repeat forever
//   node rsi-pumpfun.js --min-rsi 50 --max-rsi 65 --timeframe 15m --max-coins 30

// ---- Settings ---------------------------------------------------------------
const RSI_PERIOD = 14;
const MIN_RSI = 55; // default, override with --min-rsi
const MAX_RSI = 70; // default, override with --max-rsi
const TIMEFRAME = '5m'; // candle size: 1m, 5m, 15m, 1h, 4h, 12h, 1d (override with --timeframe)
const CANDLES = 100; // candles fetched per coin - more history = more accurate RSI (max 1000)
const MAX_COINS = 20; // how many candidate coins to compute RSI for (each is one API call)
const DEXES = ['pump-fun', 'pumpswap']; // pump.fun bonding curve + graduated coins
const POOL_PAGES = 1; // 20 pools per page per dex
const MIN_LIQUIDITY = 5_000; // USD - skip pools with less liquidity than this (0 to disable)
const MIN_VOLUME_1H = 1_000; // USD - skip coins that barely traded in the last hour
const REQUEST_DELAY_MS = 6_000; // gap between API calls - free tier allows roughly 10 calls/minute
// -----------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const minRsi = Number(args['min-rsi'] ?? MIN_RSI);
const maxRsi = Number(args['max-rsi'] ?? MAX_RSI);
const timeframe = String(args.timeframe ?? TIMEFRAME);
const maxCoins = Number(args['max-coins'] ?? MAX_COINS);
const WATCH = Boolean(args.watch);

const API = 'https://api.geckoterminal.com/api/v2/networks/solana';

// GeckoTerminal OHLCV: /ohlcv/{minute|hour|day}?aggregate=N
const TIMEFRAMES = {
  '1m': ['minute', 1],
  '5m': ['minute', 5],
  '15m': ['minute', 15],
  '1h': ['hour', 1],
  '4h': ['hour', 4],
  '12h': ['hour', 12],
  '1d': ['day', 1],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call goes through here so calls are spaced out for the rate limit.
let lastCall = 0;
async function fetchJson(url, attempt = 1) {
  const wait = lastCall + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 429 && attempt <= 3) {
    console.warn('Rate limited, waiting 60s before retrying...');
    await sleep(60_000); // the limit is per minute, so wait for the window to reset
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}: ${await res.text()}`);
  return res.json();
}

function toCoin(pool, tokens, dex) {
  const a = pool.attributes;
  const tokenRef = pool.relationships.base_token.data.id;
  const token = tokens.get(tokenRef)?.attributes ?? {};
  return {
    id: token.address ?? tokenRef.replace(/^solana_/, ''),
    symbol: token.symbol ?? a.name.split(' / ')[0],
    dex,
    pool: a.address,
    // market_cap_usd is often null for new tokens; FDV is the same thing on pump.fun (full supply circulates)
    market_cap: Number(a.market_cap_usd ?? a.fdv_usd ?? 0),
    liquidity: Number(a.reserve_in_usd ?? 0),
    volume_5m: Number(a.volume_usd?.m5 ?? 0),
    volume_1h: Number(a.volume_usd?.h1 ?? 0),
    volume_24h: Number(a.volume_usd?.h24 ?? 0),
    change_1h: Number(a.price_change_percentage?.h1 ?? 0),
  };
}

async function fetchCandidates() {
  const byId = new Map();
  for (const dex of DEXES) {
    for (let p = 1; p <= POOL_PAGES; p++) {
      const json = await fetchJson(`${API}/dexes/${dex}/pools?page=${p}&include=base_token`);
      const tokens = new Map((json.included ?? []).map((t) => [t.id, t]));
      for (const pool of json.data ?? []) {
        const coin = toCoin(pool, tokens, dex);
        // A coin can trade in several pools - keep the most liquid one
        const existing = byId.get(coin.id);
        if (!existing || coin.liquidity > existing.liquidity) byId.set(coin.id, coin);
      }
    }
  }
  return [...byId.values()]
    // Coins launched on pump.fun have mint addresses ending in "pump" - this drops copycats and other
    // tokens (USDC, fake tickers) that merely have a PumpSwap pool
    .filter((c) => c.id.endsWith('pump') && c.liquidity >= MIN_LIQUIDITY && c.volume_1h >= MIN_VOLUME_1H)
    .sort((a, b) => b.volume_1h - a.volume_1h)
    .slice(0, maxCoins);
}

// Closing prices, oldest first
async function fetchCloses(pool) {
  const [unit, aggregate] = TIMEFRAMES[timeframe];
  const json = await fetchJson(
    `${API}/pools/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=${CANDLES}&currency=usd`
  );
  // Each candle is [timestamp, open, high, low, close, volume], newest first
  return (json.data?.attributes?.ohlcv_list ?? []).map((c) => c[4]).reverse();
}

// RSI with Wilder's smoothing. Returns null if there are not enough candles.
function rsi(closes, period = RSI_PERIOD) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

const fmtUsd = (n) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n).toLocaleString()}`;
const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
const gmgnUrl = (id) => `https://gmgn.ai/sol/token/${id}`;

async function run() {
  const candidates = await fetchCandidates();
  console.log(`Checking RSI(${RSI_PERIOD}) on ${timeframe} candles for ${candidates.length} pump.fun coins...`);

  const hits = [];
  for (const [i, c] of candidates.entries()) {
    try {
      c.rsi = rsi(await fetchCloses(c.pool));
    } catch (err) {
      console.error(`  ${c.symbol}: ${err.message}`);
      continue;
    }
    const shown = c.rsi == null ? 'not enough candles' : c.rsi.toFixed(1);
    console.log(`  [${i + 1}/${candidates.length}] ${c.symbol.padEnd(12)} RSI ${shown}`);
    if (c.rsi != null && c.rsi >= minRsi && c.rsi <= maxRsi) hits.push(c);
  }

  hits.sort((a, b) => b.rsi - a.rsi);
  console.log(`\n[${new Date().toLocaleTimeString()}] ${hits.length} pump.fun coins with RSI ${minRsi}-${maxRsi}:`);
  if (!hits.length) return;
  console.table(
    hits.map((c) => ({
      address: c.id,
      symbol: c.symbol,
      dex: c.dex,
      rsi: c.rsi.toFixed(1),
      'h1 %': fmtPct(c.change_1h),
      'vol 5m': fmtUsd(c.volume_5m),
      'vol 1h': fmtUsd(c.volume_1h),
      'vol 24h': fmtUsd(c.volume_24h),
      'market cap': fmtUsd(c.market_cap),
    }))
  );
  // Plain URLs so the terminal makes them clickable
  hits.forEach((c, i) => console.log(`  ${String(i).padStart(2)} ${c.symbol.padEnd(12)} ${gmgnUrl(c.id)}`));
}

async function main() {
  if (!TIMEFRAMES[timeframe]) {
    console.error(`Unknown --timeframe ${timeframe}. Use one of: ${Object.keys(TIMEFRAMES).join(', ')}`);
    process.exit(1);
  }
  do {
    try {
      await run();
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Error: ${err.message}`);
    }
  } while (WATCH);
}

main();
