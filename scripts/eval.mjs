#!/usr/bin/env node
/**
 * Retrieval eval for the NeSI docs RAG.
 *
 * Hits /api/search — no LLM, so runs are cheap and repeatable. Everything the
 * refusal decision depends on is already in that response: the worker answers
 * only when `results[0].rerankScore >= MIN_RERANK_SCORE`, so this script can
 * replicate the decision exactly and sweep the threshold without deploying.
 *
 * Two things get measured:
 *   1. Retrieval — did an expected page reach the top k? (hit@k, MRR)
 *   2. Refusal   — would the worker's pre-LLM score gate pass this through,
 *                  or refuse before ever calling the model?
 *
 * A case only counts as properly served when both hold: the worker is confident
 * AND a relevant chunk is inside CONTEXT_K. That is the `grounded` number.
 *
 * IMPORTANT CAVEAT on "false answers": this is a pre-LLM upper bound, not
 * observed behaviour. The score gate exists to skip the LLM call entirely on
 * obviously-irrelevant retrievals (a cost optimisation) — cases that pass the
 * gate still reach the LLM, which has its own instructed judgment (system
 * prompt rule 3: "if the excerpts don't contain the answer, say so"). Verified
 * directly: every hard-negative case in this eval set that "false answers"
 * here (score gate passed) was manually checked against the real
 * ask_nesi_docs/api-chat pipeline and correctly refused with a helpful
 * redirect. Don't read this number as an observed hallucination rate — it
 * isn't one. It's useful only for tuning MIN_RERANK_SCORE itself (whether the
 * gate is doing its cost-saving job), not for judging end-user-facing safety.
 *
 * Usage:
 *   RAG_URL=https://nesi-docs-rag.<subdomain>.workers.dev node scripts/eval.mjs
 *   node scripts/eval.mjs --local              # against `npx wrangler dev`
 *   node scripts/eval.mjs --threshold 0.25     # score at a different cutoff
 *   node scripts/eval.mjs --verbose            # list every failing case
 *
 * Set API_KEY if the Worker has the shared-secret auth enabled.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToUrl } from "./chunker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mirror of the worker constants. Keep in sync with src/worker.js.
const MIN_RERANK_SCORE = 0.4;
const CONTEXT_K = 6;
const RETRIEVE_K = 20;

const HIT_AT = [1, 3, CONTEXT_K, RETRIEVE_K];
const SWEEP = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];
const CONCURRENCY = 4;

/* ----------------------------- arg parsing ----------------------------- */

function parseArgs(argv) {
  const opts = {
    url: process.env.RAG_URL || "",
    file: join(HERE, "..", "evals", "questions.jsonl"),
    threshold: MIN_RERANK_SCORE,
    verbose: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") opts.url = "http://127.0.0.1:8787";
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--threshold") opts.threshold = Number(argv[++i]);
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--json") opts.json = true;
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!opts.url) {
    console.error("No Worker URL. Pass --url <base>, --local, or set RAG_URL.");
    process.exit(2);
  }
  opts.url = opts.url.replace(/\/$/, "");
  return opts;
}

/* ------------------------------- the run ------------------------------- */

function loadCases(file) {
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

async function search(opts, query) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.API_KEY) headers.Authorization = `Bearer ${process.env.API_KEY}`;
  const body = JSON.stringify({ query, topK: RETRIEVE_K });

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${opts.url}/api/search`, { method: "POST", headers, body });
    if (res.ok) return (await res.json()).results ?? [];
    if (res.status < 500 || attempt === 1) {
      throw new Error(`/api/search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
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
const pageOf = (url) => String(url || "").split("#")[0].toLowerCase();

async function runCase(opts, c) {
  const results = await search(opts, c.question);
  const expected = new Set((c.paths || []).map((p) => pageOf(pathToUrl(p))));
  const rank = results.findIndex((r) => expected.has(pageOf(r.url)));

  return {
    id: c.id,
    expect: c.expect,
    note: c.note,
    topScore: results.length ? results[0].rerankScore : null,
    rank: rank === -1 ? null : rank + 1, // 1-based, null = not retrieved at all
    top3: results.slice(0, 3).map((r) => `${pageOf(r.url)} (${r.rerankScore?.toFixed(3)})`),
  };
}

/** Run with a small concurrency cap — Workers AI rate-limits bursts. */
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

/* ------------------------------- scoring ------------------------------- */

const pct = (n, d) => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

/**
 * Rows that errored carry no scores, and counting them would read a flaky
 * request as a retrieval failure. They are excluded and reported separately.
 */
