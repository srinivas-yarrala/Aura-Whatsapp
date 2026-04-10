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
const META_APP_SECRET = String(process.env.META_APP_SECRET || '').trim();
const INR_PER_USD = Number(process.env.INR_PER_USD) || 83;
const SKIP_WEBHOOK_SIGNATURE =
  process.env.SKIP_WEBHOOK_SIGNATURE === '1' ||
  process.env.SKIP_WEBHOOK_SIGNATURE === 'true';
const LEAD_NOTIFY_WEBHOOK_URL = process.env.LEAD_NOTIFY_WEBHOOK_URL || '';
const DATABASE_PATH =
  (process.env.DATABASE_PATH && String(process.env.DATABASE_PATH).trim()) ||
  path.join(__dirname, 'data', 'aura.db');
const WA_REENGAGEMENT_TEMPLATE =
  process.env.WA_REENGAGEMENT_TEMPLATE ||
  process.env.WA_REENGAGEMENT_TEMPLATES ||
  'reengagement_ping';
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'en';

const CATALOG_PATH = path.join(__dirname, 'catalog.json');
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
/** Meta Commerce catalog linked to the WABA (or set WA_CATALOG_ID to skip lookup). */
const WA_CATALOG_ID = String(process.env.WA_CATALOG_ID || '').trim();
/** WhatsApp Business Account ID — used to GET /{WABA_ID}/product_catalogs */
const WA_BUSINESS_ACCOUNT_ID = String(process.env.WA_BUSINESS_ACCOUNT_ID || '').trim();
const WA_PRODUCT_FOOTER_MAX = 60;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const TWENTY_FOUR_H_MS = 24 * 60 * 60 * 1000;
const CHAT_HISTORY_LIMIT = 10;

/** WhatsApp Cloud API limits */
const WA_CAPTION_MAX = 1024;
const WA_BODY_MAX = 1024;
const WA_TEXT_MAX = 4096;
const WA_BUTTON_TITLE_MAX = 20;
const WA_MAX_BUTTONS = 3;
const PRODUCT_GALLERY_MAX = 3;
const PRODUCT_CAROUSEL_BUTTONS = ['Show More', 'Filter', 'Buy Now'];
const PRODUCT_CAROUSEL_BODY = 'Choose an option:';

/** Normalized from WhatsApp button_reply.title in extractInboundFromMessage. */
const WA_BUTTON_ACTION = {
  SHOW_MORE: 'show_more',
  BUY_NOW: 'buy_now',
  VIEW_DETAILS: 'view_details',
  FILTER: 'filter',
};

const BUY_NOW_ASK_NAME = 'What is your full name?';
const BUY_NOW_ASK_PHONE =
  'Thank you. What phone number should we use (include country code)?';
const BUY_NOW_ASK_ADDRESS = 'Almost done. What is your full shipping address?';
const BUY_NOW_EMPTY_PROMPT = 'Please send a short text reply so we can save your details.';

const VIEW_DETAILS_NO_CONTEXT =
  'Browse our picks first — then tap View Details for the spotlight piece — or tell us which item you mean.';

/** Static menu when user says hi/hello or opens the chat; no Gemini. */
const GREETING_MENU_BUTTONS = ['Shop Collection', 'New Arrivals', 'Under ₹5000'];
const GREETING_MENU_BODY = 'Welcome to Aura! Tap an option below.';

/** Shop Collection → interactive list (row ids used in webhooks + RAG filter). */
const COLLECTION_CATEGORY_ROWS = [
  { id: 'aura_cat_dresses', title: 'Dresses', description: 'Gowns & formal dresses' },
  { id: 'aura_cat_ethnic', title: 'Ethnic Wear', description: 'Traditional pieces' },
  { id: 'aura_cat_casual', title: 'Casual', description: 'Everyday & relaxed' },
  { id: 'aura_cat_party', title: 'Party Wear', description: 'Evening & celebrations' },
];
const LIST_ROW_IDS = new Set(COLLECTION_CATEGORY_ROWS.map((r) => r.id));
const SHOP_COLLECTION_BUTTON_TITLE = 'Shop Collection';
const SHOP_COLLECTION_LIST_HEADER = 'Shop Collection';
const SHOP_COLLECTION_LIST_BODY = 'Tap the button below, then pick a category.';
const SHOP_COLLECTION_LIST_BUTTON = 'See categories';
const SHOP_COLLECTION_LIST_SECTION = 'Categories';

