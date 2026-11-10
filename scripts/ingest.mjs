/**
 * Ingest the support-docs repo into Cloudflare Vectorize.
 *
 * RAG concept #2 — indexing:
 * We embed every chunk once, at ingest time, and store the vectors in
 * Vectorize with the chunk text as metadata. At query time we embed only
 * the user's question and ask Vectorize for the nearest vectors (cosine
 * similarity). Cheap, fast, and the index only changes when the docs do.
 *
 * Body content is read straight from the local .md source — no dependency
 * on a deployed docs.nesi.org.nz to be up to date, so ingest reflects
 * whatever's on disk, including edits not yet pushed. Software/Available_Applications
 * pages' `applications[...]` macros are left for the generic Jinja strip to
 * drop — that data (module-list.json + glossary jargon) isn't ingested at
 * all; it's looked up live instead at query time (see src/liveData.mjs).
 *
 * Usage:
 *   export CLOUDFLARE_ACCOUNT_ID=...   # dash.cloudflare.com -> Workers -> right sidebar
 *   export CLOUDFLARE_API_TOKEN=...    # token with Workers AI Read + Edit, Vectorize Edit
 *   node scripts/ingest.mjs /path/to/support-docs/docs [--index nesi-docs] [--dry-run] [--full] [--allow-mass-delete]
 *
 * Incremental by default: only new or changed chunks are embedded, and
 * vectors no chunk produces anymore are deleted (see ingestPlan.mjs).
 * --full re-embeds everything. --allow-mass-delete lifts the guard against
 * deleting most of the index in one run.
 *
 * Vector ids are stable (see chunkId()), so upserts overwrite in place.
 * For a clean rebuild:
 *   npx wrangler vectorize delete nesi-docs
 *   npx wrangler vectorize create nesi-docs --dimensions=1024 --metric=cosine
 */

import { chunkRepo, DEFAULT_SITE_URL } from "./chunker.mjs";
import { chunkHash, planIngest } from "./ingestPlan.mjs";

const SITE_URL = DEFAULT_SITE_URL;

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const EMBED_MODEL = "@cf/baai/bge-m3";

const args = process.argv.slice(2);
const docsRoot = args.find((a) => !a.startsWith("--"));
const INDEX = args.includes("--index") ? args[args.indexOf("--index") + 1] : "nesi-docs";
const DRY = args.includes("--dry-run");
const FULL = args.includes("--full");
const ALLOW_MASS_DELETE = args.includes("--allow-mass-delete");

if (!docsRoot) { console.error("Usage: node scripts/ingest.mjs <docs dir> [--index name] [--dry-run]"); process.exit(1); }
if (!DRY && (!ACCOUNT || !TOKEN)) { console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or use --dry-run)"); process.exit(1); }

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

const CONTEXT_LIMIT_CODE = 3030; // Workers AI: "Max context reached"

class CfApiError extends Error {
  constructor(path, status, errors) {
    super(`${path} -> ${status}: ${JSON.stringify(errors).slice(0, 500)}`);
    this.status = status;
    this.errors = errors;
  }
}

// Retry transient failures: network errors, 429, 5xx (one scheduled run hit
// a one-off 504 on /list). Every call here is idempotent — upsert overwrites,
// delete of a missing id is a no-op — so retrying is safe.
const RETRIES = 3;
const RETRY_BASE_MS = 2000;

async function cfFetch(path, init) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${TOKEN}`, ...init?.headers },
      });
    } catch (e) {
      if (attempt >= RETRIES) throw e;
      await retryWait(path, attempt, e.message);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.success !== false) return body.result ?? body;
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= RETRIES) {
      throw new CfApiError(path, res.status, body.errors || [body]);
    }
    await retryWait(path, attempt, `HTTP ${res.status}`);
  }
}

function retryWait(path, attempt, reason) {
  const ms = RETRY_BASE_MS * 2 ** attempt; // 2s, 4s, 8s
  console.warn(`\n${path}: ${reason}, retry ${attempt + 1}/${RETRIES} in ${ms / 1000}s`);
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * Char-per-token ratio in makeBatches() is a rough prior, not a measured
 * constant — NeSI's docs mix prose with Slurm scripts, file paths, and CLI
 * flags, and code-like text tokenizes far less efficiently than English
 * prose (observed ~1.7 chars/token here, not the ~3 first assumed). Rather
 * than chase the "right" constant for a corpus that varies chunk to chunk,
 * this is the actual safety net: on the model's real context-limit error,
 * halve the batch and retry each half. Bottoms out at single chunks, each
 * well under the limit on their own (TEXT_CHAR_CAP caps every text at 6000
 * chars — at worst 1 char/token, 6000 tokens, far under the 60000 cap).
 */
async function embedBatchSafe(batch) {
  try {
    return await embedBatch(batch.map((c) => c.embedText));
  } catch (e) {
    const isContextLimit = e instanceof CfApiError && e.errors?.some((x) => x.code === CONTEXT_LIMIT_CODE);
    if (!isContextLimit || batch.length <= 1) throw e;
    const mid = Math.ceil(batch.length / 2);
    const left = await embedBatchSafe(batch.slice(0, mid));
    const right = await embedBatchSafe(batch.slice(mid));
    return [...left, ...right];
  }
}

async function upsert(vectors) {
  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
  return cfFetch(`/vectorize/v2/indexes/${INDEX}/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson,
  });
}

