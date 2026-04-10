/* Keep in sync with ../server.js (parent repo). */
require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const { createDb, DEFAULT_PRUNE_MS } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const INR_PER_USD = Number(process.env.INR_PER_USD) || 83;
const SKIP_WEBHOOK_SIGNATURE =
  process.env.SKIP_WEBHOOK_SIGNATURE === '1' ||
  process.env.SKIP_WEBHOOK_SIGNATURE === 'true';
const LEAD_NOTIFY_WEBHOOK_URL = process.env.LEAD_NOTIFY_WEBHOOK_URL || '';
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'aura.db');

const CATALOG_PATH = path.join(__dirname, 'catalog.json');
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

if (IS_PRODUCTION) {
  if (!META_APP_SECRET) {
    console.error('FATAL: META_APP_SECRET is required when NODE_ENV=production');
    process.exit(1);
  }
  if (SKIP_WEBHOOK_SIGNATURE) {
    console.error('FATAL: SKIP_WEBHOOK_SIGNATURE cannot be used in production');
    process.exit(1);
  }
}

const db = createDb(DATABASE_PATH);
db.pruneProcessed(Number(process.env.DEDUPE_PRUNE_MS) || DEFAULT_PRUNE_MS);

let genaiClient = null;
function getGenAI() {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  if (!genaiClient) {
    genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genaiClient;
}

function log(level, message, meta) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (meta !== undefined) {
    console.log(line, meta);
  } else {
    console.log(line);
  }
}

let warnedMissingMetaSecret = false;
function verifyWebhookSignature(req) {
  if (SKIP_WEBHOOK_SIGNATURE) {
    log('warn', 'Webhook signature verification skipped (SKIP_WEBHOOK_SIGNATURE)');
    return true;
  }
  if (!META_APP_SECRET) {
    if (IS_PRODUCTION) {
      return false;
    }
    if (!warnedMissingMetaSecret) {
      log('warn', 'META_APP_SECRET not set; webhook signatures not verified (dev only)');
      warnedMissingMetaSecret = true;
    }
    return true;
  }

  const signature = req.get('x-hub-signature-256');
  const rawBody = req.rawBody;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    log('warn', 'Missing raw body for signature verification');
    return false;
  }
  if (!signature || !signature.startsWith('sha256=')) {
    log('warn', 'Missing or invalid X-Hub-Signature-256 header');
    return false;
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function loadCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  return JSON.parse(raw);
}

function buildSystemPrompt(catalog) {
  const catalogJson = JSON.stringify(catalog, null, 2);
  return `You are Aura, the 24/7 concierge stylist for "${catalog.brand || 'Aura Atelier'}", a luxury clothing brand.

Voice & behavior:
- Sophisticated, warm, and concise. Never pushy, but confidently guide the client toward the right piece and the next step.
- You serve international clients, especially in the United States, often when the boutique owner is offline.
- Always ground recommendations in the provided catalog only. If something is not listed, offer to note interest for the team (capture lead details).

Pricing & currency:
- Catalog prices are in INR. When discussing budget or quoting prices to US-based clients, convert INR to USD using exactly 1 USD = ${INR_PER_USD} INR (USD amount = INR / ${INR_PER_USD}). Round to whole dollars for quotes unless the client asks for precision.
- You may mention that final charges and duties can vary by destination.

Shipping:
- Use the shipping object in the catalog for regions, timelines, and fee structure. Summarize clearly in plain language.

Lead capture (critical):
- Naturally work toward collecting: full name, email, phone (with country code), city/time zone, and best time for a human stylist to follow up.
- If the client is ready, confirm their selections (product, size, color) before closing.

Catalog JSON (source of truth):
${catalogJson}`;
}

async function generateReply(userText, catalog) {
  const ai = getGenAI();
  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: userText,
    config: {
      systemInstruction: buildSystemPrompt(catalog),
    },
  });
  const text = result.text;
  if (!text || !String(text).trim()) {
    throw new Error('Empty model response');
  }
  return String(text).trim();
}

async function sendWhatsAppText(to, body) {
  if (!WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
    throw new Error('WhatsApp Cloud API credentials are not configured');
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    },
  );
}

function extractInboundFromMessage(message) {
  const from = message.from;
  if (!from) {
    return null;
  }

  if (message.type === 'text' && message.text?.body) {
    return { from, text: message.text.body, metaMessageId: message.id || null };
  }

  return {
    from,
    text: null,
    unsupportedType: message.type || 'unknown',
    metaMessageId: message.id || null,
  };
}

function extractEmails(text) {
  if (!text) {
    return [];
  }
  const matches = text.match(new RegExp(EMAIL_RE, 'gi'));
  return matches ? [...new Set(matches.map((e) => e.trim()))] : [];
}

async function notifyLeadWebhook(payload) {
  if (!LEAD_NOTIFY_WEBHOOK_URL) {
    return;
  }
  try {
    const res = await axios.post(LEAD_NOTIFY_WEBHOOK_URL, payload, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      log('warn', 'LEAD_NOTIFY_WEBHOOK_URL returned non-success status', {
        status: res.status,
      });
    }
  } catch (err) {
    log('warn', 'LEAD_NOTIFY_WEBHOOK_URL request failed', { message: err.message });
  }
}