const GEMINI_JSON_FALLBACK =
  'Sorry — something went wrong formatting our reply. Please send your message again or say what you need help with.';

const VOICE_NOTE_PLACEHOLDER = '[Voice note]';

/** JSON schema for Gemini structured output (responseMimeType application/json). */
const AURA_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message_text: {
      type: 'string',
      description:
        'At most 2 short lines; minimal prose. Put choices and CTAs in suggested_buttons, not long text.',
    },
    image_to_send: {
      description:
        'Exact catalog image_url when recommending or spotlighting a product that has one (visual first); primary product if several; otherwise null.',
      anyOf: [{ type: 'string' }, { type: 'null' }],
    },
    suggested_buttons: {
      type: 'array',
      description:
        'Prefer buttons over long text: next steps, options, sizes, colors. Up to 3 titles, max 20 characters each.',
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

log('info', 'SQLite initialized', { path: DATABASE_PATH });

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

function productHaystack(p) {
  return `${p.name || ''} ${p.description || ''} ${p.stylist_note || ''} ${p.category || ''} ${p.material || ''}`.toLowerCase();
}

/**
 * Hard filters on catalog products. Omitted / null fields do not filter.
 * @param {object[]} products
 * @param {{ category?: string|null, priceRange?: { minInr?: number, maxInr?: number }|null, keyword?: string|null }} opts
 */
function filterProducts(products, { category = null, priceRange = null, keyword = null } = {}) {
  let list = Array.isArray(products) ? [...products] : [];

  if (category != null && String(category).trim()) {
    const c = String(category).trim();
    if (LIST_ROW_IDS.has(c)) {
      list = list.filter((p) => productMatchesListCategory(c, p));
    } else {
      const cl = c.toLowerCase();
      list = list.filter((p) => {
        const pc = String(p.category || '').toLowerCase();
        if (pc === cl) {
          return true;
        }
        if (pc.includes(cl) || cl.includes(pc)) {
          return true;
        }
        return productHaystack(p).includes(cl);
      });
    }
  }

  if (priceRange != null && typeof priceRange === 'object') {
    const minInr = priceRange.minInr;
    const maxInr = priceRange.maxInr;
    const hasMin = minInr != null && Number.isFinite(Number(minInr));
    const hasMax = maxInr != null && Number.isFinite(Number(maxInr));
    if (hasMin || hasMax) {
      const lo = hasMin ? Number(minInr) : -Infinity;
      const hi = hasMax ? Number(maxInr) : Infinity;
      list = list.filter((p) => {
        const pr = Number(p.priceInr);
        if (!Number.isFinite(pr)) {
          return false;
        }
        return pr >= lo && pr <= hi;
      });
    }
  }

  if (keyword != null && String(keyword).trim()) {
    const q = String(keyword).toLowerCase().trim();
    const tokens = tokenizeQuery(keyword);
    list = list.filter((p) => {
      const hay = productHaystack(p);
      if (q.length > 0 && hay.includes(q)) {
        return true;
      }
      if (tokens.length === 0) {
        return true;
      }
      return tokens.some((t) => hay.includes(t));
    });
  }

  return list;
}

function keywordRelevanceScore(product, userText) {
  const hay = productHaystack(product);
  const q = String(userText || '').toLowerCase().trim();
  const tokens = tokenizeQuery(userText);
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) {
      score += 2;
    }
  }
  if (q.length > 0 && hay.includes(q)) {
    score += 5;
  }
  return score;
}