export function score(allRows, threshold) {
  const rows = allRows.filter((r) => !r.error);
  const answerable = rows.filter((r) => r.expect === "answer");
  const negatives = rows.filter((r) => r.expect === "refuse");
  const confident = (r) => r.topScore !== null && r.topScore >= threshold;

  return {
    threshold,
    excluded: allRows.length - rows.length,
    answerable: answerable.length,
    negatives: negatives.length,
    hits: HIT_AT.map((k) => ({ k, n: answerable.filter((r) => r.rank && r.rank <= k).length })),
    mrr: answerable.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / (answerable.length || 1),
    // Would answer a question the docs don't cover.
    falseAnswer: negatives.filter(confident),
    // Would refuse a question the docs do cover.
    falseRefusal: answerable.filter((r) => !confident(r)),
    // Confident AND holding a relevant chunk in the LLM's context window.
    grounded: answerable.filter((r) => confident(r) && r.rank && r.rank <= CONTEXT_K),
    // Confident but no relevant chunk retrieved — the hallucination-shaped failure.
    ungrounded: answerable.filter((r) => confident(r) && !(r.rank && r.rank <= CONTEXT_K)),
  };
}

export function report(rows, opts) {
  const s = score(rows, opts.threshold);

  if (s.excluded) console.log(`\n${s.excluded} case(s) excluded from all figures below (request errors)`);
  console.log(`\nRetrieval  (${s.answerable} answerable cases)`);
  for (const { k, n } of s.hits) {
    console.log(`  hit@${String(k).padEnd(2)}  ${pct(n, s.answerable)}  (${n}/${s.answerable})`);
  }
  console.log(`  MRR     ${s.mrr.toFixed(3)}`);

  console.log(`\nRefusal  (threshold ${opts.threshold})`);
  console.log(`  grounded answers     ${pct(s.grounded.length, s.answerable)}  (${s.grounded.length}/${s.answerable})`);
  console.log(`  false refusals       ${pct(s.falseRefusal.length, s.answerable)}  (${s.falseRefusal.length}/${s.answerable})`);
  console.log(`  confident, no source ${pct(s.ungrounded.length, s.answerable)}  (${s.ungrounded.length}/${s.answerable})`);
  console.log(`  false answers        ${pct(s.falseAnswer.length, s.negatives)}  (${s.falseAnswer.length}/${s.negatives})  [pre-LLM gate only — see header comment before treating this as a hallucination rate]`);

  console.log(`\nThreshold sweep  (pick the knee, not the extreme)`);
  console.log(`  thresh  grounded  false-refuse  false-answer`);
  for (const t of SWEEP) {
    const x = score(rows, t);
    const mark = t === opts.threshold ? " <- current" : "";
    console.log(
      `  ${t.toFixed(2)}   ${pct(x.grounded.length, x.answerable)}     ` +
        `${pct(x.falseRefusal.length, x.answerable)}        ` +
        `${pct(x.falseAnswer.length, x.negatives)}${mark}`
    );
  }

  const missed = rows.filter((r) => !r.error && r.expect === "answer" && (!r.rank || r.rank > CONTEXT_K));
  if (missed.length) {
    console.log(`\nMissed retrievals (expected page outside top ${CONTEXT_K})`);
    for (const r of missed) {
      console.log(`  ${r.id.padEnd(24)} rank=${r.rank ?? "none"} top=${r.topScore?.toFixed(3) ?? "n/a"}`);
      if (opts.verbose) r.top3.forEach((t) => console.log(`      ${t}`));
    }
  }
  if (s.falseAnswer.length) {
    console.log(`\nFalse answers (should refuse, would answer)`);
    for (const r of s.falseAnswer) {
      console.log(`  ${r.id.padEnd(24)} top=${r.topScore.toFixed(3)}${r.note ? `  — ${r.note}` : ""}`);
      if (opts.verbose) r.top3.forEach((t) => console.log(`      ${t}`));
    }
  }
  console.log("");
  return s;
}

/* --------------------------------- main -------------------------------- */

// Guarded so score()/report() can be imported and tested without a Worker.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadCases(opts.file);
  console.error(`${cases.length} cases -> ${opts.url}/api/search`);

  const rows = await mapLimit(cases, CONCURRENCY, async (c) => {
    try {
      const r = await runCase(opts, c);
      process.stderr.write(".");
      return r;
    } catch (e) {
      process.stderr.write("!");
      return { id: c.id, expect: c.expect, note: c.note, error: e.message, topScore: null, rank: null, top3: [] };
    }
  });
  process.stderr.write("\n");

  const errors = rows.filter((r) => r.error);
  if (errors.length) {
    console.log(`\n${errors.length} request(s) failed:`);
    for (const r of errors) console.log(`  ${r.id}: ${r.error}`);
    if (errors.length === rows.length) process.exit(1);
  }

  if (opts.json) console.log(JSON.stringify({ rows, summary: score(rows, opts.threshold) }, null, 2));
  else report(rows, opts);
}
