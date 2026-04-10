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
const POST_CAROUSEL_EXPLORE_BODY = 'Keep exploring:';
const POST_CAROUSEL_BUTTONS = ['Show Similar', 'Under ₹3000', 'Different Style'];
const UNDER_3K_CAP_INR = 3000;
/** Shown under each carousel image; Select/Details use reply ids for full product_id (title max 20 chars). */
const PRODUCT_CAROUSEL_ITEM_BODY = 'This piece:';
/** Max length for WhatsApp reply button id (payload). */
const WA_REPLY_BUTTON_ID_MAX = 256;

/**
 * When true (default), send catalog images via public URL (Meta fetches). Much faster than download + re-upload.
 * Set to 0/false if your image hosts block Meta or links fail.
 */
const WA_IMAGE_PREFER_LINK =
  process.env.WA_IMAGE_PREFER_LINK !== '0' && process.env.WA_IMAGE_PREFER_LINK !== 'false';

/** Normalized from WhatsApp button_reply.title in extractInboundFromMessage. */
const WA_BUTTON_ACTION = {
  SHOW_MORE: 'show_more',
  BUY_NOW: 'buy_now',
  VIEW_DETAILS: 'view_details',
  FILTER: 'filter',
  SHOW_SIMILAR: 'show_similar',
  UNDER_3K: 'under_3k',
  DIFFERENT_STYLE: 'different_style',
  CONFIRM_PURCHASE: 'confirm_purchase',
  CHANGE_PURCHASE_SIZE: 'change_purchase_size',
  CHANGE_PURCHASE_PRODUCT: 'change_purchase_product',
  HELP_CHOOSE: 'help_choose',
  START_OVER: 'start_over',
  BROWSE_CATEGORIES: 'browse_categories',
  CONTINUE_LAST_SHOP: 'continue_last_shop',
  START_FRESH_PERSONALIZED: 'start_fresh_personalized',
};

const BUY_NOW_ASK_NAME = 'What is your full name?';
const BUY_NOW_ASK_PHONE =
  'Thank you. What phone number should we use (include country code)?';
const BUY_NOW_ASK_ADDRESS = 'Almost done. What is your full shipping address?';
const BUY_NOW_EMPTY_PROMPT = 'Please send a short text reply so we can save your details.';
const BUY_NOW_ASK_SIZE_PREFIX = 'What size would you like for';
const BUY_NOW_NEED_SELECT_FIRST =
  'Tap Select under the product you want, then tap Buy Now to review and confirm your order.';
const BUY_NOW_TEXT_ONLY_STEP =
  'Please type your answer as a text message for this step.';
const BUY_CONFIRM_BUTTONS = ['Confirm', 'Change Size', 'Show Similar'];
const BUY_CONFIRM_BUTTONS_BODY = 'Next step:';
const BUY_CHANGE_PRODUCT_BODY =
  'Selection cleared. Scroll to a product, tap Select under its photo, then Buy Now when ready.';
const SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE = 'await_buy_confirm_size';
const SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR = 'await_buy_confirm_color';
const SHOP_FLOW_AWAIT_BUY_CONFIRM = 'await_buy_confirm';
const BUY_SELECT_SIZE_FOR_PRODUCT = 'Select size for this product';

const VIEW_DETAILS_NO_CONTEXT =
  'Browse our picks first — then tap View Details for the spotlight piece — or tell us which item you mean.';

/** Static menu when user says hi/hello or opens the chat; no Gemini. */
const GREETING_MENU_BUTTONS = ['Shop Collection', 'New Arrivals', 'Under ₹5000'];
const GREETING_BUTTON_NEW_ARRIVALS = GREETING_MENU_BUTTONS[1];
const GREETING_BUTTON_UNDER_5K = GREETING_MENU_BUTTONS[2];
const GREETING_MENU_BODY = 'Welcome to Aura! Tap an option below.';
const GREETING_MENU_HELP_ROW_BODY = 'Not sure? We can narrow it down.';
/** Returning shopper: continue with remembered category or clear soft prefs. */
const WELCOME_BACK_PERSONALIZE_BUTTONS = ['Continue', 'Start Fresh'];
/** WhatsApp button title (max 20 chars). */
const HELP_ME_CHOOSE_BUTTON_TITLE = 'Help me choose';
const SHOP_FLOW_HELP_CHOOSE_AWAIT_1 = 'help_choose_await_1';
const SHOP_FLOW_HELP_CHOOSE_AWAIT_2 = 'help_choose_await_2';

/** Shop Collection → interactive list (row ids used in webhooks + RAG filter). */
const COLLECTION_CATEGORY_ROWS = [
  { id: 'aura_cat_dresses', title: 'Dresses', description: 'Gowns & formal dresses' },
  { id: 'aura_cat_ethnic', title: 'Ethnic Wear', description: 'Traditional pieces' },
  { id: 'aura_cat_casual', title: 'Casual', description: 'Everyday & relaxed' },
  { id: 'aura_cat_party', title: 'Party Wear', description: 'Evening & celebrations' },
];
const LIST_ROW_IDS = new Set(COLLECTION_CATEGORY_ROWS.map((r) => r.id));

/** After View Details — WhatsApp allows max 3 reply buttons per message; XL is a second message. */
const PRODUCT_SIZE_BUTTONS_FIRST = ['S', 'M', 'L'];
const PRODUCT_SIZE_BUTTONS_XL = ['XL'];
const PRODUCT_SIZE_BODY = 'Choose your size:';
const PRODUCT_SIZE_BODY_XL = 'Need XL? Tap below.';

const SHOP_COLLECTION_BUTTON_TITLE = 'Shop Collection';
/** Structured shop: category → occasion → size → catalog; color is optional via Filter by Color. */
const STRUCT_SIZE_LIST_BODY = 'Tap your usual size for this category.';
const STRUCT_COLOR_LIST_BODY = 'Pick a color for this edit.';
/** Shown after structured browse when category has colors; max 20 chars for WhatsApp buttons. */
const FILTER_BY_COLOR_BUTTON_TITLE = 'Filter by Color';
const OPTIONAL_COLOR_FILTER_BODY = 'Want to narrow by color?';
const SHOP_OCCASION_STEP_BODY = 'What is the occasion?';
const SHOP_OCCASION_BODY_OFFICE_ROW = 'Or tap below:';
const SHOP_FLOW_AWAIT_OCCASION = 'await_occasion';
const SHOP_FLOW_AWAIT_STYLE = 'await_style';
/** Canonical labels stored in session and matched against product.occasion[]. */
const SHOP_OCCASION_LABELS = ['Party', 'Wedding', 'Casual', 'Office'];
/** Structured shop silhouette (session.style); "Not sure" clears filter. */
const SHOP_STYLE_NOT_SURE = 'Not sure';
const SHOP_STYLE_OPTIONS = ['Bodycon', 'Flowy', 'A-line'];
const SHOP_STYLE_STEP_BODY = 'What silhouette do you prefer?';
const SHOP_STYLE_BODY_NOT_SURE_ROW = 'Or tap below:';

function nextStyleInRotation(currentStyle) {
  const cur = currentStyle && String(currentStyle).trim() ? String(currentStyle).trim() : null;
  if (!cur || !SHOP_STYLE_OPTIONS.includes(cur)) {
    return SHOP_STYLE_OPTIONS[0];
  }
  const i = SHOP_STYLE_OPTIONS.indexOf(cur);
  return SHOP_STYLE_OPTIONS[(i + 1) % SHOP_STYLE_OPTIONS.length];
}
const STRUCT_COLOR_ROWS_MAX = 10;
const SHOP_COLLECTION_CATEGORY_BODY =
  'Pick a category below (tap Shop Collection anytime to restart).';
const SHOP_COLLECTION_CATEGORY_BODY_MORE = 'One more category:';

/** Escape hatch on structured steps (max 20 chars per title). */
const QUICK_REENTRY_BUTTONS = ['Start Over', 'Browse Categories'];
const QUICK_REENTRY_BODY = 'Stuck? Jump here:';
const QUICK_REENTRY_START_OVER_ACK =
  'Fresh start — your picks and checkout draft were cleared. Where to next?';

const GEMINI_JSON_FALLBACK =
  'Sorry — something went wrong formatting our reply. Please send your message again or say what you need help with.';

const VOICE_NOTE_PLACEHOLDER = '[Voice note]';

/**
 * Gemini acts as a decision engine only. The server sends product carousels, lists, and standard CTAs.
 * Valid category_row_id values: aura_cat_dresses | aura_cat_ethnic | aura_cat_casual | aura_cat_party
 */
const AURA_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description:
        'One of: browse, budget, style, shipping, lead, smalltalk, unclear — use browse/budget/style when product matching applies.',
    },
    filters: {
      type: 'object',
      properties: {
        category_row_id: {
          type: 'string',
          description:
            'Shop list row id if it fits: aura_cat_dresses, aura_cat_ethnic, aura_cat_casual, aura_cat_party — otherwise empty string.',
        },
        price_max_inr: {
          type: 'number',
          description: 'Maximum INR budget if user stated one; use 0 if none.',
        },
        price_min_inr: {
          type: 'number',
          description: 'Minimum INR budget if user stated one; use 0 if none.',
        },
        keyword: {
          type: 'string',
          description: 'Short occasion/style tokens to match catalog text; empty string if none.',
        },
      },
      required: ['category_row_id', 'price_max_inr', 'price_min_inr', 'keyword'],
    },
    brief_reply: {
      type: 'string',
      description:
        'At most one short sentence for warmth; do not list products or prices — the app shows cards.',
    },
    suggested_buttons: {
      type: 'array',
      description: 'Up to 3 short next-step button labels (WhatsApp max 20 chars each).',
      items: { type: 'string', maxLength: WA_BUTTON_TITLE_MAX },
      maxItems: WA_MAX_BUTTONS,
    },
  },
  required: ['intent', 'filters', 'brief_reply', 'suggested_buttons'],
};

/** Gemini: single short question for help-me-choose rounds 1–2. */
const HELP_CHOOSE_QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description:
        'One short question only (max ~20 words). No lists, products, prices, or markdown.',
    },
  },
  required: ['question'],
};

/** Gemini: final structured filters only — no prose. */
const HELP_CHOOSE_FILTERS_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      description:
        'Exactly one of aura_cat_dresses, aura_cat_ethnic, aura_cat_casual, aura_cat_party, or empty string if unknown.',
    },
    occasion: {
      type: 'string',
      description:
        'Party, Wedding, Casual, Office, or a very short free-text occasion if none fit.',
    },
    style: {
      type: 'string',
      description: 'Bodycon, Flowy, A-line, or empty string for any / unknown.',
    },
    price_range: {
      type: 'object',
      description: 'INR bounds; use empty object if unknown.',
      properties: {
        min: { type: 'number', description: 'Minimum INR, omit if unknown.' },
        max: { type: 'number', description: 'Maximum INR, omit if unknown.' },
      },
    },
  },
  required: ['category', 'occasion', 'style', 'price_range'],
};

const HELP_CHOOSE_Q1_SYSTEM = `You help shoppers pick clothing for Aura (WhatsApp). Output ONLY valid JSON with one key: "question".
Ask exactly ONE short question about the occasion or event (max 18 words). No product names, prices, lists, or markdown. English only.`;

const HELP_CHOOSE_Q2_SYSTEM = `You help shoppers pick clothing for Aura (WhatsApp). Output ONLY valid JSON with one key: "question".
From the conversation so far, ask exactly ONE short follow-up about style or budget preference (max 18 words). No product names, prices, lists, or markdown. English only.`;

const HELP_CHOOSE_FILTERS_SYSTEM = `You output ONLY valid JSON with exactly these keys: category, occasion, style, price_range. No other keys, no prose, no markdown.
- category: aura_cat_dresses | aura_cat_ethnic | aura_cat_casual | aura_cat_party | "" if unsure.
- occasion: Party | Wedding | Casual | Office | or a very short label if none fit.
- style: Bodycon | Flowy | A-line | "" if unknown or any silhouette.
- price_range: { "min"?: number, "max"?: number } in INR, or {} if unknown. Use whole rupees.`;

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
if (!String(WA_CATALOG_ID || '').trim() && !String(WA_BUSINESS_ACCOUNT_ID || '').trim()) {
  log(
    'info',
    'Commerce catalog_id not configured (WA_CATALOG_ID / WA_BUSINESS_ACCOUNT_ID): native product cards need both catalog_id and wa_product_id; image_url fallback is used otherwise.',
  );
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

function catalogJoin(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr.join(' ') : '';
}

function productHaystack(p) {
  return `${p.name || ''} ${p.description || ''} ${p.stylist_note || ''} ${p.category || ''} ${p.material || ''} ${catalogJoin(p.sizes)} ${catalogJoin(p.colors)} ${catalogJoin(p.fit)} ${catalogJoin(p.style)} ${catalogJoin(p.occasion)}`.toLowerCase();
}

function sessionTokens(raw, minLen = 2) {
  return String(raw || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= minLen);
}

/** User session size vs product.sizes[] */
function productMatchesSessionSize(product, userSize) {
  const u = String(userSize || '').trim().toLowerCase();
  if (!u) {
    return true;
  }
  const sizes = product.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return true;
  }
  return sizes.some((sz) => {
    const s = String(sz || '').trim().toLowerCase();
    if (!s) {
      return false;
    }
    if (s === u || s.includes(u) || u.includes(s)) {
      return true;
    }
    const shortToks = String(userSize || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 1);
    return shortToks.some((t) => s.includes(t) || t.includes(s));
  });
}

/** User session color vs product.colors[] */
function productMatchesSessionColor(product, userColor) {
  const u = String(userColor || '').trim().toLowerCase();
  if (!u) {
    return true;
  }
  const colors = product.colors;
  if (!Array.isArray(colors) || colors.length === 0) {
    return true;
  }
  return colors.some((c) => {
    const s = String(c || '').trim().toLowerCase();
    if (!s) {
      return false;
    }
    if (s === u || s.includes(u) || u.includes(s)) {
      return true;
    }
    return sessionTokens(userColor, 2).some((t) => s.includes(t));
  });
}

function productRequiresSizePick(product) {
  return Array.isArray(product?.sizes) && product.sizes.length > 0;
}

function productRequiresColorPick(product) {
  return Array.isArray(product?.colors) && product.colors.length > 0;
}

/** When the product lists sizes, the chosen size must match that list. */
function sizeAllowedForProduct(product, candidateRaw) {
  if (!productRequiresSizePick(product)) {
    return true;
  }
  if (candidateRaw == null || !String(candidateRaw).trim()) {
    return false;
  }
  return productMatchesSessionSize(product, String(candidateRaw).trim());
}

function colorAllowedForProduct(product, candidateRaw) {
  if (!productRequiresColorPick(product)) {
    return true;
  }
  if (candidateRaw == null || !String(candidateRaw).trim()) {
    return false;
  }
  return productMatchesSessionColor(product, String(candidateRaw).trim());
}

/**
 * Clear or fix session size/color when they do not apply to the selected product.
 * @returns {Record<string, null>}
 */
function getInvalidVariantSessionPatch(product, sess) {
  const patch = {};
  if (!product || !sess) {
    return patch;
  }
  if (productRequiresSizePick(product)) {
    if (
      sess.size != null &&
      String(sess.size).trim() &&
      !sizeAllowedForProduct(product, sess.size)
    ) {
      patch.size = null;
    }
  } else if (sess.size != null && String(sess.size).trim()) {
    patch.size = null;
  }
  if (productRequiresColorPick(product)) {
    if (
      sess.color != null &&
      String(sess.color).trim() &&
      !colorAllowedForProduct(product, sess.color)
    ) {
      patch.color = null;
    }
  } else if (sess.color != null && String(sess.color).trim()) {
    patch.color = null;
  }
  return patch;
}

function buyVariantSizeReplyId(size) {
  return `aura_bsz:${encodeURIComponent(String(size).trim())}`;
}

function buyVariantColorReplyId(color) {
  return `aura_bcl:${encodeURIComponent(String(color).trim())}`;
}

/** @returns {{ kind: 'size'|'color', value: string } | null} */
function parseBuyVariantButtonReply(buttonReplyId) {
  const raw = String(buttonReplyId || '').trim();
  if (raw.startsWith('aura_bsz:')) {
    try {
      return { kind: 'size', value: decodeURIComponent(raw.slice('aura_bsz:'.length)) };
    } catch {
      return null;
    }
  }
  if (raw.startsWith('aura_bcl:')) {
    try {
      return { kind: 'color', value: decodeURIComponent(raw.slice('aura_bcl:'.length)) };
    } catch {
      return null;
    }
  }
  return null;
}

function matchProductColorFromButtonTitle(title, colors) {
  const t = String(title || '').trim();
  if (!t || !Array.isArray(colors)) {
    return null;
  }
  for (const c of colors) {
    const s = String(c);
    if (s === t) {
      return s;
    }
    if (s.slice(0, WA_BUTTON_TITLE_MAX) === t) {
      return s;
    }
  }
  return null;
}

/** User session fit vs product.fit[] */
function productMatchesSessionFit(product, userFit) {
  const u = String(userFit || '').trim().toLowerCase();
  if (!u) {
    return true;
  }
  const fits = product.fit;
  if (!Array.isArray(fits) || fits.length === 0) {
    return true;
  }
  return fits.some((f) => {
    const s = String(f || '').trim().toLowerCase();
    if (!s) {
      return false;
    }
    if (s === u || s.includes(u) || u.includes(s)) {
      return true;
    }
    return sessionTokens(userFit, 3).some((t) => s.includes(t));
  });
}

const SHOP_STYLE_MATCH_CHIPS = {
  Bodycon: [
    'bodycon',
    'body-con',
    'fitted',
    'sculpted',
    'body-skimming',
    'body skimming',
    'sheath',
    'column',
    'second skin',
    'contour',
    'structured shoulder',
    'tailored',
    'rib knit',
    'rib stretch',
  ],
  Flowy: [
    'flowy',
    'fluid',
    'drape',
    'draped',
    'relaxed',
    'easy through',
    'bias',
    'bias-cut',
    'movement',
    'swing',
    'unlined',
    'soft unstructured',
  ],
  'A-line': ['a-line', 'a line', 'aline', 'flared', 'skater', 'princess', 'peplum'],
};

