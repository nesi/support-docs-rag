#!/usr/bin/env node
/**
 * Answer-quality eval for the NeSI docs RAG.
 *
 * eval-search.mjs checks retrieval and the pre-LLM refusal gate against /api/search —
 * cheap, no model call. This script is the other half: it calls the real
 * `ask_nesi_docs` MCP tool (same code path as /api/chat, minus streaming) and
 * checks the *generated answer* against a human-verified reference.
 *
 * Same file as eval-search.mjs (evals/questions.jsonl) — this script just uses the
 * subset of cases that have been hand-verified with a `reference_answer`
 * (fact-checked against the actual docs), skipping the rest. Automated
 * grading is deliberately shallow — case-insensitive substring checks for
 * `must_include` facts, plus a citation-overlap check against `paths` —
 * because exact wording varies run to run and a full semantic judge is out
 * of scope here. This catches regressions where a fact silently drops or a
 * wrong page gets cited; it does NOT confirm the prose reads well or that
 * nothing false was added. Use --verbose to print the full answer next to
 * reference_answer and eyeball it; that manual check is still part of
 * "verified" for this eval set.
 *
 * To add a case: pick one already in questions.jsonl (or add a new one),
 * write a reference_answer grounded in the real doc, and list a few short
 * must_include facts/numbers/flags that any correct answer has to contain.
 *
 * Usage:
 *   RAG_URL=https://nesi-docs-rag.<subdomain>.workers.dev node scripts/eval-ask.mjs
 *   node scripts/eval-ask.mjs --local             # against `npx wrangler dev`
 *   node scripts/eval-ask.mjs --verbose            # print full answer text per case
 *   node scripts/eval-ask.mjs --id oom-kill        # run a single case
 *
 * Set API_KEY if the Worker has the shared-secret auth enabled.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToUrl } from "./chunker.mjs";
import { loadCases, mapLimit, pageOf, resolveUrl } from "./lib-eval.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = 2; // each case is a full retrieve+rerank+LLM call

/* ----------------------------- arg parsing ----------------------------- */

function parseArgs(argv) {
  const opts = {
    url: process.env.RAG_URL || "",
    file: join(HERE, "..", "evals", "questions.jsonl"),
    verbose: false,
    json: false,
    id: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") opts.url = "http://127.0.0.1:8787";
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--id") opts.id = argv[++i];
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--json") opts.json = true;
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  opts.url = resolveUrl(opts.url);
  return opts;
}

/* ------------------------------- the run ------------------------------- */

// Only cases someone has hand-verified (written + fact-checked a
// reference_answer) are graded here — the rest are retrieval-only, covered
// by eval-search.mjs.
function loadVerifiedCases(file, onlyId) {
  const verified = loadCases(file).filter((c) => c.reference_answer);
  return onlyId ? verified.filter((c) => c.id === onlyId) : verified;
}

let nextRpcId = 1;

async function askNesiDocs(opts, question) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.API_KEY) headers.Authorization = `Bearer ${process.env.API_KEY}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: nextRpcId++,
    method: "tools/call",
    params: { name: "ask_nesi_docs", arguments: { question } },
  });

  const res = await fetch(`${opts.url}/mcp`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`/mcp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const msg = await res.json();
  if (msg.error) throw new Error(`tools/call error: ${msg.error.message}`);
  const text = msg.result?.content?.[0]?.text ?? "";
  if (msg.result?.isError) throw new Error(`ask_nesi_docs tool error: ${text}`);
  const [answer, sourcesBlock = ""] = text.split(/\n\nSources:\n/);
  const citedUrls = [...sourcesBlock.matchAll(/^\[\d+\]\s.+?:\s(\S+)$/gm)].map((m) => m[1]);
  return { answer: answer.trim(), citedUrls };
}

async function runCase(opts, c) {
  const { answer, citedUrls } = await askNesiDocs(opts, c.question);
  const haystack = answer.toLowerCase();

  const missing = (c.must_include || []).filter((phrase) => !haystack.includes(phrase.toLowerCase()));
  const expectedPages = new Set((c.paths || []).map((p) => pageOf(pathToUrl(p))));
  const citedPages = new Set(citedUrls.map(pageOf));
  const citationHit = expectedPages.size === 0 || [...expectedPages].some((p) => citedPages.has(p));

  return {
    id: c.id,
    question: c.question,
    reference_answer: c.reference_answer,
    answer,
    missing,
    citationHit,
    citedUrls,
    pass: missing.length === 0 && citationHit,
  };
}

/* ------------------------------- reporting ------------------------------- */

export function report(rows, opts) {
  const errors = rows.filter((r) => r.error);
  const scored = rows.filter((r) => !r.error);
  const passed = scored.filter((r) => r.pass);

  console.log(`\n${passed.length}/${scored.length} passed (facts present + expected page cited)`);
  if (errors.length) console.log(`${errors.length} request(s) errored — excluded above`);

  for (const r of rows) {
    if (r.error) {
      console.log(`\n[ERROR] ${r.id}: ${r.error}`);
      continue;
    }
    if (!r.pass || opts.verbose) {
      console.log(`\n[${r.pass ? "PASS" : "FAIL"}] ${r.id} — ${r.question}`);
      if (r.missing.length) console.log(`  missing facts: ${r.missing.join(", ")}`);
      if (!r.citationHit) console.log(`  expected page not cited (cited: ${r.citedUrls.join(", ") || "none"})`);
      if (opts.verbose) {
        console.log(`  reference: ${r.reference_answer}`);
        console.log(`  actual:    ${r.answer.replace(/\n/g, "\n             ")}`);
      }
    }
  }
  console.log("");
  return { passed: passed.length, total: scored.length, errors: errors.length };
}

/* --------------------------------- main -------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const cases = loadVerifiedCases(opts.file, opts.id);
  if (!cases.length) {
    console.error(opts.id ? `no case with id "${opts.id}"` : `no cases in ${opts.file}`);
    process.exit(2);
  }
  console.error(`${cases.length} case(s) -> ${opts.url}/mcp (ask_nesi_docs)`);

  const rows = await mapLimit(cases, CONCURRENCY, async (c) => {
    try {
      const r = await runCase(opts, c);
      process.stderr.write(r.pass ? "." : "x");
      return r;
    } catch (e) {
      process.stderr.write("!");
      return { id: c.id, question: c.question, error: e.message };
    }
  });
  process.stderr.write("\n");

  if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else {
    const s = report(rows, opts);
    if (s.errors === rows.length) process.exit(1);
    if (s.passed < s.total) process.exit(1);
  }
}
