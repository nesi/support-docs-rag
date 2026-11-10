#!/usr/bin/env node
/**
 * Checks every `paths` entry in evals/questions.jsonl exists in a support-docs
 * checkout. Pages get renamed and moved; a stale path makes eval-search count
 * a correct retrieval as a miss (that's how `getting-help` sat at rank=none).
 *
 *   node scripts/check-eval-paths.mjs /path/to/support-docs/docs [--file evals/questions.jsonl]
 *
 * Case-only mismatches are warnings (eval-search compares page URLs
 * case-insensitively, see pageOf() in lib-eval.mjs); missing files fail.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./lib-eval.mjs";

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--file");
const file = args.includes("--file")
  ? args[args.indexOf("--file") + 1]
  : join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "questions.jsonl");
if (!root) {
  console.error("usage: node scripts/check-eval-paths.mjs /path/to/support-docs/docs [--file questions.jsonl]");
  process.exit(2);
}

const docs = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".md")) docs.push(relative(root, p).split(sep).join("/"));
  }
};
walk(root);
const exact = new Set(docs);
const byLower = new Map(docs.map((p) => [p.toLowerCase(), p]));

let missing = 0, caseOnly = 0, total = 0;
for (const c of loadCases(file)) {
  for (const p of c.paths || []) {
    total++;
    if (exact.has(p)) continue;
    const ci = byLower.get(p.toLowerCase());
    if (ci) { caseOnly++; console.log(`warn  ${c.id}: ${p} -> ${ci} (case only)`); continue; }
    missing++;
    const base = p.split("/").pop().toLowerCase();
    const near = docs.filter((d) => d.toLowerCase().endsWith("/" + base) || d.toLowerCase() === base);
    console.log(`FAIL  ${c.id}: ${p} not found${near.length ? ` (same filename: ${near.join(", ")})` : ""}`);
  }
}
console.log(`${total} paths checked against ${docs.length} pages: ${missing} missing, ${caseOnly} case-only`);
process.exit(missing ? 1 : 0);
