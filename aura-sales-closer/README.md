# Aura Sales Closer

Production-aligned WhatsApp webhook + **Gemini** stylist for a small catalog. This folder mirrors the main app in the parent repo (`../server.js`, `../db.js`): webhook **signature verification**, **SQLite deduplication**, **async processing**, **conversation + lead logging**, and **`GET /health`**.

## Quick start

```bash
cd aura-sales-closer
npm install
cp .env.example .env
# Fill GEMINI_API_KEY, WA_*, VERIFY_TOKEN, META_APP_SECRET (required in production)
npm start
```

- **Local / tunnel without Meta signatures:** set `SKIP_WEBHOOK_SIGNATURE=1` in `.env`. Never in production.
- **Production:** set `NODE_ENV=production` and **`META_APP_SECRET`** (Meta App → Settings → Basic).

## Catalog

`catalog.json` uses the same shape as the parent project: `brand`, `shipping`, and `products[]` with **`priceInr`**. Edit products there; the model reads the file on each message.

## Deploy

Point Meta’s callback to `https://<host>/webhook`. Use a **persistent disk** and `DATABASE_PATH` on that disk if you need SQLite to survive restarts (e.g. Render).

For the full environment variable list and operations notes, see the parent **`../README.md`**.
