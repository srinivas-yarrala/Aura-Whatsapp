# Aura — WhatsApp sales closer (luxury fashion)

Node.js + Express webhook server that powers **Aura**, a 24/7 AI stylist for international clients. It uses **Google Gemini** (via `@google/genai`) and the **WhatsApp Cloud API** to send messages.

Production behavior includes **Meta webhook signature verification**, **fast HTTP 200 acknowledgements** with **async processing**, **SQLite-backed message deduplication**, **conversation memory** (last 10 turns per phone), **lightweight catalog RAG** (top 3 products per message), **24-hour re-engagement template** (optional), **WhatsApp media-ID caching** for catalog images, **voice note** handling (audio → Gemini), **structured JSON replies** (text / image / reply buttons), **conversation and lead logging**, and **graceful shutdown**.

## Prerequisites

- **Node.js 20+** (required by `@google/genai`)
- A [Google AI Studio](https://aistudio.google.com/) API key (Gemini)
- A Meta developer app with WhatsApp **Cloud API** enabled, including:
  - **Phone number ID**
  - **Permanent access token** (or a valid long-lived system user token for production)
  - A **verify token** you choose (any secret string)
  - **App Secret** (Settings → Basic) for `META_APP_SECRET` in production

## Local setup

```bash
cd aura-whatsapp-sales
npm install
cp .env.example .env
# Edit .env with your keys and tokens
npm start
```

The server listens on `PORT` (default `3000`).

For local tunnel testing without configuring signatures, you can set `SKIP_WEBHOOK_SIGNATURE=1` in `.env`. **Never use that in production.**

## Environment variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google AI (Gemini) API key |
| `GEMINI_MODEL` | Optional; default `gemini-3-flash-preview` |
| `WA_PHONE_NUMBER_ID` | WhatsApp Cloud API phone number ID |
| `WA_ACCESS_TOKEN` | WhatsApp Cloud API access token |
| `VERIFY_TOKEN` | Same string you enter in Meta’s webhook verify token field |
| `META_APP_SECRET` | Meta App Secret; **required** when `NODE_ENV=production` (webhook `X-Hub-Signature-256`) |
| `PORT` | HTTP port (Render sets this automatically) |
| `NODE_ENV` | Set to `production` on live hosts |
| `DATABASE_PATH` | Optional; default `./data/aura.db` (SQLite) |
| `LEAD_NOTIFY_WEBHOOK_URL` | Optional; receives a JSON POST when a customer message contains an email |
| `GRAPH_API_VERSION` | Optional; default `v21.0` |
| `SKIP_WEBHOOK_SIGNATURE` | Dev only: `1` or `true` to skip signature checks |
| `INR_PER_USD` | Optional; default `83` for INR → USD quotes |
| `DEDUPE_PRUNE_MS` | Optional; how long dedupe keys are kept (ms); default 7 days |
| `WA_REENGAGEMENT_TEMPLATE` | Optional; default `reengagement_ping` — sent instead of Gemini if the customer’s **last user** message was **>24h** ago (must be an **approved** WhatsApp template). Alias: `WA_REENGAGEMENT_TEMPLATES` |
| `WA_TEMPLATE_LANG` | Optional; template language code, default `en` (often `en_US` in Meta) |

## Webhook URLs (Meta)

- **Callback URL:** `https://<your-host>/webhook`
- **Verify token:** must match `VERIFY_TOKEN` in `.env`

Subscribe to **`messages`** (and optionally other fields you need) for the WhatsApp Business Account. Create and approve a template named **`reengagement_ping`** (or set `WA_REENGAGEMENT_TEMPLATE`) if you use the 24h branch.

## Health checks

- `GET /` — plain-text liveness
- `GET /health` — JSON `{ ok, uptime_s, env }` and a SQLite ping

Point your host’s health check at `/health` if supported.

## Data & persistence

SQLite stores:

- **processed message IDs** — avoids double replies when Meta retries webhooks
- **messages** — `phone_number`, `role` (`user` \| `model`), `message_text`, `timestamp` (used for Gemini context and the 24h rule)
- **media_cache** — maps catalog `image_url` → WhatsApp **media id** after upload to Meta
- **conversation log** — inbound/outbound audit lines (truncated)
- **leads** — rows created when an email address appears in a customer message

The `data/` directory is gitignored. On **Render** (or similar), attach a **persistent disk** and set `DATABASE_PATH` to a path on that disk if you need the database to survive deploys and restarts.

For **multiple server instances**, a single SQLite file is not sufficient; you would replace dedupe with **Redis** or another shared store (not included here).

## Deploy on Render

1. Push this project to a **GitHub** repository (root should contain `package.json`, `server.js`, `db.js`, and `Procfile`).
2. In [Render](https://render.com/), create a **Web Service** and connect the repo.
3. **Runtime:** Node 20+
4. **Build command:** `npm install` (or leave default if Render auto-detects)
5. **Start command:** **`npm start`** (runs `node server.js` from `package.json`). Do **not** use `node start`—that looks for a missing file named `start` and fails. Alternatively: `node server.js`. The repo includes **`render.yaml`** with the correct `startCommand` if you use a Render Blueprint.
6. Under **Environment**, set `NODE_ENV=production` and add all variables from `.env.example`, including **`META_APP_SECRET`** (never commit real `.env`).
7. Optional: add a **persistent disk** and set `DATABASE_PATH` to a file on that disk.
8. Use your Render URL as the Meta webhook **Callback URL**, e.g. `https://aura-whatsapp-sales.onrender.com/webhook`.
9. Redeploy after changing environment variables.

**Note:** Free Render instances may spin down when idle; for production webhooks you typically want an **always-on** plan.

## Project layout

- `server.js` — Express app, GET/POST `/webhook`, Gemini + WhatsApp integration
- `db.js` — SQLite helpers (dedupe, logs, leads)
- `catalog.json` — Products (INR), shipping notes, and brand metadata passed to the model
- `.env.example` — Template for secrets (copy to `.env` locally)
- `Procfile` — `web: node server.js` for Render/Heroku-style hosts
- `aura-sales-closer/` — Same production stack with a minimal sample catalog (deployable as its own service)

## License

MIT
