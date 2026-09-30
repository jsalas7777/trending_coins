#!/usr/bin/env node
// Lists pump.fun coins that are about to graduate (bonding curve nearly full), have been trading for more
// than MIN_AGE_MIN minutes, and whose volume increased in the last minute.
//
// Data source: pump.fun's own APIs (free, no API key).
//   1. Candidates = the most recently traded coins (frontend-api-v3 /coins sorted by last trade), keeping
//      only coins still on the bonding curve.
//   2. Bonding curve progress = share of the 793.1M sellable tokens already bought. The coin graduates to
//      PumpSwap at 100%.
//   3. For each candidate near graduation, fetch 1-minute candles (swap-api /candles) and compare the volume
//      of the last completed minute with the minute before it.
//
// Usage:
//   node graduating-pumpfun.js                    # one-time list
//   node graduating-pumpfun.js --watch            # repeat forever
//   node graduating-pumpfun.js --min-progress 90 --min-age 15 --min-growth 1.5 --pages 20

// ---- Settings ---------------------------------------------------------------
const MIN_PROGRESS = 80; // % of the bonding curve filled (override with --min-progress)
const MIN_AGE_MIN = 10; // minutes since the coin was created (override with --min-age)
const MIN_GROWTH = 1; // last minute volume must be more than previous minute volume x this (--min-growth)
const MIN_LAST_MIN_VOLUME = 0; // USD - ignore coins that traded less than this in the last minute
const PAGES = 10; // 50 recently traded coins per page (override with --pages)
// Gap between API calls per host. The coin list allows 60 calls/minute, the candles API more.
const REQUEST_DELAY_MS = { 'frontend-api-v3.pump.fun': 1_000, 'swap-api.pump.fun': 300 };
const WATCH_INTERVAL_MS = 30_000; // pause between runs with --watch
// -----------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const minProgress = Number(args['min-progress'] ?? MIN_PROGRESS);
const minAgeMin = Number(args['min-age'] ?? MIN_AGE_MIN);
const minGrowth = Number(args['min-growth'] ?? MIN_GROWTH);
const pages = Number(args.pages ?? PAGES);
const WATCH = Boolean(args.watch);

const FRONTEND_API = 'https://frontend-api-v3.pump.fun';
const SWAP_API = 'https://swap-api.pump.fun';
const CURVE_TOKENS = 793_100_000 * 1e6; // real token reserves when a coin launches (6 decimals)
const MINUTE = 60_000;
const BROWSER_HEADERS = {
  accept: 'application/json',
  origin: 'https://pump.fun',
  referer: 'https://pump.fun/',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
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

// Every call goes through here so calls to each host are spaced out.
const lastCall = {};
async function fetchJson(url, attempt = 1) {
  const host = new URL(url).host;
  const wait = (lastCall[host] ?? 0) + (REQUEST_DELAY_MS[host] ?? 1_000) - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[host] = Date.now();

  // Look like the pump.fun website: without a browser user agent requests are rejected, and without
  // origin/referer the coin list is rate limited after a couple of calls
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (res.status === 429 && attempt <= 8) {
    // pump.fun's limit is short-lived: back off 2s, 4s, 8s... capped at 30s
    const wait = Math.min(2 ** attempt, 30);
    console.warn(`Rate limited, waiting ${wait}s before retrying...`);
    await sleep(wait * 1000);
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`pump.fun ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Coins still on the bonding curve, with their progress towards graduation
async function fetchCandidates() {
  const byMint = new Map();
  for (let p = 0; p < pages; p++) {
    let coins;
    try {
      coins = await fetchJson(
        `${FRONTEND_API}/coins?offset=${p * 50}&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=true`
      );
    } catch (err) {
      if (!byMint.size) throw err;
      console.warn(`Stopped after ${p} pages of coins: ${err.message.slice(0, 80)}`);
      break;
    }
    for (const c of coins) byMint.set(c.mint, c);
    if (coins.length < 50) break;
  }

  const now = Date.now();
  return [...byMint.values()]
    .map((c) => ({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      created: c.created_timestamp,
      ageMin: (now - c.created_timestamp) / MINUTE,
      progress: (1 - c.real_token_reserves / CURVE_TOKENS) * 100,
      market_cap: Number(c.usd_market_cap ?? 0),
      graduated: c.complete || Boolean(c.pump_swap_pool),
    }))
    // 100% means the curve is full and the coin is migrating (or is an old coin with stale reserves)
    .filter((c) => !c.graduated && c.progress >= minProgress && c.progress < 100 && c.ageMin > minAgeMin);
}

// USD volume of the last completed minute and the minute before it (0 if there were no trades)
async function fetchMinuteVolumes(coin) {
  const candles = await fetchJson(
    `${SWAP_API}/v2/coins/${coin.mint}/candles?interval=1m&limit=10&currency=USD&createdTs=${coin.created}`
  );
  const byTime = new Map(candles.map((c) => [c.timestamp, Number(c.volume)]));
  const currentMinute = Math.floor(Date.now() / MINUTE) * MINUTE; // still in progress, so skipped
  return {
    lastMin: byTime.get(currentMinute - MINUTE) ?? 0,
    prevMin: byTime.get(currentMinute - 2 * MINUTE) ?? 0,
  };
}

const fmtUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n).toLocaleString()}`);
const fmtAge = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${Math.round(min % 60)}m` : `${Math.round(min)}m`);
const pumpUrl = (mint) => `https://pump.fun/coin/${mint}`;

async function run() {
  const candidates = await fetchCandidates();
  console.log(
    `Checking last-minute volume for ${candidates.length} coins with >= ${minProgress}% bonding curve and > ${minAgeMin}m of trading...`
  );

  const hits = [];
  for (const c of candidates) {
    try {
      Object.assign(c, await fetchMinuteVolumes(c));
    } catch (err) {
      console.error(`  ${c.symbol}: ${err.message}`);
      continue;
    }
    if (c.lastMin > c.prevMin * minGrowth && c.lastMin > MIN_LAST_MIN_VOLUME) hits.push(c);
  }

  hits.sort((a, b) => b.progress - a.progress);
  console.log(`\n[${new Date().toLocaleTimeString()}] ${hits.length} pump.fun coins about to graduate with rising volume:`);
  if (!hits.length) return;
  console.table(
    hits.map((c) => ({
      address: c.mint,
      symbol: c.symbol,
      'curve %': c.progress.toFixed(1),
      'market cap': fmtUsd(c.market_cap),
      age: fmtAge(c.ageMin),
      'vol last min': fmtUsd(c.lastMin),
      'vol prev min': fmtUsd(c.prevMin),
      change: c.prevMin ? `x${(c.lastMin / c.prevMin).toFixed(1)}` : 'new',
    }))
  );
  // Plain URLs so the terminal makes them clickable
  hits.forEach((c, i) => console.log(`  ${String(i).padStart(2)} ${c.symbol.padEnd(12)} ${pumpUrl(c.mint)}`));
}

async function main() {
  do {
    try {
      await run();
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Error: ${err.message}`);
    }
    if (WATCH) await sleep(WATCH_INTERVAL_MS);
  } while (WATCH);
}

main();