/** Order filtered results; does not drop rows. sortMode 'catalog' keeps JSON order among filtered. */
function orderFilteredProducts(filtered, fullCatalogProducts, userText, sortMode) {
  const list = [...filtered];
  if (sortMode === 'catalog') {
    const order = new Map(
      (Array.isArray(fullCatalogProducts) ? fullCatalogProducts : []).map((p, i) => [p.id, i]),
    );
    list.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    return list;
  }
  list.sort((a, b) => keywordRelevanceScore(b, userText) - keywordRelevanceScore(a, userText));
  return list;
}

function parseRupeeAmountFragment(raw) {
  if (raw == null) {
    return null;
  }
  const s0 = String(raw).trim().toLowerCase();
  const mult = /\bk\b/.test(s0) ? 1000 : 1;
  const digits = s0.replace(/[^\d]/g, '');
  if (!digits) {
    return null;
  }
  const n = parseInt(digits, 10) * mult;
  return Number.isFinite(n) ? n : null;
}

function extractUserKeywordPhrase(userText) {
  let s = String(userText || '').trim();
  const quick = s.match(/\[Quick reply:\s*\w+\]\s*(.+)/i);
  if (quick) {
    s = quick[1].trim();
  }
  const qr = s.match(/quick reply:\s*"([^"]+)"/i);
  if (qr) {
    const inner = qr[1].trim();
    if (!/^shop collection$/i.test(inner) && !/^new arrivals$/i.test(inner) && !/^under\s*₹?/i.test(inner)) {
      return inner.length > 1 ? inner : null;
    }
  }
  s = s.replace(/The customer chose the quick reply:\s*"[^"]*"\.\s*/gi, '');
  s = s.replace(/The customer selected\s+"[^"]*"\s+from the Shop Collection[^\n]*/gi, '');
  s = s.replace(/Continue the conversation naturally\.?/gi, '');
  s = s.replace(/Recommend from the filtered catalog[^\n]*/gi, '');
  s = s.replace(/Guide next steps\.?/gi, '');
  s = s.trim();
  if (s.length < 2) {
    return null;
  }
  return s;
}

/**
 * Derive filterProducts({ category, priceRange, keyword }) from user text + optional list row id.
 */
function inferProductFilters(userText, categoryListRowId = null) {
  const text = String(userText || '');
  const lower = text.toLowerCase();

  let category =
    categoryListRowId && LIST_ROW_IDS.has(categoryListRowId) ? categoryListRowId : null;
  if (!category) {
    for (const row of COLLECTION_CATEGORY_ROWS) {
      if (lower.includes(row.title.toLowerCase())) {
        category = row.id;
        break;
      }
    }
  }

  let priceRange = null;
  if (text.includes('Under ₹5000') || /under\s*₹?\s*5\s*,?\s*000\b/i.test(text) || /\bunder\s+5000\b/i.test(lower)) {
    priceRange = { maxInr: 5000 };
  }
  const underM =
    text.match(/under\s*₹\s*([\d,\s]+[kK]?)/i) ||
    text.match(/under\s+([\d,\s]+[kK]?)\s*(?:inr|rupees|rs\.?)?\b/i) ||
    text.match(/below\s*₹\s*([\d,\s]+[kK]?)/i);
  if (underM) {
    const n = parseRupeeAmountFragment(underM[1]);
    if (n != null) {
      priceRange = { ...(priceRange || {}), maxInr: n };
    }
  }
  const maxM = text.match(/(?:max|maximum|up to|at most)\s*₹\s*([\d,\s]+[kK]?)/i);
  if (maxM) {
    const n = parseRupeeAmountFragment(maxM[1]);
    if (n != null) {
      priceRange = { ...(priceRange || {}), maxInr: n };
    }
  }
  const minM = text.match(/(?:above|over|from|min|minimum)\s*₹\s*([\d,\s]+[kK]?)/i);
  if (minM) {
    const n = parseRupeeAmountFragment(minM[1]);
    if (n != null) {
      priceRange = { ...(priceRange || {}), minInr: n };
    }
  }

  let sortMode = 'relevance';
  if (/new arrivals/i.test(text)) {
    sortMode = 'catalog';
  }

  let keyword = extractUserKeywordPhrase(text);
  if (keyword && (/^shop collection$/i.test(keyword) || /^new arrivals$/i.test(keyword))) {
    keyword = null;
  }

  return { category, priceRange, keyword, sortMode };
}

