/* Keep in sync with ../server.js (parent repo). */
require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');
const { createDb, DEFAULT_PRUNE_MS } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const INR_PER_USD = Number(process.env.INR_PER_USD) || 83;
const SKIP_WEBHOOK_SIGNATURE =
  process.env.SKIP_WEBHOOK_SIGNATURE === '1' ||
  process.env.SKIP_WEBHOOK_SIGNATURE === 'true';
const LEAD_NOTIFY_WEBHOOK_URL = process.env.LEAD_NOTIFY_WEBHOOK_URL || '';
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'aura.db');
const WA_REENGAGEMENT_TEMPLATE =
  process.env.WA_REENGAGEMENT_TEMPLATE ||
  process.env.WA_REENGAGEMENT_TEMPLATES ||
  'reengagement_ping';
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'en';

const CATALOG_PATH = path.join(__dirname, 'catalog.json');
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
const CHAT_HISTORY_LIMIT = 10;

/** WhatsApp Cloud API limits */
const WA_CAPTION_MAX = 1024;
const WA_BODY_MAX = 1024;
const WA_TEXT_MAX = 4096;
const WA_BUTTON_TITLE_MAX = 20;
const WA_MAX_BUTTONS = 3;

const GEMINI_JSON_FALLBACK =
  'Sorry — something went wrong formatting our reply. Please send your message again or say what you need help with.';

const VOICE_NOTE_PLACEHOLDER = '[Voice note]';

/** JSON schema for Gemini structured output (responseMimeType application/json). */
const AURA_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message_text: {
      type: 'string',
      description: 'Main conversational reply to the customer.',
    },
    image_to_send: {
      description:
        'Absolute HTTPS image URL from the catalog product image_url when showcasing one specific product; otherwise null.',
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    suggested_buttons: {
      type: 'array',
      description: 'Up to 3 reply button titles, max 20 characters each.',
      items: { type: 'string', maxLength: WA_BUTTON_TITLE_MAX },
      maxItems: WA_MAX_BUTTONS,
    },
  },
  required: ['message_text', 'image_to_send', 'suggested_buttons'],
};

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

function tokenizeQuery(text) {
  const q = (text || '').toLowerCase().trim();
  return q.split(/[^a-z0-9]+/i).filter((w) => w.length > 2);
}