function sessionStyleFilterKey(sessionStyleRaw) {
  const s = String(sessionStyleRaw || '').trim();
  if (!s) {
    return null;
  }
  if (s.toLowerCase() === SHOP_STYLE_NOT_SURE.toLowerCase()) {
    return null;
  }
  return SHOP_STYLE_OPTIONS.find((opt) => opt.toLowerCase() === s.toLowerCase()) || null;
}

/** Session style vs product.style[] and product.fit[] / haystack (chips). */
function productMatchesSessionStyle(product, sessionStyleRaw) {
  const key = sessionStyleFilterKey(sessionStyleRaw);
  if (!key) {
    return true;
  }
  const styles = product?.style;
  if (Array.isArray(styles) && styles.length > 0) {
    const kl = key.toLowerCase();
    if (styles.some((x) => String(x || '').trim().toLowerCase() === kl)) {
      return true;
    }
  }
  const chips = SHOP_STYLE_MATCH_CHIPS[key];
  const hay = `${productHaystack(product)} ${catalogJoin(product?.fit)}`.toLowerCase();
  if (chips?.length) {
    return chips.some((chip) => hay.includes(chip));
  }
  return hay.includes(key.toLowerCase());
}

/**
 * Hard filters on catalog products. Omitted / null fields do not filter.
 * @param {object[]} products
 * @param {{ category?: string|null, priceRange?: object|null, keyword?: string|null, size?: string|null, color?: string|null, fit?: string|null, style?: string|null, occasion?: string|null }} opts
 */
function filterProducts(
  products,
  {
    category = null,
    priceRange = null,
    keyword = null,
    size = null,
    color = null,
    fit = null,
    style = null,
    occasion = null,
  } = {},
) {
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

  if (size != null && String(size).trim()) {
    list = list.filter((p) => productMatchesSessionSize(p, size));
  }
  if (color != null && String(color).trim()) {
    list = list.filter((p) => productMatchesSessionColor(p, color));
  }
  if (fit != null && String(fit).trim()) {
    list = list.filter((p) => productMatchesSessionFit(p, fit));
  }
  if (style != null && String(style).trim()) {
    list = list.filter((p) => productMatchesSessionStyle(p, style));
  }
  if (occasion != null && String(occasion).trim()) {
    list = list.filter((p) => productMatchesSessionOccasion(p, occasion));
  }

  return list;
}

const SHOP_OCCASION_MATCH_CHIPS = {
  Party: [
    'party',
    'cocktail',
    'reception',
    'gala',
    'prom',
    'black tie',
    'gallery',
    'dinner',
    'date night',
    'evening',
    'gallery opening',
    'summer event',
    'layering',
  ],
  Wedding: ['wedding', 'festival', 'ethnic', 'sangeet', 'celebration', 'guest', 'bride', 'groom'],
  Casual: [
    'casual',
    'resort',
    'weekend',
    'vacation',
    'smart casual',
    'warm weather',
    'travel',
    'lounge',
    'everyday',
    'summer',
  ],
  Office: ['office', 'business', 'tailored', 'work', 'professional', 'business travel', 'creased', 'pressed'],
};

/** Session occasion chip (Party | Wedding | Casual | Office) vs product.occasion[] strings. */
function productMatchesSessionOccasion(product, sessionOccasion) {
  const key = String(sessionOccasion || '').trim();
  if (!key) {
    return true;
  }
  const occ = product?.occasion;
  if (!Array.isArray(occ) || occ.length === 0) {
    return true;
  }
  const chips = SHOP_OCCASION_MATCH_CHIPS[key];
  if (!chips || chips.length === 0) {
    const u = key.toLowerCase();
    return occ.some((o) => {
      const s = String(o || '').trim().toLowerCase();
      return s && (s === u || s.includes(u) || u.includes(s));
    });
  }
  const blob = occ.map((o) => String(o || '').trim().toLowerCase()).join(' ');
  return chips.some((chip) => blob.includes(chip));
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
 * Derive filterProducts({ category, priceRange, keyword, size, color, fit, style, occasion }) from user text + optional list row id.
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
  const hay = productHaystack(product);
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

function productsInShopCategory(fullCatalog, categoryRowId) {
  const pool = Array.isArray(fullCatalog.products) ? fullCatalog.products : [];
  if (!LIST_ROW_IDS.has(categoryRowId)) {
    return [];
  }
  return pool.filter((p) => productMatchesListCategory(categoryRowId, p));
}

function collectDistinctColorsForCategory(fullCatalog, categoryRowId, sessionOccasion = null) {
  let list = productsInShopCategory(fullCatalog, categoryRowId);
  if (sessionOccasion != null && String(sessionOccasion).trim()) {
    list = list.filter((p) => productMatchesSessionOccasion(p, sessionOccasion));
  }
  const set = new Set();
  for (const p of list) {
    for (const c of p.colors || []) {
      const s = String(c || '').trim();
      if (s) {
        set.add(s);
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'en'));
}

function structuredSizeFromRowId(rowId) {
  const id = String(rowId || '');
  if (!id.startsWith('aura_struct_sz_')) {
    return null;
  }
  return id.slice('aura_struct_sz_'.length);
}

function structuredColorIndexFromRowId(rowId) {
  const m = /^aura_struct_co_(\d+)$/.exec(String(rowId || '').trim());
  if (!m) {
    return null;
  }
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Map WhatsApp reply button title → structured size (shop flow). */
function structuredSizeFromButtonTitle(buttonTitle) {
  const t = String(buttonTitle || '').trim().toUpperCase();
  if (t === 'XS' || t === 'S' || t === 'M' || t === 'L' || t === 'XL') {
    return t;
  }
  return null;
}

function structuredOccasionFromButtonTitle(buttonTitle) {
  const t = String(buttonTitle || '').trim();
  return SHOP_OCCASION_LABELS.includes(t) ? t : null;
}

function structuredStyleFromButtonTitle(buttonTitle) {
  const t = String(buttonTitle || '').trim();
  if (t === SHOP_STYLE_NOT_SURE) {
    return SHOP_STYLE_NOT_SURE;
  }
  const hit = SHOP_STYLE_OPTIONS.find((opt) => opt.toLowerCase() === t.toLowerCase());
  return hit || null;
}

function parseStyleFromUserText(raw) {
  const t = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '');
  const full = String(raw || '').toLowerCase();
  if (!t && !full.trim()) {
    return null;
  }
  if (
    t === 'not sure' ||
    t === 'notsure' ||
    t === 'unsure' ||
    t === 'any' ||
    t === "don't know" ||
    t === 'dont know' ||
    /\bnot\s+sure\b/.test(full) ||
    /\b(any|whatever)\s+(silhouette|style)\b/.test(full)
  ) {
    return SHOP_STYLE_NOT_SURE;
  }
  if (t === 'bodycon' || t === 'body con' || full.includes('bodycon') || full.includes('body con')) {
    return 'Bodycon';
  }
  if (t === 'flowy' || t === 'flowing' || full.includes('flowy') || full.includes('flowing')) {
    return 'Flowy';
  }
  if (t === 'a-line' || t === 'a line' || t === 'aline' || full.includes('a-line') || full.includes('a line')) {
    return 'A-line';
  }
  return null;
}

function parseOccasionFromUserText(raw) {
  const t = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '');
  if (t === 'party') {
    return 'Party';
  }
  if (t === 'wedding') {
    return 'Wedding';
  }
  if (t === 'casual') {
    return 'Casual';
  }
  if (t === 'office') {
    return 'Office';
  }
  return null;
}

/** Occasion chips from free text; skip Casual when phrase maps to casual *category* (e.g. "show casual"). */
function parseOccasionIntentFromFlexibleText(text, skipCasualBecauseCategoryCasual) {
  const lower = String(text || '').toLowerCase();
  if (/\bwedding\b/.test(lower)) {
    return 'Wedding';
  }
  if (/\boffice\b/.test(lower) || /\bwork\s+wear\b/.test(lower) || /\bfor\s+work\b/.test(lower)) {
    return 'Office';
  }
  if (/\bcocktail\b/.test(lower)) {
    return 'Party';
  }
  if (/\bparty\b/.test(lower) && !/\bparty\s+wear\b/.test(lower)) {
    return 'Party';
  }
  if (!skipCasualBecauseCategoryCasual && /\bcasual\b/.test(lower)) {
    return 'Casual';
  }
  return null;
}

/**
 * Map phrases like "show casual", "switch to ethnic", "dresses" → shop list row.
 * @returns {{ id: string, label: string } | null}
 */
function parseCategoryIntentFromFlexibleText(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) {
    return null;
  }
  const stripped = s
    .replace(
      /^\s*(show|switch\s+to|change\s+to|go\s+to|only|just|i\s+want|want|looking\s+for|need|give\s+me)\s+/i,
      '',
    )
    .trim();
  const core = stripped.length >= 2 ? stripped : s;

  for (const row of COLLECTION_CATEGORY_ROWS) {
    const lt = row.title.toLowerCase();
    if (s === lt || core === lt) {
      return { id: row.id, label: row.title };
    }
  }

  if (/\b(ethnic|saree|sari|kurta|lehenga|anarkali|traditional)\b/.test(core)) {
    return { id: 'aura_cat_ethnic', label: 'Ethnic Wear' };
  }
  if (/\bparty\s+wear\b/.test(s) || /\bparty\s+wear\b/.test(core)) {
    return { id: 'aura_cat_party', label: 'Party Wear' };
  }
  if (/\b(dresses?|gowns?)\b/.test(core)) {
    return { id: 'aura_cat_dresses', label: 'Dresses' };
  }
  if (
    /^casual$/i.test(core) ||
    /^everyday$/i.test(core) ||
    /^lounge$/i.test(core) ||
    /\bcasual\s+wear\b/.test(core) ||
    /\bshow\s+casual\b/.test(s) ||
    /\bswitch\s+to\s+casual\b/.test(s) ||
    /\bchange\s+to\s+casual\b/.test(s)
  ) {
    return { id: 'aura_cat_casual', label: 'Casual' };
  }
  if (/\b(party|gala)\b/.test(core) && !/\bwedding\b/.test(core) && !/\bparty\s+wear\b/.test(core)) {
    return { id: 'aura_cat_party', label: 'Party Wear' };
  }
  return null;
}

function parseSizeIntentFromFlexibleText(text) {
  const u = String(text || '').toUpperCase().replace(/\s+/g, ' ');
  const m = /\b(XS|S|M|L|XL)\b/.exec(u);
  return m ? m[1] : null;
}

/**
 * @returns {{ category: { id: string, label: string } | null, occasion: string | null, style: string | null, size: string | null } | null}
 */
function parseFlexibleShopNavIntents(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }
  const cat = parseCategoryIntentFromFlexibleText(raw);
  const skipCasualOcc = Boolean(cat?.id === 'aura_cat_casual');
  let occasion = parseOccasionIntentFromFlexibleText(raw, skipCasualOcc);
  if (!occasion) {
    occasion = parseOccasionFromUserText(raw);
    if (occasion === 'Casual' && skipCasualOcc) {
      occasion = null;
    }
  }
  const style = parseStyleFromUserText(raw);
  const size = parseSizeIntentFromFlexibleText(raw);
  if (!cat && !occasion && !style && !size) {
    return null;
  }
  return { category: cat, occasion, style, size };
}

function categoryMatchedFromFlexibleNav(sess) {
  return sess && sess.category && LIST_ROW_IDS.has(sess.category);
}

function structuredShopFlowStepActive(step) {
  return (
    step === 'await_category' ||
    step === SHOP_FLOW_AWAIT_OCCASION ||
    step === SHOP_FLOW_AWAIT_STYLE ||
    step === 'await_size' ||
    step === 'await_color'
  );
}

function buyConfirmShopFlowStep(step) {
  return (
    step === SHOP_FLOW_AWAIT_BUY_CONFIRM ||
    step === SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE ||
    step === SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR
  );
}

/**
 * Apply category / occasion / style / size from typed keywords without full session reset.
 * @returns {Promise<boolean>} true if the message was consumed.
 */
async function tryFlexibleShopTextNavigation(from, text, fullCatalog) {
  const sess = db.getUserSession(from);
  const intents = parseFlexibleShopNavIntents(text);
  if (!intents) {
    return false;
  }

  const hasCat = Boolean(intents.category);
  const hasOcc = Boolean(intents.occasion);
  const hasStyle = Boolean(intents.style);
  const hasSize = Boolean(intents.size);
  if (!hasCat && !hasOcc && !hasStyle && !hasSize) {
    return false;
  }

  const step = sess?.shop_flow_step || null;
  if (step === SHOP_FLOW_HELP_CHOOSE_AWAIT_1 || step === SHOP_FLOW_HELP_CHOOSE_AWAIT_2) {
    return false;
  }

  const inStructured = structuredShopFlowStepActive(step);
  const inBuyConfirm = buyConfirmShopFlowStep(step);
  const browsing =
    categoryMatchedFromFlexibleNav(sess) && (step == null || step === '') && !inBuyConfirm;
  const canPartial =
    categoryMatchedFromFlexibleNav(sess) || inStructured || inBuyConfirm || browsing;

  if (!hasCat && !canPartial) {
    return false;
  }

  if (step === 'await_category' && hasCat && intents.category) {
    await startStructuredCategorySelection(from, intents.category.id, intents.category.label);
    const ack = `Switched to ${intents.category.label}.`.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    return true;
  }

  let categoryChanged = false;
  let occasionChanged = false;
  let styleChanged = false;
  let sizeChanged = false;

  if (hasCat && intents.category && sess && intents.category.id !== sess.category) {
    db.patchUserSession(from, {
      category_row_id: intents.category.id,
      category_label: intents.category.label,
      color: null,
      pending_color_options: null,
      selected_product_id: null,
    });
    categoryChanged = true;
  } else if (hasCat && intents.category && !sess) {
    await startStructuredCategorySelection(from, intents.category.id, intents.category.label);
    const ack = `Starting with ${intents.category.label}.`.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    return true;
  }

  if (hasOcc && intents.occasion && intents.occasion !== (sess?.occasion || '')) {
    db.patchUserSession(from, {
      occasion: intents.occasion,
      style: null,
    });
    occasionChanged = true;
  }

  if (hasStyle && intents.style) {
    const styleStored = intents.style === SHOP_STYLE_NOT_SURE ? null : intents.style;
    const prevStyle = sess?.style ?? null;
    if (styleStored !== prevStyle) {
      db.patchUserSession(from, { style: styleStored });
      styleChanged = true;
    }
  }

  if (hasSize && intents.size && intents.size !== (sess?.size || '')) {
    if (inBuyConfirm && sess?.selectedProductId) {
      const p = findProductById(fullCatalog, sess.selectedProductId);
      if (p && productRequiresSizePick(p) && !sizeAllowedForProduct(p, intents.size)) {
        /* skip invalid size for current product */
      } else {
        db.patchUserSession(from, { size: intents.size });
        sizeChanged = true;
      }
    } else if (step === 'await_size' || !inBuyConfirm || !sess?.selectedProductId) {
      db.patchUserSession(from, { size: intents.size });
      sizeChanged = true;
    }
  }

  if (!categoryChanged && !occasionChanged && !styleChanged && !sizeChanged) {
    return false;
  }

  const s2 = db.getUserSession(from);
  const ackBits = [];
  if (categoryChanged) {
    ackBits.push(`${s2?.category_label || 'Category'} updated`);
  }
  if (occasionChanged) {
    ackBits.push(`occasion → ${s2?.occasion}`);
  }
  if (styleChanged) {
    ackBits.push(`silhouette → ${s2?.style || 'open'}`);
  }
  if (sizeChanged) {
    ackBits.push(`size → ${s2?.size}`);
  }
  const ack = `${ackBits.join(' · ')}.`.slice(0, WA_TEXT_MAX);

  if (inBuyConfirm) {
    db.patchUserSession(from, { shop_flow_step: null });
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    if (s2 && LIST_ROW_IDS.has(s2.category)) {
      await deliverBackendCatalogExperience(from, fullCatalog, {
        userText: '',
        categoryListRowId: s2.category,
        headline: `${s2.category_label || 'Your picks'} — updated for you:`.slice(0, WA_TEXT_MAX),
        offerOptionalColorFilter: true,
      });
    } else {
      await sendCategoryFilterListAndLog(from);
    }
    return true;
  }

  if (categoryChanged && s2) {
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    if (!s2.occasion) {
      db.patchUserSession(from, { shop_flow_step: SHOP_FLOW_AWAIT_OCCASION });
      const intro = `${SHOP_OCCASION_STEP_BODY}`.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, intro);
      db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
      await sendStructuredOccasionSelectionButtons(from);
      db.insertChatMessage(from, 'model', `${intro} [occasion buttons]`, Date.now());
      return true;
    }
    if (s2.shop_flow_step === SHOP_FLOW_AWAIT_OCCASION) {
      db.patchUserSession(from, { shop_flow_step: SHOP_FLOW_AWAIT_STYLE });
      const intro = `Got it — ${s2.occasion}. ${SHOP_STYLE_STEP_BODY}`.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, intro);
      db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
      await sendStructuredStyleSelectionButtons(from);
      db.insertChatMessage(from, 'model', `${intro} [style buttons]`, Date.now());
      return true;
    }
    if (s2.shop_flow_step === SHOP_FLOW_AWAIT_STYLE) {
      const intro = `${SHOP_STYLE_STEP_BODY}`.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, intro);
      db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
      await sendStructuredStyleSelectionButtons(from);
      db.insertChatMessage(from, 'model', `${intro} [style buttons]`, Date.now());
      return true;
    }
    if (s2.shop_flow_step === 'await_size') {
      const intro = 'Choose your size for this category.'.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, intro);
      db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
      await sendStructuredSizeSelectionButtons(from);
      db.insertChatMessage(from, 'model', `${intro} [size buttons]`, Date.now());
      return true;
    }
    if (s2.shop_flow_step === 'await_color') {
      db.patchUserSession(from, { shop_flow_step: null, pending_color_options: null });
      await deliverBackendCatalogExperience(from, fullCatalog, {
        userText: '',
        categoryListRowId: s2.category,
        headline: `${s2.category_label || 'Your picks'} — updated:`.slice(0, WA_TEXT_MAX),
        offerOptionalColorFilter: true,
      });
      return true;
    }
    db.patchUserSession(from, { shop_flow_step: null });
    await deliverBackendCatalogExperience(from, fullCatalog, {
      userText: '',
      categoryListRowId: s2.category,
      headline: `${s2.category_label || 'Your picks'} — updated:`.slice(0, WA_TEXT_MAX),
      offerOptionalColorFilter: true,
    });
    return true;
  }

  if (sizeChanged && s2?.shop_flow_step === 'await_size' && s2?.category && intents.size) {
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    return handleStructuredSizeChoice(from, intents.size, fullCatalog);
  }

  if (occasionChanged && s2?.shop_flow_step === SHOP_FLOW_AWAIT_OCCASION && intents.occasion) {
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    await handleStructuredOccasionChoice(from, intents.occasion, fullCatalog);
    return true;
  }

  if (occasionChanged && s2?.shop_flow_step === SHOP_FLOW_AWAIT_STYLE && intents.occasion) {
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    const intro = `Got it — ${s2.occasion}. ${SHOP_STYLE_STEP_BODY}`.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, intro);
    db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
    await sendStructuredStyleSelectionButtons(from);
    db.insertChatMessage(from, 'model', `${intro} [style buttons]`, Date.now());
    return true;
  }

  if (styleChanged && s2?.shop_flow_step === SHOP_FLOW_AWAIT_STYLE && intents.style) {
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    await handleStructuredStyleChoice(from, intents.style, fullCatalog);
    return true;
  }

  if (
    !categoryChanged &&
    (occasionChanged || styleChanged || sizeChanged) &&
    s2 &&
    LIST_ROW_IDS.has(s2.category)
  ) {
    db.patchUserSession(from, {
      shop_flow_step: null,
      pending_color_options: null,
    });
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    await deliverBackendCatalogExperience(from, fullCatalog, {
      userText: '',
      categoryListRowId: s2.category,
      headline: `${s2.category_label || 'Your picks'} — refreshed:`.slice(0, WA_TEXT_MAX),
      offerOptionalColorFilter: true,
    });
    return true;
  }

  if (
    (occasionChanged || styleChanged || sizeChanged) &&
    step === 'await_category' &&
    !categoryChanged
  ) {
    await sendWhatsAppText(from, ack);
    db.logMessage({ waId: from, direction: 'out', body: ack, metaMessageId: null });
    db.insertChatMessage(from, 'model', ack, Date.now());
    return true;
  }

  return false;
}