function productMatchesListCategory(rowId, product) {
  const hay = `${product.name || ''} ${product.description || ''} ${product.stylist_note || ''} ${product.category || ''}`.toLowerCase();
  const cat = (product.category || '').toLowerCase();
  switch (rowId) {
    case 'aura_cat_dresses':
      return /\b(dress|gown)\b/.test(hay) || cat === 'evening';
    case 'aura_cat_ethnic':
      return /ethnic|saree|sari|kurta|lehenga|anarkali|traditional/.test(hay);
    case 'aura_cat_casual':
      return (
        /\bcasual\b/.test(hay) ||
        /\beveryday\b/.test(hay) ||
        /\blounge\b/.test(hay) ||
        cat === 'footwear' ||
        cat === 'tailoring' ||
        cat === 'outerwear'
      );
    case 'aura_cat_party':
      return (
        /\b(party|formal|gala|prom)\b/.test(hay) ||
        /black[-\s]?tie/.test(hay) ||
        cat === 'evening' ||
        /\bgown\b/.test(hay)
      );
    default:
      return false;
  }
}

function buildRagCatalog(fullCatalog, userText, categoryListRowId = null) {
  const pool = Array.isArray(fullCatalog.products) ? fullCatalog.products : [];
  const inferred = inferProductFilters(userText, categoryListRowId);
  const filtered = filterProducts(pool, {
    category: inferred.category,
    priceRange: inferred.priceRange,
    keyword: inferred.keyword,
  });
  const ordered = orderFilteredProducts(filtered, pool, userText, inferred.sortMode);
  const products = ordered.slice(0, 3);
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
- Avoid long descriptions: no dense paragraphs or exhaustive spec lists in prose; keep copy minimal.
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
  "message_text": "Very short reply: at most 2 lines. Put choices and next steps in suggested_buttons, not in long text.",
  "image_to_send": "Exact image_url from the catalog for the product you are showing; whenever you recommend or spotlight an in-catalog product that has image_url, set this (primary recommendation if several); otherwise null",
  "suggested_buttons": ["Button 1", "Button 2"]
}
Rules for OUTPUT:
- message_text: hard limit 2 lines (short sentences); no long descriptions, bullet walls, or repeated catalog copy. Prefer buttons for options, sizes, colors, and CTAs.
- suggested_buttons: at most ${WA_MAX_BUTTONS} items; each string at most ${WA_BUTTON_TITLE_MAX} characters (WhatsApp hard limit). Prefer buttons over text whenever the user can tap a clear action or choice.
- image_to_send: always set to the exact image_url from the catalog JSON when your reply features or recommends a product that has image_url (visual first); use the primary product's URL if one hero; otherwise null only when no product image applies.

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