/** Lightweight keyword / substring match; top 3 products or first 3 defaults. */
function selectRelevantProducts(userText, catalog) {
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  if (products.length === 0) {
    return [];
  }
  const q = (userText || '').toLowerCase().trim();
  const tokens = tokenizeQuery(userText);
  const scored = products.map((p) => {
    const hay = `${p.name || ''} ${p.description || ''} ${p.stylist_note || ''} ${p.category || ''} ${p.material || ''}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) {
        score += 2;
      }
    }
    if (q.length > 0 && hay.includes(q)) {
      score += 5;
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const withHits = scored.filter((s) => s.score > 0).map((s) => s.p);
  const top = withHits.slice(0, 3);
  if (top.length >= 3) {
    return top;
  }
  const rest = products.filter((pr) => !top.includes(pr));
  return [...top, ...rest].slice(0, 3);
}

function buildRagCatalog(fullCatalog, userText) {
  const products = selectRelevantProducts(userText, fullCatalog);
  return {
    brand: fullCatalog.brand,
    shipping: fullCatalog.shipping,
    currency: fullCatalog.currency,
    inrPerUsd: fullCatalog.inrPerUsd,
    products,
  };
}

function buildSystemPrompt(ragCatalog) {
  const catalogJson = JSON.stringify(ragCatalog, null, 2);
  return `You are Aura, the 24/7 concierge stylist for "${ragCatalog.brand || 'Aura Atelier'}", a luxury clothing brand.

Voice & behavior:
- Sophisticated, warm, and concise. Never pushy, but confidently guide the client toward the right piece and the next step.
- You serve international clients, especially in the United States, often when the boutique owner is offline.
- The JSON below is the ONLY product subset in scope for this turn (retrieved for relevance). Each product may include stylist_note — use it as internal talking points for tone and upsell, not as raw copy pasted verbatim unless it fits naturally.
- If the client asks for something not listed, offer to note interest for the team (capture lead details).

Pricing & currency:
- Catalog prices are in INR. When discussing budget or quoting prices to US-based clients, convert INR to USD using exactly 1 USD = ${INR_PER_USD} INR (USD amount = INR / ${INR_PER_USD}). Round to whole dollars for quotes unless the client asks for precision.
- You may mention that final charges and duties can vary by destination.

Shipping:
- Use the shipping object in the catalog for regions, timelines, and fee structure. Summarize clearly in plain language.

Lead capture (critical):
- Naturally work toward collecting: full name, email, phone (with country code), city/time zone, and best time for a human stylist to follow up.
- If the client is ready, confirm their selections (product, size, color) before closing.

If the user sent a voice note, infer intent from the audio and respond helpfully.

OUTPUT (your entire reply MUST be one JSON object only — valid JSON, no markdown fences, no extra text):
{
  "message_text": "The main conversational reply shown to the customer.",
  "image_to_send": "URL string from the catalog product's image_url when you are showcasing one specific product as the focus; otherwise null",
  "suggested_buttons": ["Button 1", "Button 2"]
}
Rules for OUTPUT:
- suggested_buttons: at most ${WA_MAX_BUTTONS} items; each string at most ${WA_BUTTON_TITLE_MAX} characters (WhatsApp hard limit).
- image_to_send: use the exact image_url from the catalog JSON for that product when a single product is the hero of the message; otherwise null.
- message_text: full prose for captions or interactive bodies as appropriate; keep scannable on mobile.

Relevant catalog JSON (this turn):
${catalogJson}`;
}

function buildGeminiContents(historyRows, { audioBase64, audioMimeType }) {
  const contents = [];
  const lastIdx = historyRows.length - 1;
  for (let i = 0; i < historyRows.length; i++) {
    const row = historyRows[i];
    const role = row.role === 'model' ? 'model' : 'user';
    const isLastUser = i === lastIdx && role === 'user';

    if (isLastUser && audioBase64) {
      contents.push({
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: audioMimeType || 'audio/ogg',
              data: audioBase64,
            },
          },
        ],
      });
      continue;
    }

    const t = row.message_text != null ? String(row.message_text) : '';
    if (!t && role === 'user') {
      continue;
    }
    contents.push({
      role,
      parts: [{ text: t || ' ' }],
    });
  }
  return contents;
}

async function generateStructuredReply(contents, ragCatalog) {
  if (!contents.length) {
    throw new Error('No conversation contents for Gemini');
  }
  const ai = getGenAI();
  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: buildSystemPrompt(ragCatalog),
      responseMimeType: 'application/json',
      responseJsonSchema: AURA_RESPONSE_JSON_SCHEMA,
    },
  });
  const text = result.text;
  if (!text || !String(text).trim()) {
    throw new Error('Empty model response');
  }
  return String(text).trim();
}

async function graphSendMessage(payload) {
  if (!WA_PHONE_NUMBER_ID || !WA_ACCESS_TOKEN) {
    throw new Error('WhatsApp Cloud API credentials are not configured');
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: 'whatsapp', ...payload },
    {
      headers: {
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    },
  );
}

async function sendTemplateReengagement(to) {
  await graphSendMessage({
    to,
    type: 'template',
    template: {
      name: WA_REENGAGEMENT_TEMPLATE,
      language: { code: WA_TEMPLATE_LANG },
    },
  });
}

async function resolveMediaDownloadUrl(mediaId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
    params: { access_token: WA_ACCESS_TOKEN },
    timeout: 30000,
  });
  if (!data?.url) {
    throw new Error('Meta media response missing url');
  }
  return data.url;
}

async function downloadWhatsAppMediaBuffer(mediaId) {
  const mediaUrl = await resolveMediaDownloadUrl(mediaId);
  const { data } = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
    timeout: 60000,
    maxContentLength: 25 * 1024 * 1024,
  });
  return Buffer.from(data);
}

function mimeToWhatsAppMediaType(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('png')) {
    return 'image/png';
  }
  if (m.includes('webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function guessFilenameFromUrl(imageUrl, mime) {
  try {
    const u = new URL(imageUrl);
    const base = path.basename(u.pathname) || 'image';
    if (base.includes('.')) {
      return base.slice(0, 120);
    }
  } catch {
    /* ignore */
  }
  const ext = mimeToWhatsAppMediaType(mime) === 'image/png' ? 'png' : 'jpg';
  return `image.${ext}`;
}

async function uploadImageBufferToWhatsApp(buffer, filename, contentType) {
  const waType = mimeToWhatsAppMediaType(contentType);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', waType);
  form.append('file', buffer, { filename: filename || 'image.jpg', contentType: waType });

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/media`;
  const { data } = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });
  if (!data?.id) {
    throw new Error('Meta media upload missing id');
  }
  return data.id;
}