function categoryRowFromButtonTitle(buttonTitle) {
  const title = String(buttonTitle || '').trim();
  return COLLECTION_CATEGORY_ROWS.find((r) => r.title === title) || null;
}

function normalizeHelpCategoryFromModel(s) {
  const raw = String(s || '').trim();
  if (LIST_ROW_IDS.has(raw)) {
    return raw;
  }
  const t = raw.toLowerCase();
  if (!t) {
    return null;
  }
  for (const r of COLLECTION_CATEGORY_ROWS) {
    if (r.id.toLowerCase() === t || r.title.toLowerCase() === t) {
      return r.id;
    }
  }
  if (/\b(dress|gown)\b/.test(t)) {
    return 'aura_cat_dresses';
  }
  if (/ethnic|saree|sari|kurta|lehenga/.test(t)) {
    return 'aura_cat_ethnic';
  }
  if (/casual|everyday|lounge/.test(t)) {
    return 'aura_cat_casual';
  }
  if (/party|gala|prom|cocktail|evening/.test(t)) {
    return 'aura_cat_party';
  }
  return null;
}

function normalizeHelpOccasionFromModel(s) {
  const t = String(s || '').trim();
  if (!t) {
    return null;
  }
  if (SHOP_OCCASION_LABELS.includes(t)) {
    return t;
  }
  const fromText = parseOccasionFromUserText(t);
  if (fromText) {
    return fromText;
  }
  const lower = t.toLowerCase();
  if (/\bparty\b|cocktail|gala|prom|date/.test(lower)) {
    return 'Party';
  }
  if (/wedding|bride|groom|sangeet/.test(lower)) {
    return 'Wedding';
  }
  if (/office|work|business|professional/.test(lower)) {
    return 'Office';
  }
  if (/casual|weekend|vacation|everyday/.test(lower)) {
    return 'Casual';
  }
  return t;
}

function normalizeHelpStyleFromModel(s) {
  const t = String(s || '').trim();
  if (!t) {
    return null;
  }
  const parsed = parseStyleFromUserText(t);
  if (parsed === SHOP_STYLE_NOT_SURE) {
    return null;
  }
  if (parsed) {
    return parsed;
  }
  const hit = SHOP_STYLE_OPTIONS.find((opt) => opt.toLowerCase() === t.toLowerCase());
  return hit || null;
}

/** Optional color filter: only when a shop category is active and not mid-checkout / earlier structured steps. */
function canStartOptionalColorFilter(sess) {
  if (!sess?.category || !LIST_ROW_IDS.has(sess.category)) {
    return false;
  }
  const step = sess.shop_flow_step;
  if (
    step === SHOP_FLOW_AWAIT_OCCASION ||
    step === SHOP_FLOW_AWAIT_STYLE ||
    step === 'await_size' ||
    step === SHOP_FLOW_HELP_CHOOSE_AWAIT_1 ||
    step === SHOP_FLOW_HELP_CHOOSE_AWAIT_2 ||
    step === SHOP_FLOW_AWAIT_BUY_CONFIRM ||
    step === SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE ||
    step === SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR
  ) {
    return false;
  }
  return true;
}

function matchPendingColorByButtonTitle(buttonTitle, pendingColors) {
  if (!Array.isArray(pendingColors) || pendingColors.length === 0) {
    return null;
  }
  const t = String(buttonTitle || '').trim();
  for (const c of pendingColors) {
    const s = String(c);
    if (s === t) {
      return s;
    }
    if (s.slice(0, WA_BUTTON_TITLE_MAX) === t) {
      return s;
    }
  }
  return null;
}

function mergePriceRangeWithSession(inferredRange, session) {
  const base = inferredRange != null && typeof inferredRange === 'object' ? { ...inferredRange } : {};
  const cap = session?.priceMaxInr;
  if (cap != null && Number.isFinite(Number(cap)) && Number(cap) > 0) {
    const c = Number(cap);
    const em = base.maxInr;
    if (em != null && Number.isFinite(Number(em))) {
      base.maxInr = Math.min(Number(em), c);
    } else {
      base.maxInr = c;
    }
  }
  const floor = session?.priceMinInr;
  if (floor != null && Number.isFinite(Number(floor)) && Number(floor) > 0) {
    const f = Number(floor);
    const ex = base.minInr;
    if (ex != null && Number.isFinite(Number(ex))) {
      base.minInr = Math.max(Number(ex), f);
    } else {
      base.minInr = f;
    }
  }
  return base;
}

function inferFilterAndOrderProducts(fullCatalog, userText, categoryListRowId = null, waId = null) {
  const pool = Array.isArray(fullCatalog.products) ? fullCatalog.products : [];
  const inferred = inferProductFilters(userText, categoryListRowId);
  const session = waId ? db.getUserSession(waId) : null;
  const mergedRange = mergePriceRangeWithSession(inferred.priceRange, session);
  const filtered = filterProducts(pool, {
    category: inferred.category,
    priceRange: mergedRange,
    keyword: inferred.keyword,
    size: session?.size || null,
    color: session?.color || null,
    fit: session?.fit || null,
    style: session?.style || null,
    occasion: session?.occasion || null,
  });
  const ordered = orderFilteredProducts(filtered, pool, userText, inferred.sortMode);
  return { pool, inferred, ordered };
}

function buildRagCatalog(fullCatalog, userText, categoryListRowId = null, waId = null) {
  const { effectiveCat, mergedUserText } = resolveCatalogQueryContext(waId, userText, categoryListRowId);
  const { ordered } = inferFilterAndOrderProducts(fullCatalog, mergedUserText, effectiveCat, waId);
  return {
    brand: fullCatalog.brand,
    shipping: fullCatalog.shipping,
    currency: fullCatalog.currency,
    inrPerUsd: fullCatalog.inrPerUsd,
    products: ordered.slice(0, 3),
  };
}

function buildSystemPrompt(ragCatalog) {
  const catalogJson = JSON.stringify(ragCatalog, null, 2);
  return `You are the decision engine for Aura, concierge stylist for "${ragCatalog.brand || 'Aura Atelier'}", a luxury clothing brand.

You do NOT write the customer-facing catalog experience: the server shows product images and standard shopping buttons from your filters.
Your job is intent + structured filters + one optional short sentence (brief_reply) and button labels.

Category row ids (use category_row_id only when the shopper clearly maps to one):
- aura_cat_dresses — dresses, gowns, formal dress silhouettes
- aura_cat_ethnic — saree, kurta, lehenga, traditional
- aura_cat_casual — everyday, relaxed, lounge, simple separates
- aura_cat_party — party, gala, prom, cocktail, statement evening

filters.price_max_inr / price_min_inr: use whole INR numbers; use 0 when not stated.
filters.keyword: short tokens for text match (occasion, fabric vibe, "beach wedding", "minimal") — empty string if none.

intent:
- browse | budget | style — when helping pick products
- shipping — delivery, duties, timelines (brief_reply summarizes; filters often empty)
- lead — ready to buy / wants human / contact details
- smalltalk — hi, thanks, emoji-only
- unclear — ambiguous; still set best-effort filters

Pricing context for brief_reply only: catalog is INR; US quotes use 1 USD = ${INR_PER_USD} INR when you mention money in brief_reply.

Shipping object in JSON: use for shipping intent in brief_reply (one sentence max).

If the user sent a voice note, infer intent and filters from the audio.

OUTPUT (entire reply = one JSON object only, valid JSON, no markdown fences):
{
  "intent": "browse | budget | style | shipping | lead | smalltalk | unclear",
  "filters": {
    "category_row_id": "",
    "price_max_inr": 0,
    "price_min_inr": 0,
    "keyword": ""
  },
  "brief_reply": "Max one short sentence; no product lists — cards are shown by the app.",
  "suggested_buttons": ["Up to ${WA_MAX_BUTTONS} labels, ${WA_BUTTON_TITLE_MAX} chars max each"]
}

Relevant catalog subset (examples for this turn — full matching is done server-side):
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

async function generateHelpChooseQuestionGemini(contents, round) {
  if (!contents.length) {
    throw new Error('No conversation contents for Gemini');
  }
  const ai = getGenAI();
  const system = round === 1 ? HELP_CHOOSE_Q1_SYSTEM : HELP_CHOOSE_Q2_SYSTEM;
  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseJsonSchema: HELP_CHOOSE_QUESTION_SCHEMA,
    },
  });
  const text = result.text;
  if (!text || !String(text).trim()) {
    throw new Error('Empty help-choose question');
  }
  return String(text).trim();
}

async function generateHelpChooseFiltersGemini(contents) {
  if (!contents.length) {
    throw new Error('No conversation contents for Gemini');
  }
  const ai = getGenAI();
  const result = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    config: {
      systemInstruction: HELP_CHOOSE_FILTERS_SYSTEM,
      responseMimeType: 'application/json',
      responseJsonSchema: HELP_CHOOSE_FILTERS_SCHEMA,
    },
  });
  const text = result.text;
  if (!text || !String(text).trim()) {
    throw new Error('Empty help-choose filters');
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

/** Cached Commerce `catalog_id` from Graph (env WA_CATALOG_ID is not memoized here). */
let memoizedWhatsAppCatalogIdFromApi = null;
/** True after a successful Graph lookup returned zero catalogs (avoid hammering API). */
let whatsAppCatalogLookupExhausted = false;
let whatsAppCatalogConfigWarningLogged = false;

function logWhatsAppCatalogConfigOnce(meta) {
  if (whatsAppCatalogConfigWarningLogged) {
    return;
  }
  whatsAppCatalogConfigWarningLogged = true;
  log(
    'warn',
    'Configure WA_CATALOG_ID (recommended) or WA_BUSINESS_ACCOUNT_ID with a linked catalog for native WhatsApp product cards. Until then, items with only wa_product_id need image_url for carousel slots.',
    meta || {},
  );
}

/**
 * Resolves Commerce catalog_id for interactive product messages: WA_CATALOG_ID env first,
 * else first catalog from GET /{WABA}/product_catalogs (memoized on success).
 * @returns {Promise<string|null>}
 */
async function fetchWhatsAppCatalogId() {
  const envId = String(WA_CATALOG_ID || '').trim();
  if (envId) {
    return envId;
  }
  if (memoizedWhatsAppCatalogIdFromApi) {
    return memoizedWhatsAppCatalogIdFromApi;
  }
  if (whatsAppCatalogLookupExhausted) {
    return null;
  }
  if (!WA_BUSINESS_ACCOUNT_ID) {
    logWhatsAppCatalogConfigOnce({ reason: 'WA_BUSINESS_ACCOUNT_ID unset' });
    return null;
  }
  try {
    const data = await graphCommerceGet(`${WA_BUSINESS_ACCOUNT_ID}/product_catalogs`, {
      fields: 'id,name',
    });
    const id = data?.data?.[0]?.id;
    const out = id != null ? String(id) : null;
    if (out) {
      memoizedWhatsAppCatalogIdFromApi = out;
      log('info', 'WhatsApp Commerce catalog_id resolved', { catalog_id: out });
    } else {
      whatsAppCatalogLookupExhausted = true;
      logWhatsAppCatalogConfigOnce({ reason: 'no_linked_product_catalogs' });
    }
    return out;
  } catch (err) {
    log('warn', 'Could not resolve WhatsApp catalog_id from Graph API', { message: err.message });
    return null;
  }
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

async function resolveWhatsAppMediaIdForImageUrl(imageUrl) {
  const trimmed = String(imageUrl || '').trim();
  if (!trimmed) {
    throw new Error('missing image url');
  }
  let mediaId = db.getCachedMediaId(trimmed);
  if (mediaId) {
    return mediaId;
  }
  const imgRes = await axios.get(trimmed, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 15 * 1024 * 1024,
  });
  const buf = Buffer.from(imgRes.data);
  const ct = imgRes.headers['content-type'] || 'image/jpeg';
  const filename = guessFilenameFromUrl(trimmed, ct);
  mediaId = await uploadImageBufferToWhatsApp(buf, filename, ct);
  db.upsertMediaCache(trimmed, mediaId);
  return mediaId;
}

async function sendWhatsAppImageWithCache(to, imageUrl, caption) {
  const mediaId = await resolveWhatsAppMediaIdForImageUrl(imageUrl);
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

/**
 * Reply buttons with stable ids (for product_id) and titles (max 20 chars each).
 * @param {{ id: string, title: string }[]} replies
 */
async function sendWhatsAppInteractiveReplyButtons(to, bodyText, replies) {
  const buttons = (Array.isArray(replies) ? replies : [])
    .slice(0, WA_MAX_BUTTONS)
    .map((r) => ({
      type: 'reply',
      reply: {
        id: String(r.id || '').trim().slice(0, WA_REPLY_BUTTON_ID_MAX),
        title: String(r.title || '').trim().slice(0, WA_BUTTON_TITLE_MAX),
      },
    }))
    .filter((b) => b.reply.id && b.reply.title);

  if (buttons.length === 0) {
    return;
  }

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

async function sendQuickReentryButtonRow(to, bodyText = QUICK_REENTRY_BODY) {
  const b = String(bodyText || QUICK_REENTRY_BODY).slice(0, WA_BODY_MAX);
  await sendWhatsAppInteractiveButtons(to, b, QUICK_REENTRY_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${b} | ${QUICK_REENTRY_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', `${b} [re-entry]`, Date.now());
}

async function handleQuickReentryStartOver(to) {
  db.clearBuyNowFlow(to);
  db.clearFitPrefsSession(to);
  db.wipeUserSession(to);
  db.upsertBrowseState(to, { orderedProductIds: [], nextIndex: 0, lastWindowStart: 0 });
  const msg = QUICK_REENTRY_START_OVER_ACK.slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(to, msg);
  db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
  db.insertChatMessage(to, 'model', msg, Date.now());
  await sendWhatsAppInteractiveButtons(to, GREETING_MENU_BODY, GREETING_MENU_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${GREETING_MENU_BODY} | ${GREETING_MENU_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', GREETING_MENU_BODY, Date.now());
  await sendWhatsAppInteractiveButtons(to, GREETING_MENU_HELP_ROW_BODY, [HELP_ME_CHOOSE_BUTTON_TITLE]);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${GREETING_MENU_HELP_ROW_BODY} | ${HELP_ME_CHOOSE_BUTTON_TITLE}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', GREETING_MENU_HELP_ROW_BODY, Date.now());
  await sendQuickReentryButtonRow(to);
}

async function sendShopCollectionCategoryButtons(to) {
  const [a, b, c, d] = COLLECTION_CATEGORY_ROWS;
  await sendWhatsAppInteractiveButtons(to, SHOP_COLLECTION_CATEGORY_BODY, [
    a.title,
    b.title,
    c.title,
  ]);
  await sendWhatsAppInteractiveButtons(to, SHOP_COLLECTION_CATEGORY_BODY_MORE, [
    d.title,
    HELP_ME_CHOOSE_BUTTON_TITLE,
  ]);
  await sendQuickReentryButtonRow(to);
}

async function sendStructuredSizeSelectionButtons(to) {
  await sendWhatsAppInteractiveButtons(to, STRUCT_SIZE_LIST_BODY, ['XS', 'S', 'M']);
  await sendWhatsAppInteractiveButtons(to, 'Tap your size (continued):', ['L', 'XL']);
  await sendQuickReentryButtonRow(to);
}

async function sendStructuredOccasionSelectionButtons(to) {
  await sendWhatsAppInteractiveButtons(to, SHOP_OCCASION_STEP_BODY, [
    SHOP_OCCASION_LABELS[0],
    SHOP_OCCASION_LABELS[1],
    SHOP_OCCASION_LABELS[2],
  ]);
  await sendWhatsAppInteractiveButtons(to, SHOP_OCCASION_BODY_OFFICE_ROW, [SHOP_OCCASION_LABELS[3]]);
  await sendQuickReentryButtonRow(to);
}

async function sendStructuredStyleSelectionButtons(to) {
  await sendWhatsAppInteractiveButtons(to, SHOP_STYLE_STEP_BODY, [
    SHOP_STYLE_OPTIONS[0],
    SHOP_STYLE_OPTIONS[1],
    SHOP_STYLE_OPTIONS[2],
  ]);
  await sendWhatsAppInteractiveButtons(to, SHOP_STYLE_BODY_NOT_SURE_ROW, [SHOP_STYLE_NOT_SURE]);
  await sendQuickReentryButtonRow(to);
}

async function sendStructuredColorSelectionButtons(to, colors) {
  const slice = (Array.isArray(colors) ? colors : []).slice(0, STRUCT_COLOR_ROWS_MAX);
  const totalPages = Math.max(1, Math.ceil(slice.length / WA_MAX_BUTTONS));
  for (let i = 0; i < slice.length; i += WA_MAX_BUTTONS) {
    const chunk = slice.slice(i, i + WA_MAX_BUTTONS);
    const titles = chunk.map((c) => String(c).slice(0, WA_BUTTON_TITLE_MAX));
    const page = Math.floor(i / WA_MAX_BUTTONS) + 1;
    const suffix = totalPages > 1 ? ` (${page}/${totalPages})` : '';
    const body = `${STRUCT_COLOR_LIST_BODY}${suffix}`.slice(0, WA_BODY_MAX);
    await sendWhatsAppInteractiveButtons(to, body, titles);
  }
  await sendQuickReentryButtonRow(to);
}

async function sendBuyFlowSizeButtonsForProduct(to, product) {
  if (!productRequiresSizePick(product)) {
    return;
  }
  const sizes = product.sizes.map((s) => String(s).trim()).filter(Boolean);
  if (sizes.length === 0) {
    return;
  }
  const totalPages = Math.max(1, Math.ceil(sizes.length / WA_MAX_BUTTONS));
  for (let i = 0; i < sizes.length; i += WA_MAX_BUTTONS) {
    const chunk = sizes.slice(i, i + WA_MAX_BUTTONS);
    const page = Math.floor(i / WA_MAX_BUTTONS) + 1;
    const suffix = totalPages > 1 ? ` (${page}/${totalPages})` : '';
    const body = `${STRUCT_SIZE_LIST_BODY}${suffix}`.slice(0, WA_BODY_MAX);
    const replies = chunk.map((sz) => {
      const id = buyVariantSizeReplyId(sz).slice(0, WA_REPLY_BUTTON_ID_MAX);
      return { id, title: String(sz).slice(0, WA_BUTTON_TITLE_MAX) };
    });
    await sendWhatsAppInteractiveReplyButtons(to, body, replies);
  }
  await sendQuickReentryButtonRow(to);
}

async function sendBuyFlowColorButtonsForProduct(to, product) {
  if (!productRequiresColorPick(product)) {
    return;
  }
  const colors = product.colors.map((c) => String(c).trim()).filter(Boolean);
  if (colors.length === 0) {
    return;
  }
  const totalPages = Math.max(1, Math.ceil(colors.length / WA_MAX_BUTTONS));
  for (let i = 0; i < colors.length; i += WA_MAX_BUTTONS) {
    const chunk = colors.slice(i, i + WA_MAX_BUTTONS);
    const page = Math.floor(i / WA_MAX_BUTTONS) + 1;
    const suffix = totalPages > 1 ? ` (${page}/${totalPages})` : '';
    const body = `${STRUCT_COLOR_LIST_BODY}${suffix}`.slice(0, WA_BODY_MAX);
    const replies = chunk.map((col) => {
      const id = buyVariantColorReplyId(col).slice(0, WA_REPLY_BUTTON_ID_MAX);
      return { id, title: String(col).slice(0, WA_BUTTON_TITLE_MAX) };
    });
    await sendWhatsAppInteractiveReplyButtons(to, body, replies);
  }
  await sendQuickReentryButtonRow(to);
}

async function promptSizeForSelectedProduct(to, product) {
  db.patchUserSession(to, { shop_flow_step: SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE });
  const pname = String(product?.name || product?.id || '').trim();
  const line = pname
    ? `${BUY_SELECT_SIZE_FOR_PRODUCT}: ${pname}`.slice(0, WA_TEXT_MAX)
    : BUY_SELECT_SIZE_FOR_PRODUCT.slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(to, line);
  db.logMessage({ waId: to, direction: 'out', body: line, metaMessageId: null });
  await sendBuyFlowSizeButtonsForProduct(to, product);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${STRUCT_SIZE_LIST_BODY} | buy confirm size (product)`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', `${line} [size buttons]`, Date.now());
}

