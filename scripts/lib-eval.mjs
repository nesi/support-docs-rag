// Shared helpers for the eval scripts (eval-search.mjs, eval-ask.mjs). Both read
// the same evals/questions.jsonl and hit a running Worker with a small
// concurrency cap, so keep this logic in one place rather than forked twice.

import { readFileSync } from "node:fs";

export function loadCases(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l, i) => ({ l: l.trim(), line: i + 1 }))
    .filter(({ l }) => l && !l.startsWith("//"))
    .map(({ l, line }) => {
      let c;
      try {
        c = JSON.parse(l);
      } catch (e) {
        throw new Error(`${file}: bad JSON on line ${line}: ${e.message}`);
      }
      const problem = validateCase(c);
      if (problem) throw new Error(`${file}: line ${line} (${c.id ?? "no id"}): ${problem}`);
      return c;
    });
}

/**
 * Shape check, so a malformed case fails the run loudly instead of erroring
 * per-request and being silently excluded from every metric (which is what
 * a `"paths": "<url>"` string did). Returns a problem string, or null.
 */
export function validateCase(c) {
  if (!c || typeof c !== "object") return "not an object";
  if (typeof c.id !== "string" || !c.id) return "missing id";
  if (typeof c.question !== "string" || !c.question.trim()) return "missing question";
  if (c.expect !== "answer" && c.expect !== "refuse") return `expect must be "answer" or "refuse", got ${JSON.stringify(c.expect)}`;
  if (c.paths !== undefined) {
    if (!Array.isArray(c.paths)) return `paths must be an array of docs-relative .md paths, got ${JSON.stringify(c.paths)}`;
    const bad = c.paths.find((p) => typeof p !== "string" || !p.endsWith(".md") || /^https?:/.test(p));
    if (bad !== undefined) return `paths entries must be docs-relative .md paths (e.g. "Storage/Data_Recovery.md"), got ${JSON.stringify(bad)}`;
  }
  if (c.must_include !== undefined && !(Array.isArray(c.must_include) && c.must_include.every((s) => typeof s === "string")))
    return "must_include must be an array of strings";
  return null;
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