async function sendWhatsAppImageWithCache(to, imageUrl, caption) {
  let mediaId = db.getCachedMediaId(imageUrl);
  if (!mediaId) {
    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 45000,
      maxContentLength: 15 * 1024 * 1024,
    });
    const buf = Buffer.from(imgRes.data);
    const ct = imgRes.headers['content-type'] || 'image/jpeg';
    const filename = guessFilenameFromUrl(imageUrl, ct);
    mediaId = await uploadImageBufferToWhatsApp(buf, filename, ct);
    db.upsertMediaCache(imageUrl, mediaId);
  }
  const cap =
    caption && caption.length > WA_CAPTION_MAX ? caption.slice(0, WA_CAPTION_MAX) : caption || undefined;
  await graphSendMessage({
    to,
    type: 'image',
    image: cap ? { id: mediaId, caption: cap } : { id: mediaId },
  });
}

async function sendWhatsAppText(to, body) {
  await graphSendMessage({
    to,
    type: 'text',
    text: { body: body.slice(0, WA_TEXT_MAX) },
  });
}

async function sendWhatsAppImageByLink(to, imageUrl, caption) {
  const cap =
    caption && caption.length > WA_CAPTION_MAX ? caption.slice(0, WA_CAPTION_MAX) : caption || undefined;
  await graphSendMessage({
    to,
    type: 'image',
    image: cap ? { link: imageUrl, caption: cap } : { link: imageUrl },
  });
}

async function sendWhatsAppInteractiveButtons(to, bodyText, titles) {
  const buttons = titles.slice(0, WA_MAX_BUTTONS).map((title, i) => ({
    type: 'reply',
    reply: {
      id: `aura_btn_${i}_${Date.now()}`,
      title: title.slice(0, WA_BUTTON_TITLE_MAX),
    },
  }));

  const body = bodyText.slice(0, WA_BODY_MAX);

  await graphSendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons },
    },
  });
}

function stripModelJsonFences(raw) {
  let s = String(raw).trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s);
  if (m) {
    s = m[1].trim();
  }
  return s;
}

function normalizeStructuredReply(obj) {
  const message_text =
    typeof obj.message_text === 'string' ? obj.message_text.trim() : '';
  let image_to_send = obj.image_to_send;
  if (image_to_send !== null && image_to_send !== undefined && typeof image_to_send !== 'string') {
    image_to_send = null;
  }
  if (typeof image_to_send === 'string' && image_to_send.trim() === '') {
    image_to_send = null;
  }

  let buttons = Array.isArray(obj.suggested_buttons) ? obj.suggested_buttons : [];
  buttons = buttons
    .filter((b) => typeof b === 'string')
    .map((b) => b.trim().slice(0, WA_BUTTON_TITLE_MAX))
    .filter(Boolean)
    .slice(0, WA_MAX_BUTTONS);

  return {
    message_text: message_text || '…',
    image_to_send,
    suggested_buttons: buttons,
  };
}

function parseStructuredReplyFromModel(rawText) {
  const stripped = stripModelJsonFences(rawText);
  const obj = JSON.parse(stripped);
  return normalizeStructuredReply(obj);
}

async function deliverStructuredAuraReply(to, geminiRawText) {
  let parsed;
  try {
    parsed = parseStructuredReplyFromModel(geminiRawText);
  } catch (err) {
    log('warn', 'Gemini JSON parse failed', { message: err.message });
    await sendWhatsAppText(to, GEMINI_JSON_FALLBACK);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: GEMINI_JSON_FALLBACK,
      metaMessageId: null,
    });
    db.insertChatMessage(to, 'model', GEMINI_JSON_FALLBACK, Date.now());
    return;
  }

  const { message_text, image_to_send, suggested_buttons } = parsed;
  const caption = message_text.slice(0, WA_CAPTION_MAX);
  const sentImage = Boolean(image_to_send);

  if (sentImage) {
    try {
      await sendWhatsAppImageWithCache(to, image_to_send, caption);
    } catch (err) {
      log('warn', 'Cached media upload failed; falling back to image link', { message: err.message });
      await sendWhatsAppImageByLink(to, image_to_send, caption);
    }
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[image] ${image_to_send} | ${caption}`,
      metaMessageId: null,
    });
  }

  if (suggested_buttons.length > 0) {
    const interactiveBody = sentImage ? 'Choose an option:' : message_text.slice(0, WA_BODY_MAX);
    await sendWhatsAppInteractiveButtons(to, interactiveBody, suggested_buttons);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[buttons] ${interactiveBody} | ${suggested_buttons.join(' | ')}`,
      metaMessageId: null,
    });
  } else if (!sentImage) {
    await sendWhatsAppText(to, message_text);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: message_text,
      metaMessageId: null,
    });
  }

  db.insertChatMessage(to, 'model', message_text, Date.now());
}