async function graphCommerceGet(relPath, extraParams = {}) {
  if (!WA_ACCESS_TOKEN) {
    throw new Error('WA_ACCESS_TOKEN is not set');
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${relPath}`;
  const { data } = await axios.get(url, {
    params: { access_token: WA_ACCESS_TOKEN, ...extraParams },
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  return data;
}

/**
 * Resolves catalog_id: env WA_CATALOG_ID, else first catalog from GET /{WABA}/product_catalogs.
 * @returns {Promise<string|null>}
 */
async function fetchWhatsAppCatalogId() {
  if (WA_CATALOG_ID) {
    return WA_CATALOG_ID;
  }
  if (!WA_BUSINESS_ACCOUNT_ID) {
    return null;
  }
  const data = await graphCommerceGet(`${WA_BUSINESS_ACCOUNT_ID}/product_catalogs`, {
    fields: 'id,name',
  });
  const id = data?.data?.[0]?.id;
  return id != null ? String(id) : null;
}

/**
 * Maps JSON catalog product → Meta product_retailer_id (must match Commerce Manager / catalog item).
 * Prefer wa_product_retailer_id when JSON id differs from the synced SKU.
 */
function mapCatalogProductToRetailerId(product) {
  if (!product || typeof product !== 'object') {
    return null;
  }
  const explicit =
    product.wa_product_retailer_id ??
    product.product_retailer_id ??
    product.retailer_id ??
    null;
  if (explicit != null && String(explicit).trim()) {
    return String(explicit).trim();
  }
  if (product.id != null && String(product.id).trim()) {
    return String(product.id).trim();
  }
  return null;
}

/**
 * Single-product interactive message (Commerce catalog).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services/share-products/
 */
async function sendWhatsAppProductMessage(to, { catalogId, productRetailerId, bodyText, footerText }) {
  if (!catalogId || !productRetailerId) {
    throw new Error('sendWhatsAppProductMessage requires catalogId and productRetailerId');
  }
  const interactive = {
    type: 'product',
    body: {
      text: String(bodyText || 'View this product').slice(0, WA_BODY_MAX),
    },
    action: {
      catalog_id: String(catalogId),
      product_retailer_id: String(productRetailerId),
    },
  };
  if (footerText != null && String(footerText).trim()) {
    interactive.footer = { text: String(footerText).slice(0, WA_PRODUCT_FOOTER_MAX) };
  }
  await graphSendMessage({
    to,
    recipient_type: 'individual',
    type: 'interactive',
    interactive,
  });
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

async function sendShopCollectionCategoryList(to) {
  const rows = COLLECTION_CATEGORY_ROWS.map((r) => ({
    id: r.id.slice(0, 200),
    title: r.title.slice(0, 24),
    description: r.description.slice(0, 72),
  }));

  await graphSendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: SHOP_COLLECTION_LIST_HEADER.slice(0, 60) },
      body: { text: SHOP_COLLECTION_LIST_BODY.slice(0, WA_BODY_MAX) },
      action: {
        button: SHOP_COLLECTION_LIST_BUTTON.slice(0, 20),
        sections: [
          {
            title: SHOP_COLLECTION_LIST_SECTION.slice(0, 24),
            rows,
          },
        ],
      },
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

function formatProductPriceLine(priceInr) {
  const n = Number(priceInr);
  if (!Number.isFinite(n)) {
    return 'Price on request';
  }
  return `₹${n.toLocaleString('en-IN')}`;
}

function buildProductCarouselCaption(product) {
  const name = String(product?.name || product?.id || 'Product').trim() || 'Product';
  const priceLine = formatProductPriceLine(product?.priceInr);
  const cap = `${name} + ${priceLine}`;
  return cap.length > WA_CAPTION_MAX ? cap.slice(0, WA_CAPTION_MAX) : cap;
}

function mapButtonReplyToAction(buttonTitle) {
  const t = String(buttonTitle || '').trim();
  if (t === 'Show More') {
    return WA_BUTTON_ACTION.SHOW_MORE;
  }
  if (t === 'Buy Now') {
    return WA_BUTTON_ACTION.BUY_NOW;
  }
  if (t === 'View Details') {
    return WA_BUTTON_ACTION.VIEW_DETAILS;
  }
  if (t === 'Filter') {
    return WA_BUTTON_ACTION.FILTER;
  }
  return null;
}

function listProductsWithImagesInRagOrder(ragCatalog) {
  const products = Array.isArray(ragCatalog?.products) ? ragCatalog.products : [];
  return products.filter((p) => p && typeof p.image_url === 'string' && p.image_url.trim());
}

function pickProductsWithImages(ragCatalog, max) {
  return listProductsWithImagesInRagOrder(ragCatalog).slice(0, max);
}

function findProductById(catalog, id) {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const sid = String(id || '');
  return products.find((p) => p && String(p.id) === sid) || null;
}

function resolveProductIdsToObjects(catalog, ids) {
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.map((id) => findProductById(catalog, id)).filter(Boolean);
}

function listCatalogProductsWithImagesInOrder(catalog) {
  return listProductsWithImagesInRagOrder({ products: catalog?.products || [] });
}

function formatProductDetailsMessage(product) {
  if (!product) {
    return VIEW_DETAILS_NO_CONTEXT;
  }
  const lines = [
    String(product.name || product.id || 'Product').trim(),
    formatProductPriceLine(product.priceInr),
  ];
  if (Array.isArray(product.sizes) && product.sizes.length > 0) {
    lines.push(`Sizes: ${product.sizes.join(', ')}`);
  }
  if (Array.isArray(product.colors) && product.colors.length > 0) {
    lines.push(`Colors: ${product.colors.join(', ')}`);
  }
  if (product.description) {
    lines.push(String(product.description).trim());
  }
  return lines.filter(Boolean).join('\n').slice(0, WA_TEXT_MAX);
}

function buyNowConfirmationMessage(fullName) {
  const n = String(fullName || 'there').trim().slice(0, 80) || 'there';
  return `Thanks, ${n}! We have your details. Our team will follow up shortly to confirm your order.`;
}

async function handleBuyNowLeadCapture(to) {
  db.upsertBuyNowFlow(to, { step: 'await_name', draftName: null, draftPhone: null });
  const msg = BUY_NOW_ASK_NAME.slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(to, msg);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: msg,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', msg, Date.now());
}

async function handleBuyNowFlowReply(from, rawText) {
  const flow = db.getBuyNowFlow(from);
  if (!flow) {
    return;
  }
  const text = String(rawText || '').trim();
  if (!text) {
    const prompt = BUY_NOW_EMPTY_PROMPT.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, prompt);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: prompt,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', prompt, Date.now());
    return;
  }

  if (flow.step === 'await_name') {
    db.upsertBuyNowFlow(from, { step: 'await_phone', draftName: text, draftPhone: null });
    const next = BUY_NOW_ASK_PHONE.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, next);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: next,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', next, Date.now());
    return;
  }

  if (flow.step === 'await_phone') {
    db.upsertBuyNowFlow(from, {
      step: 'await_address',
      draftName: flow.draftName,
      draftPhone: text,
    });
    const next = BUY_NOW_ASK_ADDRESS.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, next);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: next,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', next, Date.now());
    return;
  }

  if (flow.step === 'await_address') {
    const fullName = flow.draftName || '';
    const phone = flow.draftPhone || '';
    const address = text;
    const rawSnippet = `Buy now | ${fullName} | ${phone} | ${address}`.slice(0, 2000);
    db.insertLead({
      waId: from,
      fullName,
      phone,
      address,
      rawSnippet,
    });
    await notifyLeadWebhook({
      type: 'lead_buy_now',
      wa_id: from,
      full_name: fullName,
      phone,
      address,
      captured_at: new Date().toISOString(),
    });
    db.clearBuyNowFlow(from);
    const confirm = buyNowConfirmationMessage(fullName).slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, confirm);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: confirm,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', confirm, Date.now());
  }
}

async function handleShowMoreProducts(to, fullCatalog) {
  let state = db.getBrowseState(to);
  let orderedProductIds;
  let nextIndex;
  if (!state || !state.orderedProductIds?.length) {
    const pool = listCatalogProductsWithImagesInOrder(fullCatalog);
    if (pool.length === 0) {
      const msg = 'No pieces with photos are available right now. Tell us what you are looking for.';
      await sendWhatsAppText(to, msg);
      db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(to, 'model', msg, Date.now());
      return;
    }
    orderedProductIds = pool.map((p) => String(p.id));
    nextIndex = 0;
  } else {
    orderedProductIds = state.orderedProductIds;
    nextIndex = state.nextIndex;
  }

  const orderedProducts = resolveProductIdsToObjects(fullCatalog, orderedProductIds);
  const slice = orderedProducts.slice(nextIndex, nextIndex + PRODUCT_GALLERY_MAX);
  if (slice.length === 0) {
    const msg =
      "That's our full edit for now. Want another category or something specific?";
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }

  await sendProductCarousel(to, slice);
  db.upsertBrowseState(to, {
    orderedProductIds,
    nextIndex: nextIndex + slice.length,
    lastWindowStart: nextIndex,
  });
  const modelNote = `[show_more] ${slice.map((p) => p.name || p.id).join(' | ')}`;
  db.insertChatMessage(to, 'model', modelNote, Date.now());
}

async function handleViewProductDetails(to, fullCatalog) {
  const state = db.getBrowseState(to);
  const idx = state?.lastWindowStart ?? 0;
  const id = state?.orderedProductIds?.[idx];
  const product = id ? findProductById(fullCatalog, id) : null;
  const text = formatProductDetailsMessage(product);
  await sendWhatsAppText(to, text);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: text,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', text, Date.now());
}

async function sendCategoryFilterListAndLog(to) {
  await sendShopCollectionCategoryList(to);
  const outLog = `[list-sent] ${SHOP_COLLECTION_LIST_BODY} | ${COLLECTION_CATEGORY_ROWS.map((r) => r.title).join(' | ')}`;
  db.logMessage({
    waId: to,
    direction: 'out',
    body: outLog,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', SHOP_COLLECTION_LIST_BODY, Date.now());
}

async function sendOneProductImage(to, imageUrl, caption) {
  try {
    await sendWhatsAppImageWithCache(to, imageUrl, caption);
  } catch (err) {
    log('warn', 'Cached media upload failed; falling back to image link', { message: err.message });
    await sendWhatsAppImageByLink(to, imageUrl, caption);
  }
}

/**
 * For each product (with image_url, max PRODUCT_GALLERY_MAX): send image with caption "Name + Price".
 * Then send interactive buttons: Show More, Filter, Buy Now.
 */
async function sendProductCarousel(to, products) {
  const list = Array.isArray(products) ? products : [];
  const withImages = list
    .filter((p) => p && typeof p.image_url === 'string' && p.image_url.trim())
    .slice(0, PRODUCT_GALLERY_MAX);
  if (withImages.length === 0) {
    return;
  }
  for (const p of withImages) {
    const url = p.image_url.trim();
    const caption = buildProductCarouselCaption(p);
    await sendOneProductImage(to, url, caption);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[image] ${url} | ${caption}`,
      metaMessageId: null,
    });
  }
  const interactiveBody = PRODUCT_CAROUSEL_BODY.slice(0, WA_BODY_MAX);
  await sendWhatsAppInteractiveButtons(to, interactiveBody, PRODUCT_CAROUSEL_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${interactiveBody} | ${PRODUCT_CAROUSEL_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });
}

