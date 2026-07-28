/**
 * Resolves docs/GLOSSARY.md's `{% include "partials/glossary.html" %}` into
 * real content. That include isn't a live Jinja template — both it and
 * docs/assets/glossary/snippets.md are static files fetched nightly from the
 * upstream nesi/nesi-wordlist repo's `outputs/` (see fetch_includes.sh).
 *
 * snippets.md is the better parse target of the two: it's mkdocs-material's
 * abbreviation-glossary format (`*[TERM]: definition`, one per line, built
 * for exactly this kind of automated consumption), rather than glossary.html's
 * incidental `## Term:` heading shape. The same definition often appears
 * under several surface forms — possessive ("HPC's"), plural ("HPCs"), even
 * unrelated synonyms ("supercomputer", "supercomputing") all sharing one
 * canonical definition — so entries are grouped by definition text, not just
 * a suffix pattern.
 *
 * Most groups just repeat an app's module-list.json `description` verbatim
 * (e.g. `*[ANSYS]:`), and those apps already get a full page via appData.mjs
 * — ingesting both would create near-duplicate vectors. Only groups whose
 * terms AREN'T an app name are true jargon/acronym definitions worth
 * indexing here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY_LINE = /^\*\[(.+?)\]:\s?(.*)$/;

export function loadGlossarySnippets(docsRoot) {
  try {
    return readFileSync(join(docsRoot, "assets/glossary/snippets.md"), "utf8");
  } catch {
    return ""; // missing/unreadable -> no-op, same convention as loadModuleList
  }
}

export function parseGlossaryEntries(raw) {
  const entries = [];
  let current = null;
  for (const line of raw.split("\n")) {
    const m = line.match(ENTRY_LINE);
    if (m) {
      if (current) entries.push(current);
      current = { term: m[1].trim(), parts: [m[2]] };
    } else if (current) {
      current.parts.push(line);
    }
  }
  if (current) entries.push(current);
  return entries
    .map((e) => ({ term: e.term, definition: e.parts.join(" ").replace(/\s+/g, " ").trim() }))
    .filter((e) => e.definition);
}

/** Group terms that share an identical definition into one entry with aliases. */
function groupByDefinition(entries) {
  const order = [];
  const terms = new Map(); // definition -> terms seen, in first-seen order
  for (const e of entries) {
    if (!terms.has(e.definition)) { terms.set(e.definition, []); order.push(e.definition); }
    terms.get(e.definition).push(e.term);
  }
  return order.map((definition) => {
    const group = terms.get(definition);
    // Shortest surface form reads best as the canonical name (acronyms are usually shortest).
    const term = group.reduce((a, b) => (b.length < a.length ? b : a));
    const aliases = group.filter((t) => t !== term);
    return { term, aliases, definition };
  });
}

/** The jargon/acronym subset: groups where no surface form is itself an app name. */
export function resolveGlossaryEntries(docsRoot, moduleList) {
  const raw = loadGlossarySnippets(docsRoot);
  if (!raw) return [];
  const appNames = new Set(Object.keys(moduleList).map((k) => k.toLowerCase()));
  return groupByDefinition(parseGlossaryEntries(raw))
    .filter((e) => ![e.term, ...e.aliases].some((t) => appNames.has(t.toLowerCase())));
}
