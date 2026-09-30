# trending_coins
this project is for trending coins

## Solana accelerating-volume tracker

Lists small Solana coins (market cap up to $500k) whose trading volume is accelerating right now, using GeckoTerminal's trending and new Solana pools. No API key needed.

```bash
npm start                          # watch continuously (checks every ~60s)
npm run once                       # one-time list
node track-solana.js --new-only    # after the first list, only show coins that just started accelerating
node track-solana.js --interval 60
```

Settings are constants at the top of `track-solana.js`:

- `MAX_MARKET_CAP` / `MIN_MARKET_CAP` - market cap range
- `MIN_VOLUME_5M`, `MIN_TRADES_5M` - minimum activity in the last 5 minutes
- `MIN_VOLUME_ACCEL` - last-5-minute volume vs. the average 5 minutes of the 10 minutes before (`new` = no trades before)
- `MIN_LIQUIDITY`, `EXCLUDE_DEXES` - basic rug protection (Meteora pools are excluded by default)

Each coin is shown with its **id** (Solana mint address). Coins that start accelerating since the previous check are marked ★ and appended to `alerts.jsonl`.

## pump.fun RSI scanner

Lists pump.fun coins (bonding curve + graduated to PumpSwap) whose RSI(14) is between 55 and 70, using GeckoTerminal candles. No API key needed.

```bash
npm run rsi                                   # one-time list, RSI 55-70 on 5-minute candles
node rsi-pumpfun.js --min-rsi 50 --max-rsi 65  # different range
node rsi-pumpfun.js --timeframe 15m           # 1m, 5m, 15m, 1h, 4h, 12h, 1d
node rsi-pumpfun.js --max-coins 30 --watch    # check more coins, repeat forever
```

The free API allows about 10 calls per minute, so each coin checked adds ~6 seconds. Settings (`MIN_LIQUIDITY`, `MIN_VOLUME_1H`, `CANDLES`, ...) are constants at the top of `rsi-pumpfun.js`.

## pump.fun about-to-graduate scanner

Lists pump.fun coins that are about to graduate: bonding curve at least 80% full, trading for more than 10 minutes, and more volume in the last completed minute than in the minute before. Uses pump.fun's own APIs. No API key needed.

```bash
npm run graduating                                   # one-time list
node graduating-pumpfun.js --watch                   # repeat every 30s
node graduating-pumpfun.js --min-progress 90 --min-age 15 --min-growth 1.5 --pages 10
```

- `--min-progress` - % of the bonding curve filled (the coin graduates to PumpSwap at 100%)
- `--min-age` - minutes since the coin was created
- `--min-growth` - last-minute volume must be more than the previous minute's volume times this
- `--pages` - how many pages of 50 recently traded coins to scan

The script sends the same `origin`/`referer` headers as the pump.fun website - without them the coin list is rate limited after a couple of calls. It waits 1s between pages and backs off if it is still limited.
