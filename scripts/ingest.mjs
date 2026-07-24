/**
 * Ingest the support-docs repo into Cloudflare Vectorize.
 *
 * RAG concept #2 — indexing:
 * We embed every chunk once, at ingest time, and store the vectors in
 * Vectorize with the chunk text as metadata. At query time we embed only
 * the user's question and ask Vectorize for the nearest vectors (cosine
 * similarity). Cheap, fast, and the index only changes when the docs do.
 *
 * Usage:
 *   export CLOUDFLARE_ACCOUNT_ID=...   # dash.cloudflare.com -> Workers -> right sidebar
 *   export CLOUDFLARE_API_TOKEN=...    # token with Workers AI:Read + Vectorize:Edit
 *   node scripts/ingest.mjs /path/to/support-docs/docs [--index nesi-docs] [--dry-run]
 *
 * Re-running is safe: vector ids are stable (see chunkId()), so upserts
 * overwrite. For a clean rebuild after big doc reorganisations:
 *   npx wrangler vectorize delete nesi-docs
 *   npx wrangler vectorize create nesi-docs --dimensions=1024 --metric=cosine
 */

import { chunkRepo } from "./chunker.mjs";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const EMBED_MODEL = "@cf/baai/bge-m3";

const args = process.argv.slice(2);
const docsRoot = args.find((a) => !a.startsWith("--"));
const INDEX = args.includes("--index") ? args[args.indexOf("--index") + 1] : "nesi-docs";
const DRY = args.includes("--dry-run");

if (!docsRoot) { console.error("Usage: node scripts/ingest.mjs <docs dir> [--index name] [--dry-run]"); process.exit(1); }
if (!DRY && (!ACCOUNT || !TOKEN)) { console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or use --dry-run)"); process.exit(1); }

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

async function cfFetch(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body.errors || body).slice(0, 500)}`);
  }
  return body.result ?? body;
}

async function embedBatch(texts) {
  // bge-m3 returns dense embeddings under result.data (array per input text)
  const result = await cfFetch(`/ai/run/${EMBED_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: texts }),
  });
  const vectors = result.data ?? result.embeddings;
  if (!vectors || vectors.length !== texts.length) throw new Error("Unexpected embedding response shape: " + JSON.stringify(result).slice(0, 300));
  return vectors;
}

async function upsert(vectors) {
  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
  return cfFetch(`/vectorize/v2/indexes/${INDEX}/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson,
  });
}

const MAX_BATCH = 50; // keep request bodies well under limits
const TEXT_CHAR_CAP = 6000;
// bge-m3's 60000-token cap is a *sum across the whole batch*, not per text.
// A fixed count of 50 broke once chunk sizes pushed the sum past that (one
// batch hit 76650). Chars/token varies with content, so this is a
// deliberately conservative estimate (overestimates tokens) rather than a
// measured ratio — the goal is never tripping the real limit, not precision.
const CHARS_PER_TOKEN_ESTIMATE = 3;
const MAX_BATCH_TOKENS = 45000; // safety margin under the model's 60000 cap

function makeBatches(chunks) {
  const batches = [];
  let batch = [];
  let tokenSum = 0;
  for (const c of chunks) {
    const text = c.embedText.slice(0, TEXT_CHAR_CAP);
    const estTokens = Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
    if (batch.length && (batch.length >= MAX_BATCH || tokenSum + estTokens > MAX_BATCH_TOKENS)) {
      batches.push(batch);
      batch = [];
      tokenSum = 0;
    }
    batch.push({ ...c, embedText: text });
    tokenSum += estTokens;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const chunks = chunkRepo(docsRoot);
console.log(`Chunked ${new Set(chunks.map((c) => c.metadata.path)).size} files into ${chunks.length} chunks.`);
if (DRY) { console.log("Dry run — not embedding/upserting."); process.exit(0); }

const batches = makeBatches(chunks);
let done = 0;
for (const batch of batches) {
  const embeddings = await embedBatch(batch.map((c) => c.embedText));
  await upsert(batch.map((c, j) => ({ id: c.id, values: embeddings[j], metadata: c.metadata })));
  done += batch.length;
  process.stdout.write(`\rEmbedded + upserted ${done}/${chunks.length}`);
}
console.log("\nDone. Vectorize applies mutations asynchronously — the index is queryable within a minute or so.");