function extractInboundFromMessage(message) {
  const from = message.from;
  if (!from) {
    return null;
  }

  if (message.type === 'text' && message.text?.body) {
    return {
      from,
      kind: 'text',
      text: message.text.body,
      metaMessageId: message.id || null,
    };
  }

  if (message.type === 'audio' && message.audio?.id) {
    const rawMime = message.audio.mime_type || 'audio/ogg';
    const mimeType = String(rawMime).split(';')[0].trim() || 'audio/ogg';
    return {
      from,
      kind: 'audio',
      audioMediaId: message.audio.id,
      mimeType,
      metaMessageId: message.id || null,
    };
  }

  if (message.type === 'interactive') {
    const ir = message.interactive;
    if (ir?.type === 'button_reply' && ir.button_reply) {
      const title = ir.button_reply.title || '';
      const text = title
        ? `The customer chose the quick reply: "${title}". Continue the conversation naturally.`
        : 'The customer tapped a quick reply. Continue the conversation naturally.';
      return { from, kind: 'text', text, metaMessageId: message.id || null };
    }
    return {
      from,
      kind: 'unsupported',
      unsupportedType: `interactive:${ir?.type || 'unknown'}`,
      metaMessageId: message.id || null,
    };
  }

  return {
    from,
    kind: 'unsupported',
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
  const { from, kind, metaMessageId } = inbound;

  const logBody =
    kind === 'text'
      ? inbound.text
      : kind === 'audio'
        ? `[audio:${inbound.audioMediaId}]`
        : `[unsupported:${inbound.unsupportedType}]`;

  db.logMessage({
    waId: from,
    direction: 'in',
    body: logBody,
    metaMessageId,
  });

  if (kind === 'text' && inbound.text) {
    const emails = extractEmails(inbound.text);
    for (const email of emails) {
      db.insertLead({
        waId: from,
        email,
        rawSnippet:
          inbound.text.length > 500 ? inbound.text.slice(0, 500) : inbound.text,
      });
      await notifyLeadWebhook({
        type: 'lead_email',
        wa_id: from,
        email,
        captured_at: new Date().toISOString(),
      });
    }
  }

  if (kind === 'unsupported' || kind === undefined) {
    log('info', 'Inbound unsupported message; sending short fallback', {
      from_tail: from.slice(-4),
      type: inbound.unsupportedType,
    });
    const fallback =
      'Thank you for your message. Please send a text note or voice note and Aura will assist you.';
    await sendWhatsAppText(from, fallback);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: fallback,
      metaMessageId: null,
    });
    return;
  }

  let userTextForRag = '';
  let audioBase64 = null;
  let audioMimeType = 'audio/ogg';

  if (kind === 'audio') {
    try {
      const audioBuf = await downloadWhatsAppMediaBuffer(inbound.audioMediaId);
      audioBase64 = audioBuf.toString('base64');
      audioMimeType = inbound.mimeType || 'audio/ogg';
    } catch (err) {
      log('error', 'Failed to download voice note from Meta', { message: err.message });
      const apology =
        'We could not download your voice note. Please try again or send a text message.';
      await sendWhatsAppText(from, apology);
      db.logMessage({
        waId: from,
        direction: 'out',
        body: apology,
        metaMessageId: null,
      });
      return;
    }
    userTextForRag = '';
  } else {
    userTextForRag = inbound.text || '';
  }

  const lastUserTs = db.getLastUserInboundTimestamp(from);
  const now = Date.now();
  if (lastUserTs != null && now - lastUserTs > TWENTY_FOUR_H_MS) {
    try {
      await sendTemplateReengagement(from);
      log('info', '24h policy: sent reengagement template (no Gemini)', {
        from_tail: from.slice(-4),
        gap_hours: ((now - lastUserTs) / (60 * 60 * 1000)).toFixed(1),
      });
    } catch (err) {
      log('error', 'reengagement template failed', {
        message: err.message,
        data: err.response?.data,
      });
      const apology =
        'Welcome back — please send a short message to continue with Aura.';
      await sendWhatsAppText(from, apology);
    }
    const userRowText = kind === 'audio' ? VOICE_NOTE_PLACEHOLDER : userTextForRag;
    db.insertChatMessage(from, 'user', userRowText, now);
    return;
  }

  const userRowText = kind === 'audio' ? VOICE_NOTE_PLACEHOLDER : userTextForRag;
  db.insertChatMessage(from, 'user', userRowText, now);

  let fullCatalog;
  try {
    fullCatalog = loadCatalog();
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

  const ragCatalog = buildRagCatalog(fullCatalog, userTextForRag);
  const historyRows = db.fetchRecentChatMessages(from, CHAT_HISTORY_LIMIT);
  const contents = buildGeminiContents(historyRows, {
    audioBase64,
    audioMimeType,
  });

  let geminiRaw;
  try {
    geminiRaw = await generateStructuredReply(contents, ragCatalog);
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
    db.insertChatMessage(from, 'model', apology, Date.now());
    return;
  }

  await deliverStructuredAuraReply(from, geminiRaw);
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
