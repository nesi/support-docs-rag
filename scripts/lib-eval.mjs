// Shared helpers for the eval scripts (eval-search.mjs, eval-ask.mjs). Both read
// the same evals/questions.jsonl and hit a running Worker with a small
// concurrency cap, so keep this logic in one place rather than forked twice.

import { readFileSync } from "node:fs";

export function loadCases(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`${file}: bad JSON on line ${i + 1}: ${e.message}`);
      }
    });
}

/**
 * fetch() that waits out the Worker's per-IP rate limiter (RATE_LIMITER in
 * wrangler.jsonc: 20 req/60s across /api/search, /api/chat and /mcp) instead
 * of failing. Without this a full run reads most cases as request errors,
 * which score() then silently excludes. Backoff grows to just past the
 * limiter's 60s window, so a burst always clears eventually.
 */
export async function fetchWithRateLimit(url, init, { maxWaits = 8 } = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || i >= maxWaits) return res;
    const wait = Math.min(5000 * 2 ** i, 65000) + Math.random() * 1000;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Run with a small concurrency cap — Workers AI rate-limits bursts. */
export async function mapLimit(items, limit, fn) {
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
 * Strip the #heading anchor the chunker appends, and lowercase, so URLs
 * compare page-to-page regardless of case. Necessary because chunk citations
 * now carry the site's real canonical URL (see ingest.mjs's redirect-follow),
 * which can differ in case from a local filename's pathToUrl() output —
 * e.g. local Automatic_cleaning_of_nobackup.md vs the site's
 * Automatic_Cleaning_of_Nobackup. Same page either way; a case-sensitive
 * compare here would misreport a correct top-1 hit as a total miss.
 */
export const pageOf = (url) => String(url || "").split("#")[0].toLowerCase();

export function resolveUrl(url) {
  if (!url) {
    console.error("No Worker URL. Pass --url <base>, --local, or set RAG_URL.");
    process.exit(2);
  }
  return url.replace(/\/$/, "");
}