async function deliverStructuredAuraReply(to, geminiRawText, ragCatalog) {
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
  const galleryProducts = pickProductsWithImages(ragCatalog, PRODUCT_GALLERY_MAX);

  if (galleryProducts.length > 0) {
    const fullRagWithImages = listProductsWithImagesInRagOrder(ragCatalog);
    const orderedProductIds = fullRagWithImages.map((p) => String(p.id));
    await sendProductCarousel(to, galleryProducts);
    db.upsertBrowseState(to, {
      orderedProductIds,
      nextIndex: Math.min(PRODUCT_GALLERY_MAX, fullRagWithImages.length),
      lastWindowStart: 0,
    });
    db.insertChatMessage(to, 'model', message_text, Date.now());
    return;
  }

  const caption = message_text.slice(0, WA_CAPTION_MAX);
  const sentImage = Boolean(image_to_send);

  if (sentImage) {
    await sendOneProductImage(to, image_to_send, caption);
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
      const buttonTitle = String(ir.button_reply.title || '').trim();
      return {
        from,
        kind: 'button_reply',
        buttonTitle,
        buttonAction: mapButtonReplyToAction(buttonTitle),
        metaMessageId: message.id || null,
      };
    }
    if (ir?.type === 'list_reply' && ir.list_reply) {
      return {
        from,
        kind: 'list_reply',
        listRowId: String(ir.list_reply.id || '').trim(),
        listTitle: String(ir.list_reply.title || '').trim(),
        metaMessageId: message.id || null,
      };
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

function isHiHelloGreeting(text) {
  const t = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '');
  return t === 'hi' || t === 'hello';
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
        : kind === 'button_reply'
          ? `[button title="${String(inbound.buttonTitle || '').replace(/"/g, "'")}" action=${inbound.buttonAction || 'none'}]`
          : kind === 'list_reply'
            ? `[list:${inbound.listRowId || ''}]`
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
  } else if (kind === 'button_reply') {
    if (inbound.buttonAction) {
      userTextForRag = `[Quick reply: ${inbound.buttonAction}] ${inbound.buttonTitle || ''}`;
    } else {
      userTextForRag = inbound.buttonTitle
        ? `The customer chose the quick reply: "${inbound.buttonTitle}". Continue the conversation naturally.`
        : 'The customer tapped a quick reply. Continue the conversation naturally.';
    }
  } else if (kind === 'list_reply') {
    const label = inbound.listTitle || inbound.listRowId || 'a category';
    userTextForRag = `The customer selected "${label}" from the Shop Collection category list. Recommend from the filtered catalog products shown in context (if the list is empty, offer waitlist or alternatives). Guide next steps.`;
  } else {
    userTextForRag = inbound.text || '';
  }

  const userRowText =
    kind === 'audio'
      ? VOICE_NOTE_PLACEHOLDER
      : kind === 'button_reply'
        ? `[button] ${inbound.buttonTitle || ''}`
        : kind === 'list_reply'
          ? `[list] ${inbound.listTitle || inbound.listRowId || ''}`
          : userTextForRag;

  const activeBuyNowFlow = kind === 'text' && db.getBuyNowFlow(from);

  const lastUserTs = db.getLastUserInboundTimestamp(from);
  const now = Date.now();
  if (!activeBuyNowFlow && lastUserTs != null && now - lastUserTs > TWENTY_FOUR_H_MS) {
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
    db.insertChatMessage(from, 'user', userRowText, now);
    return;
  }

  const hadNoPriorChat = db.fetchRecentChatMessages(from, 1).length === 0;
  db.insertChatMessage(from, 'user', userRowText, now);

  if (activeBuyNowFlow) {
    await handleBuyNowFlowReply(from, kind === 'text' ? inbound.text : '');
    return;
  }

  const useStaticGreetingMenu =
    hadNoPriorChat || (kind === 'text' && isHiHelloGreeting(userTextForRag));

  if (useStaticGreetingMenu) {
    await sendWhatsAppInteractiveButtons(from, GREETING_MENU_BODY, GREETING_MENU_BUTTONS);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: `[buttons] ${GREETING_MENU_BODY} | ${GREETING_MENU_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', GREETING_MENU_BODY, Date.now());
    return;
  }

  if (
    kind === 'button_reply' &&
    (inbound.buttonTitle === SHOP_COLLECTION_BUTTON_TITLE ||
      inbound.buttonAction === WA_BUTTON_ACTION.FILTER)
  ) {
    await sendCategoryFilterListAndLog(from);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.BUY_NOW) {
    await handleBuyNowLeadCapture(from);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.SHOW_MORE) {
    let fullCatalogSm;
    try {
      fullCatalogSm = loadCatalog();
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
    await handleShowMoreProducts(from, fullCatalogSm);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.VIEW_DETAILS) {
    let fullCatalogVd;
    try {
      fullCatalogVd = loadCatalog();
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
    await handleViewProductDetails(from, fullCatalogVd);
    return;
  }

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

  const categoryListRowId =
    kind === 'list_reply' && inbound.listRowId && LIST_ROW_IDS.has(inbound.listRowId)
      ? inbound.listRowId
      : null;

  const ragCatalog = buildRagCatalog(fullCatalog, userTextForRag, categoryListRowId);
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

  await deliverStructuredAuraReply(from, geminiRaw, ragCatalog);
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