// All ids in the index, paged. Max page size is 1000.
async function listIds() {
  const ids = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ count: "1000", ...(cursor && { cursor }) });
    const page = await cfFetch(`/vectorize/v2/indexes/${INDEX}/list?${qs}`);
    ids.push(...page.vectors.map((v) => v.id));
    cursor = page.isTruncated ? page.nextCursor : undefined;
  } while (cursor);
  return ids;
}

const GET_BATCH = 20;

// id -> stored metadata.hash (undefined for vectors ingested before hashing).
async function existingHashes() {
  const ids = await listIds();
  const hashes = new Map();
  for (let i = 0; i < ids.length; i += GET_BATCH) {
    const vectors = await cfFetch(`/vectorize/v2/indexes/${INDEX}/get_by_ids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + GET_BATCH) }),
    });
    for (const v of vectors) hashes.set(v.id, v.metadata?.hash);
  }
  return hashes;
}

async function deleteIds(ids) {
  for (let i = 0; i < ids.length; i += 100) {
    await cfFetch(`/vectorize/v2/indexes/${INDEX}/delete_by_ids`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids.slice(i, i + 100) }),
    });
  }
}

const MAX_BATCH = 50; // keep request bodies well under limits
const TEXT_CHAR_CAP = 6000;
// bge-m3's 60000-token cap is a *sum across the whole batch*, not per text.
// This estimate just keeps batch count reasonable in the common case — the
// real guarantee is embedBatchSafe()'s reactive split above, since no fixed
// ratio holds across chunks this different (prose FAQs vs. Slurm scripts).
// Observed on this corpus: ~1.7 chars/token, well below the ~4 a plain-English
// guess would suggest, because dense technical text (paths, flags, code)
// tokenizes far less efficiently than prose.
const CHARS_PER_TOKEN_ESTIMATE = 1.7;
const MAX_BATCH_TOKENS = 30000; // safety margin under the model's 60000 cap

function makeBatches(chunks) {
  const batches = [];
  let batch = [];
  let tokenSum = 0;
  for (const c of chunks) {
    const estTokens = Math.ceil(c.embedText.length / CHARS_PER_TOKEN_ESTIMATE);
    if (batch.length && (batch.length >= MAX_BATCH || tokenSum + estTokens > MAX_BATCH_TOKENS)) {
      batches.push(batch);
      batch = [];
      tokenSum = 0;
    }
    batch.push(c);
    tokenSum += estTokens;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// Cap before hashing, so the hash covers exactly what gets embedded.
const chunks = chunkRepo(docsRoot, SITE_URL).map((c) => {
  const chunk = { ...c, embedText: c.embedText.slice(0, TEXT_CHAR_CAP) };
  chunk.metadata = { ...c.metadata, hash: chunkHash(chunk, EMBED_MODEL) };
  return chunk;
});
console.log(`Chunked ${new Set(chunks.map((c) => c.metadata.path)).size} files into ${chunks.length} chunks.`);

if (DRY) { console.log("Dry run — not embedding/upserting."); process.exit(0); }

const plan = planIngest(chunks, await existingHashes(), { full: FULL, allowMassDelete: ALLOW_MASS_DELETE });
console.log(`Plan: ${plan.upsert.length} to embed, ${plan.delete.length} to delete, ${plan.unchanged} unchanged.`);

// Upsert before delete, so a failed run never leaves content missing.
const batches = makeBatches(plan.upsert);
let done = 0;
for (const batch of batches) {
  const embeddings = await embedBatchSafe(batch);
  await upsert(batch.map((c, j) => ({ id: c.id, values: embeddings[j], metadata: c.metadata })));
  done += batch.length;
  process.stdout.write(`\rEmbedded + upserted ${done}/${plan.upsert.length}`);
}
if (plan.upsert.length) console.log();

if (plan.delete.length) {
  await deleteIds(plan.delete);
  console.log(`Deleted ${plan.delete.length} stale vectors.`);
}
console.log("Done. Vectorize applies mutations asynchronously — the index is queryable within a minute or so.");
