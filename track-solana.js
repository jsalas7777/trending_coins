#!/usr/bin/env node
// Tracks small Solana coins that are actively trading right now and reports those whose
// market cap moved >= THRESHOLD % (up or down).
//
// Data source: GeckoTerminal (free, no API key) - trending (last 5 min) + newly created Solana pools.
// Each coin is identified by its Solana mint address (coin id).
//
// "Active" = enough volume and trades in the last 5 minutes, and that 5-minute volume is higher than
// the coin's pace over the 10 minutes before it (volume is picking up, not fading). GeckoTerminal's
// shortest window is 5 minutes - there is no 1-minute volume.
//
// Two signals are reported:
//   1. Window move - GeckoTerminal's % change over CHANGE_WINDOW (shown on startup and whenever it crosses the threshold)
//   2. Live move   - market cap change since the last baseline this script recorded (baseline resets after each alert)
//
// Usage:
//   node track-solana.js                  # watch continuously
//   node track-solana.js --once           # one-time snapshot
//   node track-solana.js --threshold 10 --interval 120

const fs = require('node:fs');
const path = require('node:path');

// ---- Settings ---------------------------------------------------------------
const MAX_MARKET_CAP = 500_000; // USD - ignore coins above this market cap
const MIN_MARKET_CAP = 10_000; // USD - ignore dust coins below this market cap (set 0 to disable)
const MIN_LIQUIDITY = 5_000; // USD - ignore pools with less liquidity than this (filters most rugs)
const CHANGE_WINDOW = 'm5'; // GeckoTerminal window: m5, m15, m30, h1, h6, h24
const MIN_VOLUME_5M = 1_000; // USD - minimum volume traded in the last 5 minutes
const MIN_TRADES_5M = 10; // minimum buys + sells in the last 5 minutes
const MIN_VOLUME_ACCEL = 1.5; // last 5 min volume vs the average 5 min of the 10 min before (1.5 = 50% higher)
const TRENDING_PAGES = 3; // 20 pools per page
const NEW_POOL_PAGES = 3; // 20 pools per page
const REQUEST_DELAY_MS = 6_000; // gap between API calls - free tier allows roughly 10 calls/minute
// -----------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const THRESHOLD = Number(args.threshold ?? 5);
const INTERVAL_SEC = Number(args.interval ?? 30);
const ONCE = Boolean(args.once);
const ALERT_LOG = path.join(__dirname, 'alerts.jsonl');

const API = 'https://api.geckoterminal.com/api/v2/networks/solana';

const baselines = new Map(); // coin id -> market cap at last baseline
const flaggedWindow = new Set(); // coin ids currently beyond the window threshold

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

async function fetchJson(url, attempt = 1) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 429 && attempt <= 3) {
    const wait = 60_000; // the limit is per minute, so wait for the window to reset
    console.warn(`Rate limited, waiting ${wait / 1000}s before retrying...`);
    await sleep(wait);
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}: ${await res.text()}`);
  return res.json();
}

// Turns a GeckoTerminal pool (+ its included base token) into a coin record.
function toCoin(pool, tokens) {
  const a = pool.attributes;
  const tokenRef = pool.relationships.base_token.data.id;
  const token = tokens.get(tokenRef)?.attributes ?? {};
  // market_cap_usd is often null for new tokens; FDV is the same thing when the full supply circulates (e.g. pump.fun)
  const marketCap = Number(a.market_cap_usd ?? a.fdv_usd);
  const vol5 = Number(a.volume_usd?.m5 ?? 0);
  const vol15 = Number(a.volume_usd?.m15 ?? 0);
  const prevAvg5 = Math.max(vol15 - vol5, 0) / 2; // average 5-min volume over the 10 minutes before the last 5
  const tx5 = a.transactions?.m5 ?? {};
  return {
    id: token.address ?? tokenRef.replace(/^solana_/, ''),
    name: token.name ?? a.name,
    symbol: token.symbol ?? '?',
    market_cap: marketCap,
    price: Number(a.base_token_price_usd),
    liquidity: Number(a.reserve_in_usd),
    change: Number(a.price_change_percentage?.[CHANGE_WINDOW] ?? 0),
    volume_5m: vol5,
    trades_5m: (tx5.buys ?? 0) + (tx5.sells ?? 0),
    volume_accel: prevAvg5 > 0 ? vol5 / prevAvg5 : vol5 > 0 ? Infinity : 0, // Infinity = no trades before, just woke up
    pool: a.address,
  };
}

async function fetchCoins() {
  const urls = [];
  for (let p = 1; p <= TRENDING_PAGES; p++) urls.push(`${API}/trending_pools?page=${p}&duration=5m&include=base_token`);
  for (let p = 1; p <= NEW_POOL_PAGES; p++) urls.push(`${API}/new_pools?page=${p}&include=base_token`);

  const byId = new Map();
  for (const [i, url] of urls.entries()) {
    if (i > 0) await sleep(REQUEST_DELAY_MS);
    const json = await fetchJson(url);
    const tokens = new Map((json.included ?? []).map((t) => [t.id, t]));
    for (const pool of json.data ?? []) {
      const coin = toCoin(pool, tokens);
      // A coin can trade in several pools - keep the most liquid one
      const existing = byId.get(coin.id);
      if (!existing || coin.liquidity > existing.liquidity) byId.set(coin.id, coin);
    }
  }

  return [...byId.values()].filter(
    (c) =>
      c.market_cap > 0 &&
      c.market_cap >= MIN_MARKET_CAP &&
      c.market_cap <= MAX_MARKET_CAP &&
      c.liquidity >= MIN_LIQUIDITY &&
      isActive(c)
  );
}

// Skips frozen coins: needs recent volume and trades, and volume that is picking up.
function isActive(c) {
  return c.volume_5m >= MIN_VOLUME_5M && c.trades_5m >= MIN_TRADES_5M && c.volume_accel >= MIN_VOLUME_ACCEL;
}

const fmtUsd = (n) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n).toLocaleString()}`;
const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
const fmtAccel = (x) => (x === Infinity ? 'new' : `${x.toFixed(1)}x`);
const arrow = (p) => (p >= 0 ? '\x1b[32m▲' : '\x1b[31m▼');
const RESET = '\x1b[0m';