async function promptColorForSelectedProduct(to, product) {
  db.patchUserSession(to, { shop_flow_step: SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR });
  const pname = String(product?.name || product?.id || '').trim();
  const line = pname
    ? `Select a color for this product: ${pname}`.slice(0, WA_TEXT_MAX)
    : 'Select a color for this product.'.slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(to, line);
  db.logMessage({ waId: to, direction: 'out', body: line, metaMessageId: null });
  await sendBuyFlowColorButtonsForProduct(to, product);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${STRUCT_COLOR_LIST_BODY} | buy confirm color (product)`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', `${line} [color buttons]`, Date.now());
}

function stripModelJsonFences(raw) {
  let s = String(raw).trim();
  const m = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(s);
  if (m) {
    s = m[1].trim();
  }
  return s;
}

function normalizeButtonList(buttonsIn) {
  let buttons = Array.isArray(buttonsIn) ? buttonsIn : [];
  return buttons
    .filter((b) => typeof b === 'string')
    .map((b) => b.trim().slice(0, WA_BUTTON_TITLE_MAX))
    .filter(Boolean)
    .slice(0, WA_MAX_BUTTONS);
}

function normalizeDecisionReply(obj) {
  const intent = typeof obj.intent === 'string' ? obj.intent.trim().toLowerCase() : 'unclear';
  const rawF = obj.filters && typeof obj.filters === 'object' ? obj.filters : {};
  let category_row_id = rawF.category_row_id;
  if (category_row_id != null) {
    category_row_id = String(category_row_id).trim();
    if (!LIST_ROW_IDS.has(category_row_id)) {
      category_row_id = null;
    }
  } else {
    category_row_id = null;
  }
  let prMax = rawF.price_max_inr;
  let prMin = rawF.price_min_inr;
  prMax = prMax != null && Number.isFinite(Number(prMax)) ? Number(prMax) : null;
  prMin = prMin != null && Number.isFinite(Number(prMin)) ? Number(prMin) : null;
  if (prMax !== null && prMax <= 0) {
    prMax = null;
  }
  if (prMin !== null && prMin <= 0) {
    prMin = null;
  }
  let kw = rawF.keyword;
  kw = kw != null && String(kw).trim() ? String(kw).trim() : null;

  return {
    intent,
    filters: {
      category_row_id,
      price_max_inr: prMax,
      price_min_inr: prMin,
      keyword: kw,
    },
    brief_reply: typeof obj.brief_reply === 'string' ? obj.brief_reply.trim() : '',
    suggested_buttons: normalizeButtonList(obj.suggested_buttons),
  };
}

function parseDecisionEngineReply(rawText) {
  const stripped = stripModelJsonFences(rawText);
  const obj = JSON.parse(stripped);
  return normalizeDecisionReply(obj);
}

function mergeInferenceWithDecision(userText, categoryListRowId, decision) {
  const base = inferProductFilters(userText, categoryListRowId);
  const f = decision.filters || {};
  let category = base.category;
  if (f.category_row_id && LIST_ROW_IDS.has(f.category_row_id)) {
    category = f.category_row_id;
  }
  let priceRange = base.priceRange;
  if (f.price_max_inr != null && Number.isFinite(Number(f.price_max_inr))) {
    priceRange = { ...(priceRange || {}), maxInr: Number(f.price_max_inr) };
  }
  if (f.price_min_inr != null && Number.isFinite(Number(f.price_min_inr))) {
    priceRange = { ...(priceRange || {}), minInr: Number(f.price_min_inr) };
  }
  let keyword = base.keyword;
  if (f.keyword != null && String(f.keyword).trim()) {
    keyword = String(f.keyword).trim();
  }
  return {
    category,
    priceRange,
    keyword,
    sortMode: base.sortMode,
  };
}

function augmentUserTextWithSession(waId, baseText) {
  if (!waId) {
    return String(baseText || '').trim();
  }
  const s = db.getUserSession(waId);
  const b = String(baseText || '').trim();
  if (!s) {
    return b;
  }
  const bits = [];
  if (s.category_label) {
    bits.push(s.category_label);
  }
  if (s.category) {
    bits.push(`shop_category ${s.category}`);
  }
  if (s.size) {
    bits.push(`size ${s.size}`);
  }
  if (s.color) {
    bits.push(`color ${s.color}`);
  }
  if (s.fit) {
    bits.push(`fit ${s.fit}`);
  }
  if (s.occasion) {
    bits.push(`occasion ${s.occasion}`);
  }
  if (s.style) {
    bits.push(`style ${s.style}`);
  }
  if (s.priceMaxInr != null && Number.isFinite(s.priceMaxInr)) {
    bits.push(`max budget ₹${s.priceMaxInr}`);
  }
  if (s.priceMinInr != null && Number.isFinite(s.priceMinInr)) {
    bits.push(`min budget ₹${s.priceMinInr}`);
  }
  if (s.selectedProductId) {
    bits.push(`selected_product ${s.selectedProductId}`);
  }
  if (bits.length === 0) {
    return b;
  }
  const tail = `[Session: ${bits.join(' · ')}]`;
  return b ? `${b}\n${tail}` : tail;
}

function resolveCatalogQueryContext(waId, userText, categoryListRowId) {
  const session = waId ? db.getUserSession(waId) : null;
  let effectiveCat = categoryListRowId;
  if (!effectiveCat && session?.category && LIST_ROW_IDS.has(session.category)) {
    effectiveCat = session.category;
  }
  const mergedUserText = waId ? augmentUserTextWithSession(waId, userText) : String(userText || '');
  return { effectiveCat, mergedUserText };
}

function orderedProductsFromMergedFilters(fullCatalog, userText, categoryListRowId, decision, waId = null) {
  const { effectiveCat, mergedUserText } = resolveCatalogQueryContext(waId, userText, categoryListRowId);
  const m = mergeInferenceWithDecision(mergedUserText, effectiveCat, decision);
  const pool = Array.isArray(fullCatalog.products) ? fullCatalog.products : [];
  const session = waId ? db.getUserSession(waId) : null;
  const mergedRange = mergePriceRangeWithSession(m.priceRange, session);
  const filtered = filterProducts(pool, {
    category: m.category,
    priceRange: mergedRange,
    keyword: m.keyword,
    size: session?.size || null,
    color: session?.color || null,
    fit: session?.fit || null,
    style: session?.style || null,
    occasion: session?.occasion || null,
  });
  return orderFilteredProducts(filtered, pool, mergedUserText, m.sortMode);
}

function matchStructuredTextCommand(text) {
  const t = String(text || '').trim();
  if (!t) {
    return null;
  }
  const lower = t.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^under ₹5,?000$/.test(lower) || lower === 'under 5000' || /^under ₹ 5,?000$/.test(lower)) {
    return { kind: 'under_5k' };
  }
  if (/^new arrivals$/i.test(t)) {
    return { kind: 'new_arrivals' };
  }
  for (const row of COLLECTION_CATEGORY_ROWS) {
    if (row.title.toLowerCase() === lower) {
      return { kind: 'category', rowId: row.id, headline: `${row.title} — a few picks:` };
    }
  }
  return null;
}

/** Snapshot category / size / style for soft "welcome back" personalization. */
function persistPersonalizationMemory(waId) {
  const s = db.getUserSession(waId);
  if (!s) {
    return;
  }
  const p = {};
  if (s.category && LIST_ROW_IDS.has(s.category)) {
    p.last_category_row_id = s.category;
    p.last_category_label =
      s.category_label || COLLECTION_CATEGORY_ROWS.find((r) => r.id === s.category)?.title || null;
  }
  if (s.size && String(s.size).trim()) {
    p.last_size = String(s.size).trim();
  }
  if (s.style != null && String(s.style).trim()) {
    p.last_style = String(s.style).trim();
  }
  if (Object.keys(p).length === 0) {
    return;
  }
  db.patchUserSession(waId, p);
}

async function handleWelcomeBackContinue(to, fullCatalog) {
  const s = db.getUserSession(to);
  if (!s?.lastCategoryRowId || !LIST_ROW_IDS.has(s.lastCategoryRowId)) {
    await sendWhatsAppInteractiveButtons(to, GREETING_MENU_BODY, GREETING_MENU_BUTTONS);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[buttons] ${GREETING_MENU_BODY} | ${GREETING_MENU_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
    db.insertChatMessage(to, 'model', GREETING_MENU_BODY, Date.now());
    await sendWhatsAppInteractiveButtons(to, GREETING_MENU_HELP_ROW_BODY, [HELP_ME_CHOOSE_BUTTON_TITLE]);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[buttons] ${GREETING_MENU_HELP_ROW_BODY} | ${HELP_ME_CHOOSE_BUTTON_TITLE}`,
      metaMessageId: null,
    });
    db.insertChatMessage(to, 'model', GREETING_MENU_HELP_ROW_BODY, Date.now());
    await sendQuickReentryButtonRow(to);
    return;
  }
  const rowId = s.lastCategoryRowId;
  const label = String(
    s.lastCategoryLabel || COLLECTION_CATEGORY_ROWS.find((r) => r.id === rowId)?.title || 'your last browse',
  ).trim();
  db.patchUserSession(to, {
    category_row_id: rowId,
    category_label: label,
    size: s.lastSize || null,
    style: s.lastStyle || null,
    color: null,
    fit: null,
    occasion: null,
    price_max_inr: null,
    price_min_inr: null,
    shop_flow_step: null,
    pending_color_options: null,
    selected_product_id: null,
  });
  await deliverBackendCatalogExperience(to, fullCatalog, {
    userText: '',
    categoryListRowId: rowId,
    headline: `Welcome back — ${label}:`,
    offerOptionalColorFilter: true,
  });
}

