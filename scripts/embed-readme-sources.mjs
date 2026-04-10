import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');

const intro = `### \`server.js\` / \`db.js\` — embedded full source

> **Authoritative copies** are always \`server.js\` and \`db.js\` in the repository root. The blocks below are for convenience (offline docs, AI context) and **can drift** after edits—compare to the real files if unsure.

| Area | Main functions / symbols |
|------|---------------------------|
| Config & boot | \`dotenv\`, env constants, \`createDb(DATABASE_PATH)\`, production checks for \`META_APP_SECRET\` |
| Webhook security | \`verifyWebhookSignature\` — \`X-Hub-Signature-256\` vs HMAC-SHA256 of **raw** JSON body |
| Inbound parsing | \`extractInboundFromMessage\` — \`text\`, \`audio\`, \`interactive\` (button replies) |
| Catalog & RAG | \`loadCatalog\`, \`selectRelevantProducts\`, \`buildRagCatalog\` — top **3** products into the prompt |
| Gemini | \`buildGeminiContents\`, \`generateStructuredReply\` — history + \`systemInstruction\` + JSON schema |
| 24h rule | \`getLastUserInboundTimestamp\`, \`sendTemplateReengagement\` |
| Media | \`sendWhatsAppImageWithCache\`, \`uploadImageBufferToWhatsApp\`, \`graphSendMessage\` |
| Outbound UX | \`deliverStructuredAuraReply\`, \`sendWhatsAppText\`, \`sendWhatsAppInteractiveButtons\` |
| HTTP | Express \`GET /\`, \`GET /health\`, \`GET /webhook\`, \`POST /webhook\` |

Supporting module: **\`db.js\`** — SQLite connection, schema, and prepared statements (see [Database schema](#database-schema)).

#### Full source: \`db.js\`

\`\`\`javascript
${db}\`\`\`

#### Full source: \`server.js\`

\`\`\`javascript
${server}\`\`\`

`;

const start = readme.indexOf('### `server.js` — full source and responsibilities');
const end = readme.indexOf('### Webhook handler flow');
if (start < 0 || end < 0) {
  console.error('README markers not found', { start, end });
  process.exit(1);
}
fs.writeFileSync(readmePath, readme.slice(0, start) + intro + readme.slice(end));
