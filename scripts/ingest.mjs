/**
 * Ingest the support-docs repo into Cloudflare Vectorize.
 *
 * RAG concept #2 — indexing:
 * We embed every chunk once, at ingest time, and store the vectors in
 * Vectorize with the chunk text as metadata. At query time we embed only
 * the user's question and ask Vectorize for the nearest vectors (cosine
 * similarity). Cheap, fast, and the index only changes when the docs do.
 *
 * The body of each page is sourced from the *rendered* docs.nesi.org.nz page,
 * not the raw .md — several pages build real content (module version tables,
 * a support-contact link) from mkdocs-macros Jinja includes that only
 * resolve at site-build time, and the raw markdown source never has that
 * content. Frontmatter (description, tags) still comes from the raw .md.
 * If a page's rendered fetch fails or its extracted body is implausibly
 * short, that one page falls back to the raw-markdown path (chunkFile) —
 * logged, never silent.
 *
 * Usage:
 *   export CLOUDFLARE_ACCOUNT_ID=...   # dash.cloudflare.com -> Workers -> right sidebar
 *   export CLOUDFLARE_API_TOKEN=...    # token with Workers AI Read + Edit, Vectorize Edit
 *   node scripts/ingest.mjs /path/to/support-docs/docs [--index nesi-docs] [--dry-run]
 *
 * Re-running is safe: vector ids are stable (see chunkId()), so upserts
 * overwrite. For a clean rebuild after big doc reorganisations:
 *   npx wrangler vectorize delete nesi-docs
 *   npx wrangler vectorize create nesi-docs --dimensions=1024 --metric=cosine
 */

import { relative } from "node:path";
import { chunkBody, chunkFile, DEFAULT_SITE_URL, pathToUrl, readFrontmatter, walkMarkdown } from "./chunker.mjs";
import { extractBody } from "./renderedPage.mjs";

const SITE_URL = DEFAULT_SITE_URL;
const FETCH_CONCURRENCY = 6; // polite to the live site — this isn't Cloudflare's API
const FETCH_TIMEOUT_MS = 15000;
const MIN_RENDERED_BODY_CHARS = 80; // matches chunkBody's own stub-page threshold

/** Run with a small concurrency cap — 306 sequential fetches would be slow, 306 at once rude. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * When a raw filename's casing doesn't match the site's canonical slug (e.g.
 * "Globus-renaming.md" -> "/Globus-Renaming/"), the old URL still resolves —
 * as a client-side redirect stub (real 200, near-empty HTML, no content
 * container). Real pages always self-reference their own canonical URL, so
 * following it whenever it points elsewhere is a generic fix, not a guess at
 * a redirect-page template.
 */
function extractCanonical(html, baseUrl) {
  const m = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (!m) return null;
  try {
    return new URL(m[1], baseUrl).href;
  } catch {
    return null;
  }
}

/** null return = confirmed 404 (page doesn't exist there — no point retrying). Throws on anything else after one retry. */
async function fetchRenderedPage(url, depth = 0) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "nesi-docs-rag-ingest/1.0 (internal tooling)" },
      });
      if (res.ok) {
        const html = await res.text();
        if (depth < 2) {
          const canonical = extractCanonical(html, url);
          if (canonical && canonical !== url) return fetchRenderedPage(canonical, depth + 1);
        }
        return html;
      }
      if (res.status === 404) return null;
      if (attempt >= 1) throw new Error(`${url} -> ${res.status}`);
    } catch (e) {
      if (attempt >= 1) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Rendered HTML when it's usable, else the local raw-markdown path — always tagged with which one and why. */
async function gatherChunksForFile(absPath, docsRoot) {
  const relPath = relative(docsRoot, absPath);
  const meta = readFrontmatter(absPath);
  const url = pathToUrl(relPath, SITE_URL);
  let reason;
  try {
    const html = await fetchRenderedPage(url);
    if (html === null) {
      reason = "404 on rendered site";
    } else {
      const body = extractBody(html);
      if (body.length >= MIN_RENDERED_BODY_CHARS) return { path: relPath, source: "html", chunks: chunkBody(relPath, meta, body, SITE_URL) };
      reason = "rendered content too short (theme change, or content container not found)";
    }
  } catch (e) {
    reason = e.message;
  }
  return { path: relPath, source: "fallback", reason, chunks: chunkFile(absPath, docsRoot, SITE_URL) };
}

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

const CONTEXT_LIMIT_CODE = 3030; // Workers AI: "Max context reached"

class CfApiError extends Error {
  constructor(path, status, errors) {
    super(`${path} -> ${status}: ${JSON.stringify(errors).slice(0, 500)}`);
    this.status = status;
    this.errors = errors;
  }
}

async function cfFetch(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new CfApiError(path, res.status, body.errors || [body]);
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

const files = [...walkMarkdown(docsRoot)];
console.log(`Found ${files.length} markdown files. Fetching rendered pages from ${SITE_URL} ...`);
let fetchedCount = 0;
const results = await mapLimit(files, FETCH_CONCURRENCY, async (absPath) => {
  const r = await gatherChunksForFile(absPath, docsRoot);
  fetchedCount++;
  process.stdout.write(`\rFetched ${fetchedCount}/${files.length}`);
  return r;
});
process.stdout.write("\n");

const chunks = results.flatMap((r) => r.chunks);
console.log(`Chunked ${new Set(chunks.map((c) => c.metadata.path)).size} files into ${chunks.length} chunks.`);

const fallbacks = results.filter((r) => r.source === "fallback");
if (fallbacks.length) {
  console.log(`${fallbacks.length}/${files.length} page(s) used the local-markdown fallback (rendered page unavailable or too thin):`);
  const byReason = new Map();
  for (const f of fallbacks) byReason.set(f.reason, [...(byReason.get(f.reason) || []), f.path]);
  for (const [reason, paths] of byReason) {
    console.log(`  ${paths.length}x ${reason}: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, ... (${paths.length - 3} more)` : ""}`);
  }
}

if (DRY) { console.log("Dry run — not embedding/upserting."); process.exit(0); }

const batches = makeBatches(chunks);
let done = 0;
for (const batch of batches) {
  const embeddings = await embedBatchSafe(batch);
  await upsert(batch.map((c, j) => ({ id: c.id, values: embeddings[j], metadata: c.metadata })));
  done += batch.length;
  process.stdout.write(`\rEmbedded + upserted ${done}/${chunks.length}`);
}
console.log("\nDone. Vectorize applies mutations asynchronously — the index is queryable within a minute or so.");