async function handleWelcomeBackStartFresh(to) {
  db.clearBuyNowFlow(to);
  db.clearFitPrefsSession(to);
  db.wipeUserSession(to);
  db.upsertBrowseState(to, { orderedProductIds: [], nextIndex: 0, lastWindowStart: 0 });
  await sendWhatsAppInteractiveButtons(to, GREETING_MENU_BODY, GREETING_MENU_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${GREETING_MENU_BODY} | ${GREETING_MENU_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', GREETING_MENU_BODY, Date.now());
  await sendWhatsAppInteractiveButtons(to, GREETING_MENU_HELP_ROW_BODY, [HELP_ME_CHOOSE_BUTTON_TITLE]);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${GREETING_MENU_HELP_ROW_BODY} | ${HELP_ME_CHOOSE_BUTTON_TITLE}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', GREETING_MENU_HELP_ROW_BODY, Date.now());
  await sendQuickReentryButtonRow(to);
}

/**
 * Renders a pre-filtered renderable gallery (carousel + browse_state + optional color CTA + post-carousel loop).
 */
async function presentBrowseGalleryWindow(
  to,
  fullCatalog,
  headline,
  galleryProductsInOrder,
  { offerOptionalColorFilter = false, categoryListRowId = null } = {},
) {
  const slice = galleryProductsInOrder.slice(0, PRODUCT_GALLERY_MAX);
  const orderedIds = galleryProductsInOrder.map((p) => String(p.id));

  if (slice.length === 0) {
    const msg =
      'Nothing in that filter right now. Try another category or tell us what you need.';
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    await sendWhatsAppInteractiveButtons(to, 'Browse:', GREETING_MENU_BUTTONS);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[buttons] Browse: | ${GREETING_MENU_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
    db.insertChatMessage(to, 'model', msg, Date.now());
    await sendQuickReentryButtonRow(to);
    return;
  }

  db.patchUserSession(to, {
    selected_product_id: null,
    shop_flow_step: null,
    pending_color_options: null,
  });

  const line = String(headline || 'A few options:').slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(to, line);
  db.logMessage({ waId: to, direction: 'out', body: line, metaMessageId: null });

  await sendProductCarousel(to, slice);
  db.upsertBrowseState(to, {
    orderedProductIds: orderedIds,
    nextIndex: slice.length,
    lastWindowStart: 0,
  });
  db.insertChatMessage(to, 'model', line, Date.now());

  let effectiveCat = categoryListRowId;
  if (!effectiveCat) {
    const s = db.getUserSession(to);
    effectiveCat = s?.category && LIST_ROW_IDS.has(s.category) ? s.category : null;
  }
  if (offerOptionalColorFilter && effectiveCat && LIST_ROW_IDS.has(effectiveCat)) {
    const sessAfter = db.getUserSession(to);
    const colors = collectDistinctColorsForCategory(
      fullCatalog,
      effectiveCat,
      sessAfter?.occasion || null,
    );
    if (colors.length > 0) {
      const filterBody = OPTIONAL_COLOR_FILTER_BODY.slice(0, WA_BODY_MAX);
      await sendWhatsAppInteractiveButtons(to, filterBody, [FILTER_BY_COLOR_BUTTON_TITLE]);
      db.logMessage({
        waId: to,
        direction: 'out',
        body: `[buttons] ${filterBody} | ${FILTER_BY_COLOR_BUTTON_TITLE}`,
        metaMessageId: null,
      });
      db.insertChatMessage(to, 'model', `${filterBody} [Filter by Color]`, Date.now());
    }
  }
  persistPersonalizationMemory(to);
  await sendQuickReentryButtonRow(to);
}

async function deliverBackendCatalogExperience(
  to,
  fullCatalog,
  { userText, categoryListRowId, headline, offerOptionalColorFilter = false },
) {
  const { effectiveCat, mergedUserText } = resolveCatalogQueryContext(to, userText, categoryListRowId);
  const { ordered } = inferFilterAndOrderProducts(fullCatalog, mergedUserText, effectiveCat, to);
  const galleryProducts = [];
  for (const p of ordered) {
    if (productIsCarouselRenderable(p)) {
      galleryProducts.push(p);
    }
  }
  await presentBrowseGalleryWindow(to, fullCatalog, headline, galleryProducts, {
    offerOptionalColorFilter,
    categoryListRowId: effectiveCat,
  });
}

async function applyHelpChooseFiltersAndShowCatalog(from, fullCatalog, rawText) {
  let obj;
  try {
    obj = JSON.parse(stripModelJsonFences(rawText));
  } catch {
    throw new Error('Invalid help-choose filters JSON');
  }
  const catId = normalizeHelpCategoryFromModel(obj.category);
  const categoryLabel =
    catId && LIST_ROW_IDS.has(catId)
      ? COLLECTION_CATEGORY_ROWS.find((r) => r.id === catId)?.title || 'Your picks'
      : 'Your picks';
  const occasion = normalizeHelpOccasionFromModel(obj.occasion);
  const styleStored = normalizeHelpStyleFromModel(obj.style);
  const pr = obj.price_range && typeof obj.price_range === 'object' ? obj.price_range : {};
  let pMin = pr.min != null && Number.isFinite(Number(pr.min)) && Number(pr.min) > 0 ? Number(pr.min) : null;
  let pMax = pr.max != null && Number.isFinite(Number(pr.max)) && Number(pr.max) > 0 ? Number(pr.max) : null;
  if (pMin != null && pMax != null && pMin > pMax) {
    const swap = pMin;
    pMin = pMax;
    pMax = swap;
  }
  db.patchUserSession(from, {
    category_row_id: catId,
    category_label: catId ? categoryLabel : null,
    occasion: occasion || null,
    style: styleStored,
    price_min_inr: pMin,
    price_max_inr: pMax,
    shop_flow_step: null,
    pending_color_options: null,
    selected_product_id: null,
    size: null,
    color: null,
  });
  const cl = db.getUserSession(from)?.category_label || 'Your picks';
  const headline = `${cl} — picks for you:`.slice(0, WA_TEXT_MAX);
  await deliverBackendCatalogExperience(from, fullCatalog, {
    userText: '',
    categoryListRowId: catId && LIST_ROW_IDS.has(catId) ? catId : null,
    headline,
    offerOptionalColorFilter: Boolean(catId && LIST_ROW_IDS.has(catId)),
  });
}

async function sendHelpChooseGeminiQuestion(from, round) {
  const historyRows = db.fetchRecentChatMessages(from, CHAT_HISTORY_LIMIT);
  const contents = buildGeminiContents(historyRows, { audioBase64: null, audioMimeType: 'audio/ogg' });
  const raw = await generateHelpChooseQuestionGemini(contents, round);
  const parsed = JSON.parse(stripModelJsonFences(raw));
  const line = String(parsed.question || '').trim().slice(0, WA_TEXT_MAX);
  if (!line) {
    throw new Error('Empty help-choose question');
  }
  await sendWhatsAppText(from, line);
  db.logMessage({ waId: from, direction: 'out', body: line, metaMessageId: null });
  db.insertChatMessage(from, 'model', line, Date.now());
  await sendQuickReentryButtonRow(from);
}

async function startHelpMeChooseFlow(from) {
  db.patchUserSession(from, {
    shop_flow_step: SHOP_FLOW_HELP_CHOOSE_AWAIT_1,
    pending_color_options: null,
    selected_product_id: null,
    size: null,
    color: null,
    fit: null,
    occasion: null,
    style: null,
    price_min_inr: null,
    price_max_inr: null,
    category_row_id: null,
    category_label: null,
  });
  try {
    await sendHelpChooseGeminiQuestion(from, 1);
  } catch (err) {
    log('error', 'help_choose Q1 failed', { message: err.message });
    db.patchUserSession(from, { shop_flow_step: null });
    const msg =
      'Could not start suggestions right now. Tap Shop Collection to pick a category.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
  }
}

async function handleHelpChooseAfterAnswer1(from) {
  try {
    await sendHelpChooseGeminiQuestion(from, 2);
    db.patchUserSession(from, { shop_flow_step: SHOP_FLOW_HELP_CHOOSE_AWAIT_2 });
  } catch (err) {
    log('error', 'help_choose Q2 failed', { message: err.message });
    db.patchUserSession(from, { shop_flow_step: null });
    const msg =
      'Sorry — that step glitched. Tap Shop Collection to browse, or try Help me choose again.'.slice(
        0,
        WA_TEXT_MAX,
      );
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
  }
}

async function handleHelpChooseAfterAnswer2(from, fullCatalog) {
  try {
    const historyRows = db.fetchRecentChatMessages(from, CHAT_HISTORY_LIMIT);
    const contents = buildGeminiContents(historyRows, { audioBase64: null, audioMimeType: 'audio/ogg' });
    const raw = await generateHelpChooseFiltersGemini(contents);
    await applyHelpChooseFiltersAndShowCatalog(from, fullCatalog, raw);
  } catch (err) {
    log('error', 'help_choose filters failed', { message: err.message });
    db.patchUserSession(from, { shop_flow_step: null });
    const msg =
      'Could not match picks just now. Tap Shop Collection or tell us a category.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
  }
}

async function startStructuredCategorySelection(to, categoryRowId, categoryLabel) {
  db.clearFitPrefsSession(to);
  const label = String(categoryLabel || categoryRowId || 'Category').trim();
  db.patchUserSession(to, {
    category_row_id: categoryRowId,
    category_label: label,
    size: null,
    color: null,
    fit: null,
    occasion: null,
    style: null,
    price_max_inr: null,
    price_min_inr: null,
    shop_flow_step: SHOP_FLOW_AWAIT_OCCASION,
    pending_color_options: null,
    selected_product_id: null,
  });
  const intro = `You picked ${label}. ${SHOP_OCCASION_STEP_BODY}`.slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(to, intro);
  db.logMessage({ waId: to, direction: 'out', body: intro, metaMessageId: null });
  await sendStructuredOccasionSelectionButtons(to);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${SHOP_OCCASION_STEP_BODY} | ${SHOP_OCCASION_LABELS.join(' · ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', `${intro} [occasion buttons]`, Date.now());
  persistPersonalizationMemory(to);
}

/**
 * After category: store occasion (Party | Wedding | Casual | Office), then style step.
 */
async function handleStructuredOccasionChoice(from, occasionLabel, _fullCatalog) {
  const label = String(occasionLabel || '').trim();
  if (!label || !SHOP_OCCASION_LABELS.includes(label)) {
    return false;
  }
  const sess = db.getUserSession(from);
  if (!sess || sess.shop_flow_step !== SHOP_FLOW_AWAIT_OCCASION || !sess.category) {
    const msg =
      'Tap Shop Collection, pick a category, then choose the occasion.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return true;
  }
  void _fullCatalog;
  db.patchUserSession(from, {
    occasion: label,
    style: null,
    shop_flow_step: SHOP_FLOW_AWAIT_STYLE,
  });
  const intro = `Got it — ${label}. ${SHOP_STYLE_STEP_BODY}`.slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(from, intro);
  db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
  await sendStructuredStyleSelectionButtons(from);
  db.logMessage({
    waId: from,
    direction: 'out',
    body: `[buttons] ${SHOP_STYLE_STEP_BODY} | ${SHOP_STYLE_OPTIONS.join(' · ')} · ${SHOP_STYLE_NOT_SURE}`,
    metaMessageId: null,
  });
  db.insertChatMessage(from, 'model', `${intro} [style buttons]`, Date.now());
  return true;
}

/**
 * After occasion: store style (Bodycon | Flowy | A-line) or skip filter on Not sure, then size step.
 */
async function handleStructuredStyleChoice(from, styleLabel, _fullCatalog) {
  const raw = String(styleLabel || '').trim();
  if (!raw) {
    return false;
  }
  const isNotSure = raw === SHOP_STYLE_NOT_SURE || raw.toLowerCase() === SHOP_STYLE_NOT_SURE.toLowerCase();
  const fromOption = SHOP_STYLE_OPTIONS.find((o) => o.toLowerCase() === raw.toLowerCase());
  if (!isNotSure && !fromOption) {
    return false;
  }
  const sess = db.getUserSession(from);
  if (!sess || sess.shop_flow_step !== SHOP_FLOW_AWAIT_STYLE || !sess.category) {
    const msg =
      'Tap Shop Collection, pick a category, then occasion and silhouette.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return true;
  }
  void _fullCatalog;
  const styleStored = isNotSure ? null : fromOption;
  db.patchUserSession(from, {
    style: styleStored,
    shop_flow_step: 'await_size',
  });
  const intro = (
    isNotSure
      ? 'No problem — here is a full range. Next, choose your size.'
      : `Love it — ${fromOption}. Next, choose your size.`
  ).slice(0, WA_TEXT_MAX);
  await sendWhatsAppText(from, intro);
  db.logMessage({ waId: from, direction: 'out', body: intro, metaMessageId: null });
  await sendStructuredSizeSelectionButtons(from);
  db.logMessage({
    waId: from,
    direction: 'out',
    body: `[buttons] ${STRUCT_SIZE_LIST_BODY} | XS S M · L XL`,
    metaMessageId: null,
  });
  db.insertChatMessage(from, 'model', `${intro} [size buttons]`, Date.now());
  return true;
}

/**
 * Apply size choice (from list row id or reply button title): update session, then catalog (color filter optional).
 * @returns {boolean} true if this was a structured size event (consumed or error reply sent).
 */
async function handleStructuredSizeChoice(from, sz, fullCatalog) {
  if (!sz) {
    return false;
  }
  const sess = db.getUserSession(from);
  if (!sess || sess.shop_flow_step !== 'await_size' || !sess.category) {
    const msg =
      'Tap Shop Collection, pick a category, then choose your size.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return true;
  }
  db.patchUserSession(from, {
    size: sz,
    color: null,
    shop_flow_step: null,
    pending_color_options: null,
  });
  const headline = `${sess.category_label || 'Your picks'} — ${sz}:`;
  await deliverBackendCatalogExperience(from, fullCatalog, {
    userText: `Category ${sess.category_label}. Occasion ${sess.occasion || '—'}. Size ${sz}.`,
    categoryListRowId: sess.category,
    headline: headline.slice(0, WA_TEXT_MAX),
    offerOptionalColorFilter: true,
  });
  return true;
}

async function handleStructuredSizeListReply(from, listRowId, fullCatalog) {
  const parsed = structuredSizeFromRowId(listRowId);
  if (!parsed) {
    return false;
  }
  return handleStructuredSizeChoice(from, parsed, fullCatalog);
}

/** Apply color choice (from list row or button title matched to pending options). */
async function handleStructuredColorChoice(from, color, fullCatalog) {
  const picked = String(color || '').trim();
  if (!picked) {
    return false;
  }
  const sess = db.getUserSession(from);
  if (!sess || sess.shop_flow_step !== 'await_color' || !Array.isArray(sess.pending_color_options)) {
    const msg = 'Tap Shop Collection to browse by category first.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return true;
  }
  if (!sess.pending_color_options.includes(picked)) {
    const msg = 'That color is no longer available. Tap Shop Collection to start over.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return true;
  }
  const size = sess.size || '';
  db.patchUserSession(from, {
    color: picked,
    shop_flow_step: null,
    pending_color_options: null,
  });
  const headline = `${sess.category_label || 'Your picks'} — ${size}, ${picked}:`;
  await deliverBackendCatalogExperience(from, fullCatalog, {
    userText: `Category ${sess.category_label}. Occasion ${sess.occasion || '—'}. Size ${size}. Color ${picked}.`,
    categoryListRowId: sess.category,
    headline: headline.slice(0, WA_TEXT_MAX),
    offerOptionalColorFilter: true,
  });
  return true;
}

async function handleStructuredColorListReply(from, listRowId, fullCatalog) {
  const idx = structuredColorIndexFromRowId(listRowId);
  if (idx === null) {
    return false;
  }
  const sess = db.getUserSession(from);
  const color = sess?.pending_color_options?.[idx];
  if (color == null) {
    const msg = 'That color is no longer available. Tap Shop Collection to start over.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return true;
  }
  return handleStructuredColorChoice(from, color, fullCatalog);
}

async function startOptionalStructuredColorFilter(from, fullCatalog) {
  const sess = db.getUserSession(from);
  if (!canStartOptionalColorFilter(sess)) {
    const msg = (
      sess?.category
        ? 'Finish the current step first, or tap Shop Collection to restart.'
        : 'Use Shop Collection to pick a category first, then you can filter by color.'
    ).slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return;
  }
  const colors = collectDistinctColorsForCategory(fullCatalog, sess.category, sess.occasion);
  if (colors.length === 0) {
    const msg = 'No color options to filter for this browse right now.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return;
  }
  db.patchUserSession(from, {
    pending_color_options: JSON.stringify(colors),
    shop_flow_step: 'await_color',
  });
  await sendStructuredColorSelectionButtons(from, colors);
  db.logMessage({
    waId: from,
    direction: 'out',
    body: `[buttons] ${STRUCT_COLOR_LIST_BODY} | ${colors.slice(0, STRUCT_COLOR_ROWS_MAX).join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(from, 'model', `${STRUCT_COLOR_LIST_BODY} [color buttons]`, Date.now());
}

function formatProductPriceLine(priceInr) {
  const n = Number(priceInr);
  if (!Number.isFinite(n)) {
    return 'Price on request';
  }
  return `₹${n.toLocaleString('en-IN')}`;
}

function buildProductCarouselBadgeLines(product) {
  const badges = [];
  if (product?.isBestseller === true) {
    badges.push('🔥 Bestseller');
  }
  if (product?.isTrending === true) {
    badges.push('✨ Trending');
  }
  const r = Number(product?.rating);
  if (Number.isFinite(r) && r > 4) {
    badges.push('⭐ Top rated');
  }
  return badges;
}

function buildProductCarouselCaption(product) {
  const name = String(product?.name || product?.id || 'Product').trim() || 'Product';
  const priceLine = formatProductPriceLine(product?.priceInr);

  const occJoined =
    Array.isArray(product?.occasion) && product.occasion.length > 0
      ? product.occasion
          .map((o) => String(o || '').trim())
          .filter(Boolean)
          .join(', ')
      : '';
  const occLine = occJoined || 'Occasion on request';

  const sizesJoined =
    Array.isArray(product?.sizes) && product.sizes.length > 0
      ? product.sizes
          .map((s) => String(s || '').trim())
          .filter(Boolean)
          .join(', ')
      : '';
  const sizesLine = sizesJoined || 'Sizes on request';

  const badgeLines = buildProductCarouselBadgeLines(product);
  const lines = [`${name} ✨`, priceLine, ''];
  if (badgeLines.length > 0) {
    lines.push(...badgeLines, '');
  }
  lines.push(`✔ ${occLine}`, `✔ Sizes: ${sizesLine}`);
  const cap = lines.join('\n');
  return cap.length > WA_CAPTION_MAX ? cap.slice(0, WA_CAPTION_MAX) : cap;
}

function isProductSizeButtonTitle(buttonTitle) {
  const t = String(buttonTitle || '').trim().toUpperCase();
  return t === 'S' || t === 'M' || t === 'L' || t === 'XL';
}

function normalizedProductSizeLabel(buttonTitle) {
  return String(buttonTitle || '').trim().toUpperCase();
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
  if (t === 'Show Similar') {
    return WA_BUTTON_ACTION.SHOW_SIMILAR;
  }
  if (t === 'Under ₹3000' || t === 'Under Rs3000') {
    return WA_BUTTON_ACTION.UNDER_3K;
  }
  if (t === 'Different Style') {
    return WA_BUTTON_ACTION.DIFFERENT_STYLE;
  }
  if (t === 'Confirm') {
    return WA_BUTTON_ACTION.CONFIRM_PURCHASE;
  }
  if (t === 'Change Size') {
    return WA_BUTTON_ACTION.CHANGE_PURCHASE_SIZE;
  }
  if (t === 'Change Product') {
    return WA_BUTTON_ACTION.CHANGE_PURCHASE_PRODUCT;
  }
  if (t === HELP_ME_CHOOSE_BUTTON_TITLE) {
    return WA_BUTTON_ACTION.HELP_CHOOSE;
  }
  if (t === QUICK_REENTRY_BUTTONS[0]) {
    return WA_BUTTON_ACTION.START_OVER;
  }
  if (t === QUICK_REENTRY_BUTTONS[1]) {
    return WA_BUTTON_ACTION.BROWSE_CATEGORIES;
  }
  if (t === WELCOME_BACK_PERSONALIZE_BUTTONS[0]) {
    return WA_BUTTON_ACTION.CONTINUE_LAST_SHOP;
  }
  if (t === WELCOME_BACK_PERSONALIZE_BUTTONS[1]) {
    return WA_BUTTON_ACTION.START_FRESH_PERSONALIZED;
  }
  return null;
}

function carouselProductSelectTitle(productId) {
  const id = String(productId || '').trim();
  const full = `Select_${id}`;
  return full.length <= WA_BUTTON_TITLE_MAX ? full : full.slice(0, WA_BUTTON_TITLE_MAX);
}

function carouselProductDetailsTitle(productId) {
  const id = String(productId || '').trim();
  const full = `Details_${id}`;
  return full.length <= WA_BUTTON_TITLE_MAX ? full : full.slice(0, WA_BUTTON_TITLE_MAX);
}

function carouselReplyButtonId(kind, productId) {
  const enc = encodeURIComponent(String(productId || '').trim());
  const raw = `aura_${kind}:${enc}`;
  return raw.length > WA_REPLY_BUTTON_ID_MAX ? raw.slice(0, WA_REPLY_BUTTON_ID_MAX) : raw;
}

function parseCarouselProductIdFromReplyId(kind, buttonId) {
  const prefix = `aura_${kind}:`;
  const id = String(buttonId || '').trim();
  if (!id.startsWith(prefix)) {
    return null;
  }
  try {
    return decodeURIComponent(id.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * @returns {{ action: 'select_product'|'view_details_product', productId: string } | null}
 */
function parseProductCarouselButtonReply(buttonReplyId, buttonTitle) {
  const sel = parseCarouselProductIdFromReplyId('sel', buttonReplyId);
  if (sel) {
    return { action: 'select_product', productId: sel };
  }
  const det = parseCarouselProductIdFromReplyId('det', buttonReplyId);
  if (det) {
    return { action: 'view_details_product', productId: det };
  }
  const t = String(buttonTitle || '').trim();
  let m = /^Select_(.+)$/.exec(t);
  if (m && m[1]) {
    return { action: 'select_product', productId: m[1] };
  }
  m = /^Details_(.+)$/.exec(t);
  if (m && m[1]) {
    return { action: 'view_details_product', productId: m[1] };
  }
  return null;
}

/**
 * Meta `product_retailer_id` for sendWhatsAppProductMessage — only when catalog.json sets `wa_product_id`
 * (synced SKU in Commerce Manager). Other ids stay on image/text flow until catalog UI is wired.
 */
function productWaCatalogRetailerId(product) {
  if (!product || typeof product !== 'object') {
    return null;
  }
  if (product.wa_product_id != null && String(product.wa_product_id).trim()) {
    return String(product.wa_product_id).trim();
  }
  return null;
}

function productHasCarouselImage(product) {
  return Boolean(product && typeof product.image_url === 'string' && product.image_url.trim());
}

/** Gallery row: image and/or native product card (native requires wa_product_id + resolvable catalog_id). */
function productIsCarouselRenderable(product) {
  return Boolean(product) && (productHasCarouselImage(product) || Boolean(productWaCatalogRetailerId(product)));
}

function listProductsWithImagesInRagOrder(ragCatalog) {
  const products = Array.isArray(ragCatalog?.products) ? ragCatalog.products : [];
  return products.filter((p) => productIsCarouselRenderable(p));
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
  const name = String(product.name || product.id || 'Product').trim();
  const price = formatProductPriceLine(product.priceInr);
  const fitStr =
    Array.isArray(product.fit) && product.fit.length > 0 ? product.fit.join(', ') : '—';
  const sizesStr =
    Array.isArray(product.sizes) && product.sizes.length > 0
      ? product.sizes.join(', ')
      : '—';
  const occasionStr =
    Array.isArray(product.occasion) && product.occasion.length > 0
      ? product.occasion.join(', ')
      : '—';
  const lines = [
    `Name: ${name}`,
    `Price: ${price}`,
    `Fit: ${fitStr}`,
    `Available sizes: ${sizesStr}`,
    `Occasion: ${occasionStr}`,
  ];
  return lines.join('\n').slice(0, WA_TEXT_MAX);
}

function buyNowConfirmationMessage(fullName) {
  const n = String(fullName || 'there').trim().slice(0, 80) || 'there';
  return `Thanks, ${n}! We have your details. Our team will follow up shortly to confirm your order.`;
}

function parseBuyNowSizeInput(raw) {
  const t = String(raw || '').trim();
  if (!t) {
    return null;
  }
  const fromStd = structuredSizeFromButtonTitle(t);
  if (fromStd) {
    return fromStd;
  }
  return t.slice(0, 32);
}

/** Map free-text to a catalog color string when the product lists colors. */
function resolveTextColorForProduct(raw, product) {
  if (!productRequiresColorPick(product)) {
    return null;
  }
  const t = String(raw || '').trim().toLowerCase();
  if (!t) {
    return null;
  }
  for (const c of product.colors) {
    const s = String(c || '').trim().toLowerCase();
    if (!s) {
      continue;
    }
    if (s === t || s.includes(t) || t.includes(s)) {
      return String(c).trim();
    }
  }
  return null;
}

function occasionPhraseForBuyConfirm(product, sessionOccasion) {
  const fromSession =
    sessionOccasion != null && String(sessionOccasion).trim() ? String(sessionOccasion).trim() : '';
  if (fromSession) {
    return fromSession;
  }
  const first = Array.isArray(product?.occasion) ? String(product.occasion[0] || '').trim() : '';
  if (first) {
    return first;
  }
  return 'what you have planned';
}

function formatBuyConfirmSummaryText(product, sizeStr, colorStr, sessionOccasion) {
  const name = String(product?.name || product?.id || 'this piece').trim();
  const occ = occasionPhraseForBuyConfirm(product, sessionOccasion);
  let sizeLine = '—';
  if (productRequiresSizePick(product)) {
    sizeLine =
      sizeStr && String(sizeStr).trim()
        ? String(sizeStr).trim()
        : '— (choose size below)';
  } else if (sizeStr && String(sizeStr).trim()) {
    sizeLine = String(sizeStr).trim();
  }
  let colorLine = '—';
  if (productRequiresColorPick(product)) {
    colorLine =
      colorStr && String(colorStr).trim()
        ? String(colorStr).trim()
        : '— (choose color below)';
  } else if (colorStr && String(colorStr).trim()) {
    colorLine = String(colorStr).trim();
  }
  const lines = [
    'Great choice ✨',
    '',
    `This ${name} is perfect for ${occ}.`,
    '',
    `Size: ${sizeLine}`,
    `Color: ${colorLine}`,
  ];
  return lines.join('\n').slice(0, WA_TEXT_MAX);
}

async function sendBuyConfirmSummaryAndButtons(to, fullCatalog) {
  const sess = db.getUserSession(to);
  const pid = sess?.selectedProductId;
  if (!pid) {
    return;
  }
  const product = findProductById(fullCatalog, pid);
  if (!product) {
    const msg = 'That product is no longer in the catalog. Browse again and tap Select.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }
  const variantPatch = getInvalidVariantSessionPatch(product, db.getUserSession(to));
  if (Object.keys(variantPatch).length) {
    db.patchUserSession(to, variantPatch);
  }
  const s = db.getUserSession(to);
  if (productRequiresSizePick(product) && !sizeAllowedForProduct(product, s?.size)) {
    await promptSizeForSelectedProduct(to, product);
    return;
  }
  if (productRequiresColorPick(product) && !colorAllowedForProduct(product, s?.color)) {
    await promptColorForSelectedProduct(to, product);
    return;
  }
  db.patchUserSession(to, { shop_flow_step: SHOP_FLOW_AWAIT_BUY_CONFIRM });
  const body = formatBuyConfirmSummaryText(product, s?.size, s?.color, s?.occasion);
  await sendWhatsAppText(to, body);
  db.logMessage({ waId: to, direction: 'out', body, metaMessageId: null });
  await sendWhatsAppInteractiveButtons(to, BUY_CONFIRM_BUTTONS_BODY, BUY_CONFIRM_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${BUY_CONFIRM_BUTTONS_BODY} | ${BUY_CONFIRM_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', `${body} [confirm buttons]`, Date.now());
  await sendQuickReentryButtonRow(to);
}

/**
 * After Select (or Buy Now with selection): validate size/color for this product, then confirm card.
 */
async function continuePurchaseSelectionAfterSelect(to, fullCatalog) {
  const pid = db.getUserSession(to)?.selectedProductId;
  if (!pid) {
    const msg = BUY_NOW_NEED_SELECT_FIRST.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }
  const product = findProductById(fullCatalog, pid);
  if (!product) {
    const msg = 'That product is no longer available. Browse again and tap Select.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }
  await sendBuyConfirmSummaryAndButtons(to, fullCatalog);
}

/** Buy Now tap: require selected product; show size ask or confirmation — does not start lead flow. */
async function handleBuyNowLeadCapture(to) {
  db.clearFitPrefsSession(to);
  db.patchUserSession(to, {
    pending_color_options: null,
  });

  let fullCatalog;
  try {
    fullCatalog = loadCatalog();
  } catch (err) {
    log('error', 'Failed to read catalog.json', { message: err.message });
    const apology =
      'We could not load the catalog just now. Please try Buy Again in a moment.';
    await sendWhatsAppText(to, apology.slice(0, WA_TEXT_MAX));
    db.logMessage({ waId: to, direction: 'out', body: apology, metaMessageId: null });
    db.insertChatMessage(to, 'model', apology, Date.now());
    return;
  }

  const productId = db.getUserSession(to)?.selectedProductId;
  if (!productId || !String(productId).trim()) {
    const msg = BUY_NOW_NEED_SELECT_FIRST.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }

  await continuePurchaseSelectionAfterSelect(to, fullCatalog);
}

/** After user taps Confirm on purchase summary — starts SQLite buy_now_flow (name / phone / address). */
async function startBuyNowLeadCaptureAfterConfirm(to) {
  db.clearFitPrefsSession(to);
  db.patchUserSession(to, {
    pending_color_options: null,
  });

  let fullCatalog;
  try {
    fullCatalog = loadCatalog();
  } catch (err) {
    log('error', 'Failed to read catalog.json', { message: err.message });
    const apology =
      'We could not load the catalog just now. Please try again in a moment.';
    await sendWhatsAppText(to, apology.slice(0, WA_TEXT_MAX));
    db.logMessage({ waId: to, direction: 'out', body: apology, metaMessageId: null });
    db.insertChatMessage(to, 'model', apology, Date.now());
    return;
  }

  const productId = db.getUserSession(to)?.selectedProductId;
  if (!productId || !String(productId).trim()) {
    const msg = BUY_NOW_NEED_SELECT_FIRST.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }

  const product = findProductById(fullCatalog, productId);
  if (!product) {
    const msg = 'That product is no longer available. Please browse and select again.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }

  const variantPatch = getInvalidVariantSessionPatch(product, db.getUserSession(to));
  if (Object.keys(variantPatch).length) {
    db.patchUserSession(to, variantPatch);
  }
  const sess = db.getUserSession(to);

  if (productRequiresSizePick(product) && !sizeAllowedForProduct(product, sess?.size)) {
    db.patchUserSession(to, { shop_flow_step: SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE });
    await promptSizeForSelectedProduct(to, product);
    return;
  }

  if (productRequiresColorPick(product) && !colorAllowedForProduct(product, sess?.color)) {
    db.patchUserSession(to, { shop_flow_step: SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR });
    await promptColorForSelectedProduct(to, product);
    return;
  }

  db.patchUserSession(to, { shop_flow_step: null });

  const sessionSize =
    productRequiresSizePick(product) && sess?.size ? String(sess.size).trim() : '';

  db.upsertBuyNowFlow(to, {
    step: 'await_name',
    draftName: null,
    draftPhone: null,
    draftProductId: productId,
    draftSize: sessionSize || null,
  });
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

async function handleBuyNowFlowReply(from, kind, inbound) {
  const flow = db.getBuyNowFlow(from);
  if (!flow) {
    return;
  }

  if (flow.step !== 'await_buy_size' && kind === 'button_reply') {
    const prompt = BUY_NOW_TEXT_ONLY_STEP.slice(0, WA_TEXT_MAX);
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

  const text =
    kind === 'button_reply'
      ? String(inbound?.buttonTitle || '').trim()
      : String(inbound?.text || '').trim();

  if (flow.step === 'await_buy_size') {
    let fullCatalog;
    try {
      fullCatalog = loadCatalog();
    } catch (err) {
      log('error', 'Failed to read catalog.json', { message: err.message });
      const apology =
        'We could not load the catalog. Please try again in a moment.'.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, apology);
      db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
      db.insertChatMessage(from, 'model', apology, Date.now());
      return;
    }
    const product = findProductById(fullCatalog, flow.draftProductId);
    if (!product) {
      const apology =
        'We could not find that product in the catalog. Please browse and tap Buy Now again.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, apology);
      db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
      db.insertChatMessage(from, 'model', apology, Date.now());
      db.clearBuyNowFlow(from);
      return;
    }
    let sz = null;
    if (kind === 'button_reply' && inbound?.buyVariantPick?.kind === 'size') {
      sz = inbound.buyVariantPick.value;
    } else if (kind === 'button_reply') {
      sz = structuredSizeFromButtonTitle(text);
      if (!sz && product && productRequiresSizePick(product)) {
        const t = String(text || '').trim();
        const hit = product.sizes.find(
          (s) =>
            String(s).trim() === t || String(s).trim().slice(0, WA_BUTTON_TITLE_MAX) === t,
        );
        if (hit) {
          sz = String(hit).trim();
        }
      }
    } else if (text) {
      sz = parseBuyNowSizeInput(text);
    }
    if (!sz || !sizeAllowedForProduct(product, sz)) {
      const prompt = (
        productRequiresSizePick(product)
          ? `Choose a size listed for this product: ${product.sizes.join(', ')}.`
          : 'Tap a size button above or type your size in a message.'
      ).slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, prompt);
      db.logMessage({
        waId: from,
        direction: 'out',
        body: prompt,
        metaMessageId: null,
      });
      db.insertChatMessage(from, 'model', prompt, Date.now());
      if (productRequiresSizePick(product)) {
        await sendBuyFlowSizeButtonsForProduct(from, product);
      } else {
        await sendStructuredSizeSelectionButtons(from);
      }
      return;
    }
    const normalized = String(sz).trim();
    db.patchUserSession(from, { size: normalized });
    db.upsertBuyNowFlow(from, {
      step: 'await_name',
      draftSize: normalized,
    });
    const next = BUY_NOW_ASK_NAME.slice(0, WA_TEXT_MAX);
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
    const productId = flow.draftProductId || '';
    const sizeLine = flow.draftSize || db.getUserSession(from)?.size || '';
    const colorLine = db.getUserSession(from)?.color || '';
    const rawSnippet =
      `Buy now | product ${productId} | size ${sizeLine} | color ${colorLine} | ${fullName} | ${phone} | ${address}`.slice(
        0,
        2000,
      );
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
      product_id: productId || undefined,
      size: sizeLine || undefined,
      color: colorLine || undefined,
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

async function handleShowSimilarProducts(to, fullCatalog) {
  const sess = db.getUserSession(to);
  const state = db.getBrowseState(to);
  const exclude = new Set((state?.orderedProductIds || []).map(String));
  const anchorId =
    state?.orderedProductIds?.[state?.lastWindowStart ?? 0] ||
    state?.orderedProductIds?.[0] ||
    sess?.selectedProductId ||
    null;
  const anchor = anchorId ? findProductById(fullCatalog, anchorId) : null;

  let orderedAll = [];

  if (sess?.category && LIST_ROW_IDS.has(sess.category) && sess?.occasion) {
    const merged = augmentUserTextWithSession(to, 'More in the same category and occasion.');
    const { ordered } = inferFilterAndOrderProducts(fullCatalog, merged, sess.category, to);
    let filtered = ordered.filter((p) => !exclude.has(String(p.id)));
    if (filtered.length === 0 && ordered.length > 0) {
      filtered = ordered;
    }
    orderedAll = filtered;
  } else if (anchor && String(anchor.category || '').trim()) {
    const pool = Array.isArray(fullCatalog.products) ? fullCatalog.products : [];
    const occ = sess?.occasion || null;
    const ac = String(anchor.category || '').trim().toLowerCase();
    const matched = pool.filter((p) => {
      if (exclude.has(String(p.id))) return false;
      const pc = String(p.category || '').trim().toLowerCase();
      if (pc !== ac) return false;
      if (occ && !productMatchesSessionOccasion(p, occ)) return false;
      return true;
    });
    let ranked = orderFilteredProducts(matched, pool, '', 'relevance');
    if (ranked.length === 0) {
      const matched2 = pool.filter((p) => {
        const pc = String(p.category || '').trim().toLowerCase();
        if (pc !== ac) return false;
        if (occ && !productMatchesSessionOccasion(p, occ)) return false;
        return true;
      });
      ranked = orderFilteredProducts(matched2, pool, '', 'relevance');
    }
    orderedAll = ranked;
  } else {
    const msg =
      'Open Shop Collection and pick a category first — then Show Similar can find related pieces.'.slice(
        0,
        WA_TEXT_MAX,
      );
    await sendWhatsAppText(to, msg);
    db.logMessage({ waId: to, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(to, 'model', msg, Date.now());
    return;
  }

  const galleryProducts = [];
  for (const p of orderedAll) {
    if (productIsCarouselRenderable(p)) {
      galleryProducts.push(p);
    }
  }
  await presentBrowseGalleryWindow(to, fullCatalog, 'Similar picks:', galleryProducts, {
    offerOptionalColorFilter: Boolean(sess?.category && LIST_ROW_IDS.has(sess.category)),
    categoryListRowId: sess?.category && LIST_ROW_IDS.has(sess.category) ? sess.category : null,
  });
}

async function handleUnder3kBrowse(to, fullCatalog) {
  const sess = db.getUserSession(to);
  db.patchUserSession(to, {
    price_max_inr: UNDER_3K_CAP_INR,
  });
  const label = sess?.category_label || 'matches';
  await deliverBackendCatalogExperience(to, fullCatalog, {
    userText: `Under ₹${UNDER_3K_CAP_INR}`,
    categoryListRowId: sess?.category && LIST_ROW_IDS.has(sess.category) ? sess.category : null,
    headline: `Under ₹3,000 — ${label}:`.slice(0, WA_TEXT_MAX),
    offerOptionalColorFilter: Boolean(sess?.category && LIST_ROW_IDS.has(sess.category)),
  });
}

async function handleDifferentStyleBrowse(to, fullCatalog) {
  const sess = db.getUserSession(to);
  const next = nextStyleInRotation(sess?.style ?? null);
  db.patchUserSession(to, {
    style: next,
  });
  const size = sess?.size || '—';
  const cl = sess?.category_label || 'Your picks';
  await deliverBackendCatalogExperience(to, fullCatalog, {
    userText: `Category ${cl}. Occasion ${sess?.occasion || '—'}. Size ${size}. Style ${next}.`,
    categoryListRowId: sess?.category && LIST_ROW_IDS.has(sess.category) ? sess.category : null,
    headline: `${cl} — ${next}:`.slice(0, WA_TEXT_MAX),
    offerOptionalColorFilter: Boolean(sess?.category && LIST_ROW_IDS.has(sess.category)),
  });
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

  db.patchUserSession(to, {
    selected_product_id: null,
    shop_flow_step: null,
    pending_color_options: null,
  });
  await sendProductCarousel(to, slice);
  db.upsertBrowseState(to, {
    orderedProductIds,
    nextIndex: nextIndex + slice.length,
    lastWindowStart: nextIndex,
  });
  const modelNote = `[show_more] ${slice.map((p) => p.name || p.id).join(' | ')}`;
  db.insertChatMessage(to, 'model', modelNote, Date.now());
  await sendQuickReentryButtonRow(to);
}

async function handleViewProductDetails(to, fullCatalog, explicitProductId = null) {
  const explicit = explicitProductId != null && String(explicitProductId).trim() ? String(explicitProductId).trim() : null;
  const fromSession = db.getUserSession(to)?.selectedProductId;
  const sessionId = fromSession && String(fromSession).trim() ? String(fromSession).trim() : null;
  const state = db.getBrowseState(to);
  const idx = state?.lastWindowStart ?? 0;
  const spotlightId = state?.orderedProductIds?.[idx] || state?.orderedProductIds?.[0] || null;
  const id = explicit || sessionId || spotlightId;
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

  const body1 = PRODUCT_SIZE_BODY.slice(0, WA_BODY_MAX);
  await sendWhatsAppInteractiveButtons(to, body1, PRODUCT_SIZE_BUTTONS_FIRST);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${body1} | ${PRODUCT_SIZE_BUTTONS_FIRST.join(' | ')}`,
    metaMessageId: null,
  });
  const body2 = PRODUCT_SIZE_BODY_XL.slice(0, WA_BODY_MAX);
  await sendWhatsAppInteractiveButtons(to, body2, PRODUCT_SIZE_BUTTONS_XL);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${body2} | ${PRODUCT_SIZE_BUTTONS_XL.join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(
    to,
    'model',
    `${body1} / ${body2} (S, M, L, XL)`,
    Date.now(),
  );
  await sendQuickReentryButtonRow(to);
}

async function sendCategoryFilterListAndLog(to) {
  db.clearBuyNowFlow(to);
  db.clearFitPrefsSession(to);
  db.upsertBrowseState(to, { orderedProductIds: [], nextIndex: 0, lastWindowStart: 0 });
  db.clearUserSession(to);
  db.patchUserSession(to, { shop_flow_step: 'await_category' });
  await sendShopCollectionCategoryButtons(to);
  const outLog = `[buttons] ${SHOP_COLLECTION_CATEGORY_BODY} | ${COLLECTION_CATEGORY_ROWS.map((r) => r.title).join(' | ')} | ${HELP_ME_CHOOSE_BUTTON_TITLE}`;
  db.logMessage({
    waId: to,
    direction: 'out',
    body: outLog,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', SHOP_COLLECTION_CATEGORY_BODY, Date.now());
}

async function sendOneProductImage(to, imageUrl, caption) {
  if (WA_IMAGE_PREFER_LINK) {
    try {
      await sendWhatsAppImageByLink(to, imageUrl, caption);
      return;
    } catch (err) {
      log('warn', 'Image by link failed; uploading media', { message: err.message });
    }
  }
  try {
    await sendWhatsAppImageWithCache(to, imageUrl, caption);
  } catch (err) {
    log('warn', 'Cached media upload failed; falling back to image link', { message: err.message });
    await sendWhatsAppImageByLink(to, imageUrl, caption);
  }
}

/**
 * For each product (max PRODUCT_GALLERY_MAX):
 * - If `wa_product_id` is set and catalog_id is configured → native interactive product message.
 * - Else → image (+ caption) when `image_url` is set.
 * Then Select_/Details_ reply buttons (product_id in reply id: aura_sel: / aura_det:).
 * Finally: Show More, Filter, Buy Now (unchanged).
 */
async function sendProductCarousel(to, products) {
  const list = (Array.isArray(products) ? products : [])
    .filter((p) => productIsCarouselRenderable(p))
    .slice(0, PRODUCT_GALLERY_MAX);
  if (list.length === 0) {
    return;
  }

  let catalogId = null;
  try {
    catalogId = await fetchWhatsAppCatalogId();
  } catch (err) {
    log('warn', 'Could not resolve WhatsApp catalog_id for product messages', { message: err.message });
  }

  const needsNative = list.some((p) => productWaCatalogRetailerId(p));
  if (needsNative && !catalogId) {
    logWhatsAppCatalogConfigOnce({ reason: 'carousel_needs_catalog_id', product_ids: list.map((p) => p.id) });
  }

  const sendOneCarouselImage = async (url, caption) => {
    if (WA_IMAGE_PREFER_LINK) {
      try {
        await sendWhatsAppImageByLink(to, url, caption);
      } catch (err) {
        log('warn', 'Carousel image link failed; upload', { message: err.message });
        await sendWhatsAppImageWithCache(to, url, caption);
      }
    } else {
      const mediaId = await resolveWhatsAppMediaIdForImageUrl(url);
      const cap =
        caption && caption.length > WA_CAPTION_MAX ? caption.slice(0, WA_CAPTION_MAX) : caption || undefined;
      await graphSendMessage({
        to,
        type: 'image',
        image: cap ? { id: mediaId, caption: cap } : { id: mediaId },
      });
    }
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[image] ${url} | ${caption}`,
      metaMessageId: null,
    });
  };

  for (const p of list) {
    const caption = buildProductCarouselCaption(p);
    const bodyText = caption.slice(0, WA_BODY_MAX);
    const waPid = productWaCatalogRetailerId(p);
    let showedAsset = false;

    const useNativeProduct = Boolean(waPid && catalogId);

    if (useNativeProduct) {
      try {
        await sendWhatsAppProductMessage(to, {
          catalogId,
          productRetailerId: waPid,
          bodyText,
          footerText: null,
        });
        db.logMessage({
          waId: to,
          direction: 'out',
          body: `[product] catalog_id=${catalogId} product_retailer_id=${waPid}`,
          metaMessageId: null,
        });
        showedAsset = true;
      } catch (err) {
        log('warn', 'WhatsApp product message failed; falling back to image if available', {
          message: err.message,
          product_id: p.id,
        });
      }
    }

    if (!showedAsset && productHasCarouselImage(p)) {
      await sendOneCarouselImage(p.image_url.trim(), caption);
      showedAsset = true;
    }

    if (!showedAsset) {
      log('warn', 'Carousel slot skipped: no image and no successful product message', { product_id: p.id });
      continue;
    }

    const pid = String(p.id || '').trim();
    if (pid) {
      const itemBody = PRODUCT_CAROUSEL_ITEM_BODY.slice(0, WA_BODY_MAX);
      await sendWhatsAppInteractiveReplyButtons(to, itemBody, [
        { id: carouselReplyButtonId('sel', pid), title: carouselProductSelectTitle(pid) },
        { id: carouselReplyButtonId('det', pid), title: carouselProductDetailsTitle(pid) },
      ]);
      db.logMessage({
        waId: to,
        direction: 'out',
        body: `[buttons] ${itemBody} | Select ${pid} | Details ${pid}`,
        metaMessageId: null,
      });
    }
  }

  const interactiveBody = PRODUCT_CAROUSEL_BODY.slice(0, WA_BODY_MAX);
  await sendWhatsAppInteractiveButtons(to, interactiveBody, PRODUCT_CAROUSEL_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${interactiveBody} | ${PRODUCT_CAROUSEL_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });

  const exploreBody = POST_CAROUSEL_EXPLORE_BODY.slice(0, WA_BODY_MAX);
  await sendWhatsAppInteractiveButtons(to, exploreBody, POST_CAROUSEL_BUTTONS);
  db.logMessage({
    waId: to,
    direction: 'out',
    body: `[buttons] ${exploreBody} | ${POST_CAROUSEL_BUTTONS.join(' | ')}`,
    metaMessageId: null,
  });
  db.insertChatMessage(to, 'model', `${exploreBody} [post-carousel loop]`, Date.now());
}

async function deliverHybridGeminiReply(to, geminiRawText, fullCatalog, userText, categoryListRowId) {
  let decision;
  try {
    decision = parseDecisionEngineReply(geminiRawText);
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
    await sendQuickReentryButtonRow(to);
    return;
  }

  const ordered = orderedProductsFromMergedFilters(fullCatalog, userText, categoryListRowId, decision, to);
  const galleryProducts = [];
  for (const p of ordered) {
    if (productIsCarouselRenderable(p)) {
      galleryProducts.push(p);
    }
  }

  const headline =
    decision.brief_reply && decision.brief_reply.trim()
      ? decision.brief_reply.trim()
      : 'A few ideas below — tap to continue.';

  if (galleryProducts.length > 0) {
    db.patchUserSession(to, {
      selected_product_id: null,
      shop_flow_step: null,
      pending_color_options: null,
    });
    const slice = galleryProducts.slice(0, PRODUCT_GALLERY_MAX);
    await sendWhatsAppText(to, headline.slice(0, WA_TEXT_MAX));
    db.logMessage({
      waId: to,
      direction: 'out',
      body: headline.slice(0, WA_TEXT_MAX),
      metaMessageId: null,
    });
    await sendProductCarousel(to, slice);
    const orderedIds = galleryProducts.map((p) => String(p.id));
    db.upsertBrowseState(to, {
      orderedProductIds: orderedIds,
      nextIndex: slice.length,
      lastWindowStart: 0,
    });
    db.insertChatMessage(to, 'model', headline, Date.now());
    await sendQuickReentryButtonRow(to);
    return;
  }

  const body =
    headline ||
    'Tell us the occasion, budget, or category — or tap Shop Collection to browse.';
  if (decision.suggested_buttons.length > 0) {
    await sendWhatsAppInteractiveButtons(to, body.slice(0, WA_BODY_MAX), decision.suggested_buttons);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[buttons] ${body.slice(0, WA_BODY_MAX)} | ${decision.suggested_buttons.join(' | ')}`,
      metaMessageId: null,
    });
  } else {
    await sendWhatsAppInteractiveButtons(to, body.slice(0, WA_BODY_MAX), GREETING_MENU_BUTTONS);
    db.logMessage({
      waId: to,
      direction: 'out',
      body: `[buttons] ${body.slice(0, WA_BODY_MAX)} | ${GREETING_MENU_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
  }
  db.insertChatMessage(to, 'model', body.slice(0, WA_TEXT_MAX), Date.now());
  await sendQuickReentryButtonRow(to);
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
      const buttonReplyId = String(ir.button_reply.id || '').trim();
      const productCarousel = parseProductCarouselButtonReply(buttonReplyId, buttonTitle);
      const buyVariantPick = parseBuyVariantButtonReply(buttonReplyId);
      return {
        from,
        kind: 'button_reply',
        buttonTitle,
        buttonReplyId,
        buttonAction:
          productCarousel || buyVariantPick ? null : mapButtonReplyToAction(buttonTitle),
        productCarousel,
        buyVariantPick: buyVariantPick || undefined,
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
    if (inbound.productCarousel?.action === 'select_product' && inbound.productCarousel.productId) {
      userTextForRag = `[Product selected: ${inbound.productCarousel.productId}]`;
    } else if (
      inbound.productCarousel?.action === 'view_details_product' &&
      inbound.productCarousel.productId
    ) {
      userTextForRag = `[View details for product: ${inbound.productCarousel.productId}]`;
    } else if (inbound.buttonAction) {
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

  const buyNowFlowRow = db.getBuyNowFlow(from);
  const activeBuyNowFlow =
    buyNowFlowRow && (kind === 'text' || kind === 'button_reply');

  const lastUserTs = db.getLastUserInboundTimestamp(from);
  const now = Date.now();
  if (!buyNowFlowRow && lastUserTs != null && now - lastUserTs > TWENTY_FOUR_H_MS) {
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

  if (
    kind === 'button_reply' &&
    (inbound.buttonAction === WA_BUTTON_ACTION.START_OVER ||
      inbound.buttonAction === WA_BUTTON_ACTION.BROWSE_CATEGORIES)
  ) {
    if (inbound.buttonAction === WA_BUTTON_ACTION.START_OVER) {
      await handleQuickReentryStartOver(from);
    } else {
      await sendCategoryFilterListAndLog(from);
    }
    return;
  }

  const helpStepAfterInbound = db.getUserSession(from)?.shop_flow_step;
  if (
    kind === 'audio' &&
    (helpStepAfterInbound === SHOP_FLOW_HELP_CHOOSE_AWAIT_1 ||
      helpStepAfterInbound === SHOP_FLOW_HELP_CHOOSE_AWAIT_2)
  ) {
    const msg = 'Please send a short text reply for this step.'.slice(0, WA_TEXT_MAX);
    await sendWhatsAppText(from, msg);
    db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
    db.insertChatMessage(from, 'model', msg, Date.now());
    return;
  }

  if (activeBuyNowFlow) {
    await handleBuyNowFlowReply(from, kind, inbound);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.CONTINUE_LAST_SHOP) {
    let fcCont;
    try {
      fcCont = loadCatalog();
    } catch (err) {
      log('error', 'Failed to read catalog.json (welcome back continue)', { message: err.message });
      const apology =
        'We are having a brief technical issue loading our catalog. Please try again in a moment.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, apology);
      db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
      db.insertChatMessage(from, 'model', apology, Date.now());
      return;
    }
    await handleWelcomeBackContinue(from, fcCont);
    return;
  }
  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.START_FRESH_PERSONALIZED) {
    await handleWelcomeBackStartFresh(from);
    return;
  }

  if (kind === 'text' && inbound.text && !db.getBuyNowFlow(from)) {
    const trimmedFlex = inbound.text.trim();
    if (parseFlexibleShopNavIntents(trimmedFlex)) {
      try {
        const fcFlex = loadCatalog();
        if (await tryFlexibleShopTextNavigation(from, trimmedFlex, fcFlex)) {
          return;
        }
      } catch (err) {
        log('error', 'Failed to read catalog.json (flex nav)', { message: err.message });
      }
    }
  }

  const sessStruct = db.getUserSession(from);
  if (kind === 'text' && sessStruct?.shop_flow_step) {
    const step = sessStruct.shop_flow_step;
    if (step === SHOP_FLOW_HELP_CHOOSE_AWAIT_1) {
      if (!GEMINI_API_KEY) {
        const msg =
          'Our stylist assistant is not configured. Tap Shop Collection to browse.'.slice(0, WA_TEXT_MAX);
        await sendWhatsAppText(from, msg);
        db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
        db.insertChatMessage(from, 'model', msg, Date.now());
        db.patchUserSession(from, { shop_flow_step: null });
        return;
      }
      await handleHelpChooseAfterAnswer1(from);
      return;
    }
    if (step === SHOP_FLOW_HELP_CHOOSE_AWAIT_2) {
      if (!GEMINI_API_KEY) {
        const msg =
          'Our stylist assistant is not configured. Tap Shop Collection to browse.'.slice(0, WA_TEXT_MAX);
        await sendWhatsAppText(from, msg);
        db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
        db.insertChatMessage(from, 'model', msg, Date.now());
        db.patchUserSession(from, { shop_flow_step: null });
        return;
      }
      let fcHelp;
      try {
        fcHelp = loadCatalog();
      } catch (err) {
        log('error', 'Failed to read catalog.json', { message: err.message });
        const apology =
          'We could not load the catalog. Please try again in a moment.'.slice(0, WA_TEXT_MAX);
        await sendWhatsAppText(from, apology);
        db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
        db.insertChatMessage(from, 'model', apology, Date.now());
        return;
      }
      await handleHelpChooseAfterAnswer2(from, fcHelp);
      return;
    }
    if (step === SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE) {
      let fc;
      try {
        fc = loadCatalog();
      } catch (err) {
        log('error', 'Failed to read catalog.json', { message: err.message });
        const apology =
          'We could not load the catalog. Please try again in a moment.';
        await sendWhatsAppText(from, apology.slice(0, WA_TEXT_MAX));
        db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
        db.insertChatMessage(from, 'model', apology, Date.now());
        return;
      }
      const pid = sessStruct.selectedProductId;
      const product = pid ? findProductById(fc, pid) : null;
      const sz = parseBuyNowSizeInput(inbound.text);
      if (sz && product && sizeAllowedForProduct(product, sz)) {
        db.patchUserSession(from, { size: String(sz).trim(), shop_flow_step: null });
        await sendBuyConfirmSummaryAndButtons(from, fc);
        return;
      }
      const listed =
        product && productRequiresSizePick(product) ? product.sizes.join(', ') : '';
      const msg = (
        listed
          ? `Pick a size from the buttons or type one of: ${listed}.`
          : 'Tap a size button above or type your size (e.g. M).'
      ).slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (step === SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR) {
      let fc;
      try {
        fc = loadCatalog();
      } catch (err) {
        log('error', 'Failed to read catalog.json', { message: err.message });
        const apology =
          'We could not load the catalog. Please try again in a moment.';
        await sendWhatsAppText(from, apology.slice(0, WA_TEXT_MAX));
        db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
        db.insertChatMessage(from, 'model', apology, Date.now());
        return;
      }
      const pid = sessStruct.selectedProductId;
      const product = pid ? findProductById(fc, pid) : null;
      const col = resolveTextColorForProduct(inbound.text, product);
      if (col && product && colorAllowedForProduct(product, col)) {
        db.patchUserSession(from, { color: col, shop_flow_step: null });
        await sendBuyConfirmSummaryAndButtons(from, fc);
        return;
      }
      const listed =
        product && productRequiresColorPick(product) ? product.colors.join(', ') : '';
      const msg = (
        listed
          ? `Pick a color from the buttons or type one of: ${listed}.`
          : 'Tap a color button above or type the color name.'
      ).slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (step === SHOP_FLOW_AWAIT_BUY_CONFIRM) {
      const msg =
        'Please tap Confirm, Change Size, or Show Similar above.'.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (step === SHOP_FLOW_AWAIT_OCCASION) {
      let fc;
      try {
        fc = loadCatalog();
      } catch (err) {
        log('error', 'Failed to read catalog.json', { message: err.message });
        const apology =
          'We could not load the catalog. Please try again in a moment.';
        await sendWhatsAppText(from, apology.slice(0, WA_TEXT_MAX));
        db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
        db.insertChatMessage(from, 'model', apology, Date.now());
        return;
      }
      const occ = parseOccasionFromUserText(inbound.text);
      if (occ) {
        await handleStructuredOccasionChoice(from, occ, fc);
        return;
      }
      const msg =
        'Tap Party, Wedding, Casual, or Office above (or type one of those words).'.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (step === SHOP_FLOW_AWAIT_STYLE) {
      let fc;
      try {
        fc = loadCatalog();
      } catch (err) {
        log('error', 'Failed to read catalog.json', { message: err.message });
        const apology =
          'We could not load the catalog. Please try again in a moment.';
        await sendWhatsAppText(from, apology.slice(0, WA_TEXT_MAX));
        db.logMessage({ waId: from, direction: 'out', body: apology, metaMessageId: null });
        db.insertChatMessage(from, 'model', apology, Date.now());
        return;
      }
      const st = parseStyleFromUserText(inbound.text);
      if (st) {
        await handleStructuredStyleChoice(from, st, fc);
        return;
      }
      const msg =
        'Tap Bodycon, Flowy, A-line, or Not sure above (or type one of those).'.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    let hint = '';
    if (step === 'await_category') {
      hint =
        'Tap a category or Help me choose above, or tap Shop Collection to start over.';
    } else if (step === 'await_size') {
      hint =
        'Please tap your size from the buttons above, or tap Shop Collection to start over.';
    } else if (step === 'await_color') {
      hint =
        'Please tap a color from the buttons above, or tap Shop Collection to start over.';
    }
    if (hint) {
      const msg = hint.slice(0, WA_TEXT_MAX);
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
  }

  const sessWelcome = db.getUserSession(from);
  const welcomeBackCategoryLabel =
    sessWelcome?.lastCategoryRowId && LIST_ROW_IDS.has(sessWelcome.lastCategoryRowId)
      ? String(
          sessWelcome.lastCategoryLabel ||
            COLLECTION_CATEGORY_ROWS.find((r) => r.id === sessWelcome.lastCategoryRowId)?.title ||
            '',
        ).trim()
      : '';
  const showWelcomeBackPersonalization =
    !hadNoPriorChat &&
    kind === 'text' &&
    isHiHelloGreeting(userTextForRag) &&
    Boolean(welcomeBackCategoryLabel);

  if (showWelcomeBackPersonalization) {
    const body = `Welcome back ✨

Want to continue with:
${welcomeBackCategoryLabel}?`.slice(0, WA_BODY_MAX);
    await sendWhatsAppInteractiveButtons(from, body, WELCOME_BACK_PERSONALIZE_BUTTONS);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: `[buttons] ${body} | ${WELCOME_BACK_PERSONALIZE_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', body, Date.now());
    await sendQuickReentryButtonRow(from);
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
    await sendWhatsAppInteractiveButtons(from, GREETING_MENU_HELP_ROW_BODY, [HELP_ME_CHOOSE_BUTTON_TITLE]);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: `[buttons] ${GREETING_MENU_HELP_ROW_BODY} | ${HELP_ME_CHOOSE_BUTTON_TITLE}`,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', GREETING_MENU_HELP_ROW_BODY, Date.now());
    await sendQuickReentryButtonRow(from);
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

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.HELP_CHOOSE) {
    if (!GEMINI_API_KEY) {
      const msg =
        'Our stylist assistant is not configured yet. Tap Shop Collection to browse categories.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    await startHelpMeChooseFlow(from);
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

  if (
    kind === 'button_reply' &&
    (inbound.buttonAction === WA_BUTTON_ACTION.SHOW_SIMILAR ||
      inbound.buttonAction === WA_BUTTON_ACTION.UNDER_3K ||
      inbound.buttonAction === WA_BUTTON_ACTION.DIFFERENT_STYLE)
  ) {
    const st = db.getUserSession(from)?.shop_flow_step;
    if (st === SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE || st === SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR) {
      const msg =
        'Finish picking size or color with the buttons above, then confirm your order.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
  }

  if (kind === 'button_reply' && inbound.buttonTitle === FILTER_BY_COLOR_BUTTON_TITLE) {
    await startOptionalStructuredColorFilter(from, fullCatalog);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.SHOW_SIMILAR) {
    await handleShowSimilarProducts(from, fullCatalog);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.UNDER_3K) {
    await handleUnder3kBrowse(from, fullCatalog);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonAction === WA_BUTTON_ACTION.DIFFERENT_STYLE) {
    await handleDifferentStyleBrowse(from, fullCatalog);
    return;
  }

  if (
    kind === 'button_reply' &&
    inbound.productCarousel?.action === 'view_details_product' &&
    inbound.productCarousel.productId
  ) {
    await handleViewProductDetails(from, fullCatalog, inbound.productCarousel.productId);
    return;
  }

  if (
    kind === 'button_reply' &&
    inbound.productCarousel?.action === 'select_product' &&
    inbound.productCarousel.productId
  ) {
    db.patchUserSession(from, {
      selected_product_id: inbound.productCarousel.productId,
    });
    await continuePurchaseSelectionAfterSelect(from, fullCatalog);
    return;
  }

  if (kind === 'button_reply') {
    const buySess = db.getUserSession(from);
    if (buySess?.shop_flow_step === SHOP_FLOW_AWAIT_BUY_CONFIRM) {
      if (inbound.buttonAction === WA_BUTTON_ACTION.CONFIRM_PURCHASE) {
        await startBuyNowLeadCaptureAfterConfirm(from);
        return;
      }
      if (inbound.buttonAction === WA_BUTTON_ACTION.CHANGE_PURCHASE_SIZE) {
        const pid = buySess.selectedProductId;
        const product = pid ? findProductById(fullCatalog, pid) : null;
        if (product) {
          await promptSizeForSelectedProduct(from, product);
        } else {
          const msg = BUY_NOW_NEED_SELECT_FIRST.slice(0, WA_TEXT_MAX);
          await sendWhatsAppText(from, msg);
          db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
          db.insertChatMessage(from, 'model', msg, Date.now());
        }
        return;
      }
      if (inbound.buttonAction === WA_BUTTON_ACTION.CHANGE_PURCHASE_PRODUCT) {
        db.patchUserSession(from, {
          selected_product_id: null,
          shop_flow_step: null,
        });
        const msg = BUY_CHANGE_PRODUCT_BODY.slice(0, WA_TEXT_MAX);
        await sendWhatsAppText(from, msg);
        db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
        db.insertChatMessage(from, 'model', msg, Date.now());
        return;
      }
    }
  }

  if (kind === 'button_reply' && inbound.buttonTitle) {
    const title = inbound.buttonTitle;
    const sb = db.getUserSession(from);
    if (sb?.shop_flow_step === SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE) {
      const pid = sb.selectedProductId;
      const product = pid ? findProductById(fullCatalog, pid) : null;
      let szPick = null;
      if (inbound.buyVariantPick?.kind === 'size' && inbound.buyVariantPick.value) {
        szPick = inbound.buyVariantPick.value;
      } else {
        szPick = structuredSizeFromButtonTitle(title);
      }
      if (!szPick && product && productRequiresSizePick(product)) {
        const t = String(title || '').trim();
        const hit = product.sizes.find(
          (s) =>
            String(s).trim() === t || String(s).trim().slice(0, WA_BUTTON_TITLE_MAX) === t,
        );
        if (hit) {
          szPick = String(hit).trim();
        }
      }
      if (szPick && product && sizeAllowedForProduct(product, szPick)) {
        db.patchUserSession(from, { size: String(szPick).trim(), shop_flow_step: null });
        await sendBuyConfirmSummaryAndButtons(from, fullCatalog);
        return;
      }
      if (product && productRequiresSizePick(product)) {
        const bad = `Pick a size from the buttons for this product (${product.sizes.join(', ')}).`.slice(
          0,
          WA_TEXT_MAX,
        );
        await sendWhatsAppText(from, bad);
        db.logMessage({ waId: from, direction: 'out', body: bad, metaMessageId: null });
        db.insertChatMessage(from, 'model', bad, Date.now());
        return;
      }
    }
    if (sb?.shop_flow_step === SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR) {
      const pid = sb.selectedProductId;
      const product = pid ? findProductById(fullCatalog, pid) : null;
      let colPick = null;
      if (inbound.buyVariantPick?.kind === 'color' && inbound.buyVariantPick.value) {
        colPick = inbound.buyVariantPick.value;
      } else if (product) {
        colPick = matchProductColorFromButtonTitle(title, product.colors);
      }
      if (colPick && product && colorAllowedForProduct(product, colPick)) {
        db.patchUserSession(from, { color: String(colPick).trim(), shop_flow_step: null });
        await sendBuyConfirmSummaryAndButtons(from, fullCatalog);
        return;
      }
      if (product && productRequiresColorPick(product)) {
        const bad = `Pick a color from the buttons for this product (${product.colors.join(', ')}).`.slice(
          0,
          WA_TEXT_MAX,
        );
        await sendWhatsAppText(from, bad);
        db.logMessage({ waId: from, direction: 'out', body: bad, metaMessageId: null });
        db.insertChatMessage(from, 'model', bad, Date.now());
        return;
      }
    }
    if (sb?.shop_flow_step === SHOP_FLOW_AWAIT_OCCASION) {
      const occBtn = structuredOccasionFromButtonTitle(title);
      if (occBtn) {
        await handleStructuredOccasionChoice(from, occBtn, fullCatalog);
        return;
      }
    }
    if (sb?.shop_flow_step === SHOP_FLOW_AWAIT_STYLE) {
      const stBtn = structuredStyleFromButtonTitle(title);
      if (stBtn) {
        await handleStructuredStyleChoice(from, stBtn, fullCatalog);
        return;
      }
    }
    if (sb?.shop_flow_step === 'await_category') {
      if (
        inbound.buttonAction === WA_BUTTON_ACTION.HELP_CHOOSE ||
        title === HELP_ME_CHOOSE_BUTTON_TITLE
      ) {
        if (!GEMINI_API_KEY) {
          const msg =
            'Our stylist assistant is not configured yet. Pick a category button above or tap Shop Collection.'
              .slice(0, WA_TEXT_MAX);
          await sendWhatsAppText(from, msg);
          db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
          db.insertChatMessage(from, 'model', msg, Date.now());
          return;
        }
        await startHelpMeChooseFlow(from);
        return;
      }
      const catRow = categoryRowFromButtonTitle(title);
      if (catRow) {
        await startStructuredCategorySelection(from, catRow.id, catRow.title);
        return;
      }
    }
    if (sb?.shop_flow_step === 'await_size') {
      const szBtn = structuredSizeFromButtonTitle(title);
      if (szBtn) {
        await handleStructuredSizeChoice(from, szBtn, fullCatalog);
        return;
      }
    }
    if (sb?.shop_flow_step === 'await_color') {
      const col = matchPendingColorByButtonTitle(title, sb.pending_color_options);
      if (col) {
        await handleStructuredColorChoice(from, col, fullCatalog);
        return;
      }
    }
  }

  if (kind === 'button_reply' && isProductSizeButtonTitle(inbound.buttonTitle)) {
    const flowStep = db.getUserSession(from)?.shop_flow_step;
    if (flowStep === SHOP_FLOW_AWAIT_BUY_CONFIRM) {
      const msg =
        'Tap Change Size to adjust size, Show Similar for more options, or Confirm to continue.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (flowStep === SHOP_FLOW_AWAIT_BUY_CONFIRM_SIZE) {
      const msg =
        'Use the size buttons we sent for this product (they match this item only).'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (flowStep === SHOP_FLOW_AWAIT_BUY_CONFIRM_COLOR) {
      const msg =
        'Use the color buttons we sent for this product, or type the color name.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    if (
      flowStep === 'await_category' ||
      flowStep === 'await_color' ||
      flowStep === SHOP_FLOW_AWAIT_OCCASION ||
      flowStep === SHOP_FLOW_AWAIT_STYLE ||
      flowStep === SHOP_FLOW_HELP_CHOOSE_AWAIT_1 ||
      flowStep === SHOP_FLOW_HELP_CHOOSE_AWAIT_2
    ) {
      const msg =
        'Finish the current step with the buttons above, or tap Shop Collection to restart.'.slice(
          0,
          WA_TEXT_MAX,
        );
      await sendWhatsAppText(from, msg);
      db.logMessage({ waId: from, direction: 'out', body: msg, metaMessageId: null });
      db.insertChatMessage(from, 'model', msg, Date.now());
      return;
    }
    const sz = normalizedProductSizeLabel(inbound.buttonTitle);
    db.patchUserSession(from, { size: sz });
    const ack = `Size ${sz} saved. What next?`.slice(0, WA_BODY_MAX);
    await sendWhatsAppInteractiveButtons(from, ack, PRODUCT_CAROUSEL_BUTTONS);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: `[buttons] ${ack} | ${PRODUCT_CAROUSEL_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', `Size ${sz} saved.`, Date.now());
    return;
  }

  const categoryListRowId =
    kind === 'list_reply' && inbound.listRowId && LIST_ROW_IDS.has(inbound.listRowId)
      ? inbound.listRowId
      : null;

  if (kind === 'list_reply' && inbound.listRowId && structuredSizeFromRowId(inbound.listRowId)) {
    await handleStructuredSizeListReply(from, inbound.listRowId, fullCatalog);
    return;
  }
  if (
    kind === 'list_reply' &&
    inbound.listRowId &&
    structuredColorIndexFromRowId(inbound.listRowId) !== null
  ) {
    await handleStructuredColorListReply(from, inbound.listRowId, fullCatalog);
    return;
  }

  if (kind === 'list_reply' && categoryListRowId) {
    const label = inbound.listTitle || inbound.listRowId;
    await startStructuredCategorySelection(from, categoryListRowId, label);
    return;
  }

  if (kind === 'button_reply' && inbound.buttonTitle === GREETING_BUTTON_NEW_ARRIVALS) {
    db.patchUserSession(from, {
      category_row_id: null,
      category_label: 'New Arrivals',
      size: null,
      color: null,
      fit: null,
      occasion: null,
      style: null,
      price_min_inr: null,
      price_max_inr: null,
      shop_flow_step: null,
      pending_color_options: null,
    });
    await deliverBackendCatalogExperience(from, fullCatalog, {
      userText: 'New Arrivals',
      categoryListRowId: null,
      headline: 'New arrivals — a few highlights:',
    });
    return;
  }

  if (kind === 'button_reply' && inbound.buttonTitle === GREETING_BUTTON_UNDER_5K) {
    db.patchUserSession(from, {
      category_row_id: null,
      category_label: 'Under ₹5000',
      size: null,
      color: null,
      fit: null,
      occasion: null,
      style: null,
      price_min_inr: null,
      price_max_inr: null,
      shop_flow_step: null,
      pending_color_options: null,
    });
    await deliverBackendCatalogExperience(from, fullCatalog, {
      userText: 'Under ₹5000',
      categoryListRowId: null,
      headline: 'Under ₹5,000 — matches:',
    });
    return;
  }

  if (kind === 'text' && inbound.text) {
    const cmd = matchStructuredTextCommand(inbound.text);
    if (cmd?.kind === 'under_5k') {
      db.patchUserSession(from, {
        category_row_id: null,
        category_label: 'Under ₹5000',
        size: null,
        color: null,
        fit: null,
        occasion: null,
        style: null,
        price_min_inr: null,
        price_max_inr: null,
        shop_flow_step: null,
        pending_color_options: null,
      });
      await deliverBackendCatalogExperience(from, fullCatalog, {
        userText: 'Under ₹5000',
        categoryListRowId: null,
        headline: 'Under ₹5,000 — matches:',
      });
      return;
    }
    if (cmd?.kind === 'new_arrivals') {
      db.patchUserSession(from, {
        category_row_id: null,
        category_label: 'New Arrivals',
        size: null,
        color: null,
        fit: null,
        occasion: null,
        style: null,
        price_min_inr: null,
        price_max_inr: null,
        shop_flow_step: null,
        pending_color_options: null,
      });
      await deliverBackendCatalogExperience(from, fullCatalog, {
        userText: 'New Arrivals',
        categoryListRowId: null,
        headline: 'New arrivals — a few highlights:',
      });
      return;
    }
    if (cmd?.kind === 'category' && cmd.rowId) {
      const row = COLLECTION_CATEGORY_ROWS.find((r) => r.id === cmd.rowId);
      const label = row?.title || cmd.rowId;
      await startStructuredCategorySelection(from, cmd.rowId, label);
      return;
    }
  }

  if (kind === 'button_reply') {
    const fb =
      'Tap Shop Collection to browse categories, or send a short note for our stylist.';
    await sendWhatsAppInteractiveButtons(from, fb.slice(0, WA_BODY_MAX), GREETING_MENU_BUTTONS);
    db.logMessage({
      waId: from,
      direction: 'out',
      body: `[buttons] ${fb} | ${GREETING_MENU_BUTTONS.join(' | ')}`,
      metaMessageId: null,
    });
    db.insertChatMessage(from, 'model', fb, Date.now());
    await sendQuickReentryButtonRow(from);
    return;
  }

  const geminiEligible =
    kind === 'text' || kind === 'audio' || (kind === 'list_reply' && !categoryListRowId);
  if (!geminiEligible) {
    return;
  }

  const ragCatalog = buildRagCatalog(fullCatalog, userTextForRag, categoryListRowId, from);
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
    await sendQuickReentryButtonRow(from);
    return;
  }

  await deliverHybridGeminiReply(from, geminiRaw, fullCatalog, userTextForRag, categoryListRowId);
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
