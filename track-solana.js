#!/usr/bin/env node
// Lists small Solana coins whose trading volume is accelerating right now.
//
// Data source: GeckoTerminal (free, no API key) - trending (last 5 min) + newly created Solana pools.
// Each coin is identified by its Solana mint address (coin id).
//
// "Accelerating" = enough volume and trades in the last 5 minutes, and that 5-minute volume is at least
// MIN_VOLUME_ACCEL times the coin's pace over the 10 minutes before it. GeckoTerminal's shortest window
// is 5 minutes - there is no 1-minute volume.
//
// Every check prints the full list; coins that just started accelerating are marked ★ and logged.
//
// Usage:
//   node track-solana.js                  # watch continuously
//   node track-solana.js --once           # one-time snapshot
//   node track-solana.js --interval 60
//   node track-solana.js --new-only       # after the first list, only show coins that just started

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
// Skip pools on these exchanges (GeckoTerminal dex ids). Meteora pool creators can usually withdraw
// liquidity at any time, so rugs are common there. Others: pumpswap, pump-fun, raydium, raydium-clmm,
// raydium-launchlab, orca, letsbonk-fun, bags-fm, moonshot. Use [] to allow all.
const EXCLUDE_DEXES = ['meteora', 'meteora-dbc', 'meteora-damm-v2'];
const TRENDING_PAGES = 3; // 20 pools per page
const NEW_POOL_PAGES = 3; // 20 pools per page
const REQUEST_DELAY_MS = 6_000; // gap between API calls - free tier allows roughly 10 calls/minute
// -----------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const INTERVAL_SEC = Number(args.interval ?? 30);
const ONCE = Boolean(args.once);
const ALERT_LOG = path.join(__dirname, 'alerts.jsonl');
const SHOW_NEW_ONLY = Boolean(args['new-only']);

const API = 'https://api.geckoterminal.com/api/v2/networks/solana';

let previousIds = new Set(); // coins that were accelerating on the previous check

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
    dex: pool.relationships.dex?.data?.id ?? '?',
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
      if (EXCLUDE_DEXES.includes(coin.dex)) continue;
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
const gmgnUrl = (id) => `https://gmgn.ai/sol/token/${id}`;
const fmtAccel = (x) => (x === Infinity ? 'new' : `${x.toFixed(1)}x`);

// Highest acceleration first ('new' = no trades before, sorts on top), then by 5-min volume
const byAccel = (a, b) => b.volume_accel - a.volume_accel || b.volume_5m - a.volume_5m;

function logNew(coins) {
  const time = new Date().toISOString();
  const lines = coins.map((c) => JSON.stringify({ time, ...c, volume_accel: fmtAccel(c.volume_accel), gmgn: gmgnUrl(c.id) }));
  if (lines.length) fs.appendFileSync(ALERT_LOG, lines.join('\n') + '\n');
}

function printTable(coins, newIds) {
  console.table(
    coins.map((c) => ({
      ' ': newIds.has(c.id) ? '★' : '',
      id: c.id,
      symbol: c.symbol,
      dex: c.dex,
      'vol accel': fmtAccel(c.volume_accel),
      'vol 5m': fmtUsd(c.volume_5m),
      'trades 5m': c.trades_5m,
      [`${CHANGE_WINDOW} %`]: fmtPct(c.change),
      'market cap': fmtUsd(c.market_cap),
    }))
  );
  // Plain URLs so the terminal makes them clickable (Cmd+click in VS Code / iTerm / Terminal)
  coins.forEach((c, i) => console.log(`  ${String(i).padStart(2)} ${newIds.has(c.id) ? '★' : ' '} ${c.symbol.padEnd(12)} ${gmgnUrl(c.id)}`));
}

async function tick(first) {
  const coins = (await fetchCoins()).sort(byAccel);
  const now = new Date().toLocaleTimeString();

  // On the first check everything would be new - only mark coins ★ from the second check on
  const newIds = new Set(first ? [] : coins.filter((c) => !previousIds.has(c.id)).map((c) => c.id));
  previousIds = new Set(coins.map((c) => c.id));
  logNew(first ? coins : coins.filter((c) => newIds.has(c.id)));

  const shown = SHOW_NEW_ONLY && !first ? coins.filter((c) => newIds.has(c.id)) : coins;
  console.log(`\n[${now}] ${coins.length} accelerating coins (${newIds.size} just started ★):`);
  if (shown.length) printTable(shown, newIds);
}

async function main() {
  console.log(
    `Tracking Solana coins with accelerating volume | mcap ${fmtUsd(MIN_MARKET_CAP)}-${fmtUsd(MAX_MARKET_CAP)} | ` +
      `vol accel >= ${MIN_VOLUME_ACCEL}x | log -> ${ALERT_LOG}`
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
