# fren

Launch a coin on Stonk.fun and route its creator fees to an X handle.

- **Launch**: fren builds Raydium LaunchLab's `initialize_with_token2022` itself (Stonk.fun's config, platform and curve rule). Each coin gets its own launch wallet, which is the pool's creator, so Stonk forwards the creator fees there.
- **The fren chain**: name up to three X handles. Each gets 7 days to sign in with X and link a wallet. If nobody does, the fees go back to the launcher.
- **Payouts**: one Solana transaction per payout, `FREN_SPLIT_BPS` (default 80%) to the fren and the rest to `FREN_TREASURY`, with a `fren|v1|pay|<coin>|@handle` memo.

## Run it

Static site (`index.html`, `style.css`, `app.js`) plus one Vercel function (`api/fren.js`) behind `/api/*`.

| env | what |
|---|---|
| `FREN_MASTER_SEED` | 64 hex chars. Every coin wallet derives from it. Back it up. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store (launch records, links, payouts, images) |
| `FREN_TREASURY` | Solana wallet for the protocol share. Payouts stay off until it's set. |
| `FREN_SPLIT_BPS` | fren share in basis points, default `8000` |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X OAuth 2.0 app. Callback: `https://<site>/api/auth/x/callback`, scopes `users.read tweet.read` |
| `SITE_URL` | public URL of the site |
| `SOLANA_RPC` | optional, a private RPC (falls back to public ones) |
| `CRON_SECRET` | optional, protects the daily `/api/cron` payout run |

## Where you trust fren

Coin wallets are custodial (derived from `FREN_MASTER_SEED`), and the split runs on the server. Every payout is public on Solscan, and every coin page shows the fees sitting in its wallet.
