/**
 * Sample API test: resolve catalog_id, map product_retailer_id, POST single-product interactive message.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services/share-products/
 *
 * Env:
 *   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID (required)
 *   TEST_WHATSAPP_TO — recipient E.164 without + or with + (required)
 *   WA_CATALOG_ID — OR WA_BUSINESS_ACCOUNT_ID for GET .../product_catalogs
 *   TEST_PRODUCT_RETAILER_ID — optional; defaults to first product in aura-sales-closer/catalog.json (or root catalog.json)
 *
 * Run from repo root:
 *   node scripts/test-whatsapp-product-message.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', 'aura-sales-closer', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GRAPH = process.env.GRAPH_API_VERSION || 'v21.0';
const TOKEN = process.env.WA_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const TO_RAW = process.env.TEST_WHATSAPP_TO;
const WA_CATALOG_ID = String(process.env.WA_CATALOG_ID || '').trim();
const WABA = String(process.env.WA_BUSINESS_ACCOUNT_ID || '').trim();
let TEST_RETAILER = String(process.env.TEST_PRODUCT_RETAILER_ID || '').trim();

function normalizeTo(to) {
  if (!to) {
    return '';
  }
  const s = String(to).trim();
  return s.startsWith('+') ? s.slice(1).replace(/\D/g, '') : s.replace(/\D/g, '');
}

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

async function fetchCatalogId() {
  if (WA_CATALOG_ID) {
    return WA_CATALOG_ID;
  }
  if (!WABA) {
    throw new Error('Set WA_CATALOG_ID or WA_BUSINESS_ACCOUNT_ID');
  }
  const url = `https://graph.facebook.com/${GRAPH}/${WABA}/product_catalogs`;
  const { data } = await axios.get(url, {
    params: { fields: 'id,name', access_token: TOKEN },
    headers: { Authorization: `Bearer ${TOKEN}` },
    validateStatus: () => true,
  });
  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  const id = data?.data?.[0]?.id;
  if (id == null) {
    throw new Error('No catalogs returned; link a catalog to this WABA in Commerce Manager.');
  }
  return String(id);
}

async function main() {
  const TO = normalizeTo(TO_RAW);
  if (!TOKEN || !PHONE_NUMBER_ID || !TO) {
    console.error('Missing WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, or TEST_WHATSAPP_TO');
    process.exit(1);
  }

  if (!TEST_RETAILER) {
    const closer = path.join(__dirname, '..', 'aura-sales-closer', 'catalog.json');
    const rootCat = path.join(__dirname, '..', 'catalog.json');
    const p = fs.existsSync(closer) ? closer : rootCat;
    const catalog = JSON.parse(fs.readFileSync(p, 'utf8'));
    TEST_RETAILER = mapCatalogProductToRetailerId(catalog.products?.[0]) || '';
  }
  if (!TEST_RETAILER) {
    throw new Error('Set TEST_PRODUCT_RETAILER_ID or add product id / wa_product_retailer_id in catalog.json');
  }

  const catalogId = await fetchCatalogId();
  console.log('catalog_id:', catalogId);
  console.log('product_retailer_id:', TEST_RETAILER);

  const url = `https://graph.facebook.com/${GRAPH}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: TO,
    type: 'interactive',
    interactive: {
      type: 'product',
      body: { text: 'API test — single product message' },
      footer: { text: 'Aura sample' },
      action: {
        catalog_id: catalogId,
        product_retailer_id: TEST_RETAILER,
      },
    },
  };

  const { data, status } = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });
  console.log('HTTP', status);
  console.log(JSON.stringify(data, null, 2));
  if (data?.error) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
