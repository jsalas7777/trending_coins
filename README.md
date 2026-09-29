# trending_coins
this project is for trending coins

## Solana market cap tracker

Tracks small Solana coins (market cap up to $500k) that are actively trading right now and whose market cap moves ±5% or more, using GeckoTerminal's trending and new Solana pools. No API key needed.

```bash
npm start                      # watch continuously (poll every 30s)
npm run once                   # one-time snapshot
node track-solana.js --threshold 10 --interval 120
```

Market cap range, liquidity filter and change window are constants at the top of `track-solana.js` (`MAX_MARKET_CAP`, `MIN_MARKET_CAP`, `MIN_LIQUIDITY`, `CHANGE_WINDOW`).

Frozen coins are skipped: a coin must have at least `MIN_VOLUME_5M` volume and `MIN_TRADES_5M` trades in the last 5 minutes, and its 5-minute volume must be `MIN_VOLUME_ACCEL` times its pace over the previous 10 minutes.

- Each coin is shown with its **id** (Solana mint address).
- **M5** alerts: the last-5-minute change crosses the threshold. **LIVE** alerts: market cap moved ≥ threshold since the script's last baseline.
- Alerts are appended to `alerts.jsonl`.