function alert(type, coin, pct, extra = {}) {
  console.log(
    `${arrow(pct)} [${type}] ${coin.name} (${coin.symbol}) ${fmtPct(pct)}  mcap ${fmtUsd(coin.market_cap)}  vol 5m ${fmtUsd(coin.volume_5m)} (${fmtAccel(coin.volume_accel)})  trades 5m ${coin.trades_5m}${RESET}\n` +
      `   id: ${coin.id}`
  );
  const record = { time: new Date().toISOString(), type, ...coin, volume_accel: fmtAccel(coin.volume_accel), pct, ...extra };
  fs.appendFileSync(ALERT_LOG, JSON.stringify(record) + '\n');
}

function printWindowTable(coins) {
  const movers = coins
    .filter((c) => Math.abs(c.change) >= THRESHOLD)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  console.log(
    `\nActive Solana coins (mcap ${fmtUsd(MIN_MARKET_CAP)}-${fmtUsd(MAX_MARKET_CAP)}) with ${CHANGE_WINDOW} move >= ${THRESHOLD}% ` +
      `(${movers.length} of ${coins.length} active):\n`
  );
  if (!movers.length) return;
  console.table(
    movers.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      [`${CHANGE_WINDOW} %`]: fmtPct(c.change),
      'market cap': fmtUsd(c.market_cap),
      'vol 5m': fmtUsd(c.volume_5m),
      'vol accel': fmtAccel(c.volume_accel),
      'trades 5m': c.trades_5m,
    }))
  );
}

async function tick(first) {
  const coins = await fetchCoins();
  const now = new Date().toLocaleTimeString();

  if (first) {
    printWindowTable(coins);
    for (const c of coins) {
      baselines.set(c.id, c.market_cap);
      if (Math.abs(c.change) >= THRESHOLD) flaggedWindow.add(c.id);
    }
    if (!ONCE) console.log(`\n[${now}] Watching for live moves >= ${THRESHOLD}% (every ${INTERVAL_SEC}s)...\n`);
    return;
  }

  let alerts = 0;
  for (const c of coins) {
    // Live move since baseline
    const base = baselines.get(c.id);
    if (base == null) {
      baselines.set(c.id, c.market_cap);
    } else {
      const pct = ((c.market_cap - base) / base) * 100;
      if (Math.abs(pct) >= THRESHOLD) {
        alert('LIVE', c, pct, { from_market_cap: base });
        baselines.set(c.id, c.market_cap);
        alerts++;
      }
    }

    // Window move newly crossing the threshold
    if (Math.abs(c.change) >= THRESHOLD) {
      if (!flaggedWindow.has(c.id)) {
        alert(CHANGE_WINDOW.toUpperCase(), c, c.change);
        flaggedWindow.add(c.id);
        alerts++;
      }
    } else {
      flaggedWindow.delete(c.id);
    }
  }
  if (!alerts) console.log(`[${now}] No new moves >= ${THRESHOLD}% across ${coins.length} active coins.`);
}

async function main() {
  console.log(
    `Tracking active Solana coins | mcap ${fmtUsd(MIN_MARKET_CAP)}-${fmtUsd(MAX_MARKET_CAP)} | threshold ±${THRESHOLD}% | alerts -> ${ALERT_LOG}`
  );
  let first = true;
  while (true) {
    try {
      await tick(first);
      first = false;
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Error: ${err.message}`);
    }
    if (ONCE) break;
    await sleep(INTERVAL_SEC * 1000);
  }
}

main();