async function handleInboundMessage(inbound) {
  const { from, text, unsupportedType, metaMessageId } = inbound;

  db.logMessage({
    waId: from,
    direction: 'in',
    body: text || `[non-text:${unsupportedType}]`,
    metaMessageId,
  });

  if (text) {
    const emails = extractEmails(text);
    for (const email of emails) {
      db.insertLead({
        waId: from,
        email,
        rawSnippet: text.length > 500 ? text.slice(0, 500) : text,
      });
      await notifyLeadWebhook({
        type: 'lead_email',
        wa_id: from,
        email,
        captured_at: new Date().toISOString(),
      });
    }
  }

  if (!text) {
    log('info', 'Inbound non-text message; sending short fallback', {
      from_tail: from.slice(-4),
      type: unsupportedType,
    });
    const fallback =
      'Thank you for your message. Please send a text note and Aura will assist you right away.';
    await sendWhatsAppText(from, fallback);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: fallback,
      metaMessageId: null,
    });
    return;
  }

  let catalog;
  try {
    catalog = loadCatalog();
  } catch (err) {
    log('error', 'Failed to read catalog.json', { message: err.message });
    const apology =
      'We are having a brief technical issue loading our catalog. Please leave your email and what you are looking for, and our team will reply shortly.';
    await sendWhatsAppText(from, apology);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: apology,
      metaMessageId: null,
    });
    return;
  }

  let reply;
  try {
    reply = await generateReply(text, catalog);
  } catch (err) {
    log('error', 'Gemini error', { message: err.message });
    const apology =
      'Our stylist assistant is briefly unavailable. Please share your name, email, and best time to reach you, and our team will follow up shortly.';
    await sendWhatsAppText(from, apology);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: apology,
      metaMessageId: null,
    });
    return;
  }

  await sendWhatsAppText(from, reply);
  db.logMessage({
    waId: from,
    direction: 'out',
    body: reply,
    metaMessageId: null,
  });
}

function collectMessagesFromPayload(payload) {
  const messages = [];
  const entries = payload?.entry;
  if (!Array.isArray(entries)) {
    return messages;
  }
  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) {
      continue;
    }
    for (const change of changes) {
      const value = change?.value;
      const batch = value?.messages;
      if (Array.isArray(batch)) {
        for (const m of batch) {
          messages.push(m);
        }
      }
    }
  }
  return messages;
}

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  if (req.path === '/webhook' && req.method === 'POST') {
    return next();
  }
  express.json()(req, res, next);
});

app.get('/', (req, res) => {
  res.status(200).type('text/plain').send('Aura WhatsApp webhook server is running.');
});

app.get('/health', (req, res) => {
  try {
    db.ping();
    res.status(200).json({
      ok: true,
      uptime_s: Math.round(process.uptime()),
      env: NODE_ENV,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database_unavailable' });
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe') {
    log('warn', 'Webhook verification rejected: invalid hub.mode', { mode });
    return res.sendStatus(400);
  }

  if (!VERIFY_TOKEN) {
    log('error', 'VERIFY_TOKEN is not set');
    return res.sendStatus(500);
  }

  if (token !== VERIFY_TOKEN) {
    log('warn', 'Webhook verification failed: token mismatch');
    return res.sendStatus(403);
  }

  if (!challenge) {
    return res.sendStatus(400);
  }

  log('info', 'Webhook verified successfully');
  return res.status(200).type('text/plain').send(challenge);
});

app.post(
  '/webhook',
  express.json({
    limit: '5mb',
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }),
  (req, res) => {
    if (!verifyWebhookSignature(req)) {
      log('warn', 'Webhook signature verification failed');
      return res.sendStatus(403);
    }

    if (!req.body || typeof req.body !== 'object') {
      log('warn', 'POST /webhook: invalid JSON body');
      return res.sendStatus(400);
    }

    const objectType = req.body.object;
    if (objectType && objectType !== 'whatsapp_business_account') {
      log('info', 'POST /webhook: ignored object type', { objectType });
      return res.sendStatus(200);
    }

    const messages = collectMessagesFromPayload(req.body);
    if (messages.length === 0) {
      return res.sendStatus(200);
    }

    for (const message of messages) {
      const messageId = message.id;
      if (!messageId) {
        log('warn', 'Inbound message without id; skipping');
        continue;
      }

      const inbound = extractInboundFromMessage(message);
      if (!inbound) {
        continue;
      }

      if (!db.tryClaimMessage(messageId)) {
        log('info', 'Duplicate webhook delivery skipped', {
          id_prefix: messageId.slice(0, 12),
        });
        continue;
      }

      setImmediate(() => {
        handleInboundMessage(inbound).catch((err) => {
          log('error', 'Async webhook handler failed', {
            message: err.message,
            stack: IS_PRODUCTION ? undefined : err.stack,
          });
        });
      });
    }

    return res.sendStatus(200);
  },
);

app.use((err, req, res, next) => {
  log('error', 'Unhandled error', { message: err.message });
  if (res.headersSent) {
    return next(err);
  }
  return res.sendStatus(500);
});

const server = app.listen(PORT, () => {
  log('info', `Aura server listening on port ${PORT}`);
});

function shutdown(signal) {
  log('info', `${signal} received, closing`);
  server.close(() => {
    try {
      db.close();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
