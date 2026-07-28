/**
 * Exact-name lookup for module-list.json apps and glossary jargon, resolved
 * live at query time instead of pre-embedded into Vectorize.
 *
 * Data comes straight from the public upstream repos cached at the edge for
 * CACHE_TTL_SECONDS so this doesn't hit GitHub on every request.
 *
 * Known limitation: a handful of module-list.json app names are short,
 * common English words/abbreviations (R, Go, DB, uv, ...) -- case-sensitive
 * whole-word matching cuts false positives a lot (module names are almost
 * always written in their canonical case) but can't eliminate them (e.g.
 * "Go to the login node"). Accepted trade-off, not fixable without real NLU.
 */

import { renderModuleRecord } from "./appData.mjs";
import { resolveGlossaryEntries } from "./glossaryData.mjs";

const MODULE_LIST_URL = "https://raw.githubusercontent.com/nesi/modules-list/main/module-list.json";
const SNIPPETS_URL = "https://raw.githubusercontent.com/nesi/nesi-wordlist/main/outputs/snippets.md";
const CACHE_TTL_SECONDS = 3600;
const APPS_SEARCH_URL = "https://docs.nesi.org.nz/Software/Available_Applications/";
const GLOSSARY_URL = "https://docs.nesi.org.nz/GLOSSARY/";

async function cachedFetch(url) {
  const cache = caches.default;
  const cacheKey = new Request(url);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.text();

  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
  const text = await res.text();
  const cached = new Response(text, { headers: { "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` } });
  await cache.put(cacheKey, cached);
  return text;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Isolates are reused across requests, so cache the built index + compiled
// regex in memory too -- not just the raw fetch -- otherwise every request
// re-parses ~800 apps and recompiles an ~880-alternative regex for nothing.
let cached = null;
let cachedAt = 0;

async function loadTermIndex() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_SECONDS * 1000) return cached;

  const [moduleListText, snippetsText] = await Promise.all([cachedFetch(MODULE_LIST_URL), cachedFetch(SNIPPETS_URL)]);
  const moduleList = JSON.parse(moduleListText);
  const jargon = resolveGlossaryEntries(snippetsText, moduleList);

  const index = new Map(); // exact-case term/alias -> hit
  for (const [name, app] of Object.entries(moduleList)) index.set(name, { kind: "app", name, app });
  for (const entry of jargon) for (const name of [entry.term, ...entry.aliases]) index.set(name, { kind: "jargon", entry });

  const terms = [...index.keys()].sort((a, b) => b.length - a.length); // longest first
  const pattern = new RegExp(`\\b(?:${terms.map(escapeRegex).join("|")})\\b`, "g");

  cached = { index, pattern };
  cachedAt = now;
  return cached;
}

/** Case-sensitive whole-word match against every known term/alias. */
function findMentions(question, { index, pattern }) {
  const hits = new Map(); // dedup by matched text
  for (const m of question.matchAll(pattern)) hits.set(m[0], index.get(m[0]));
  return [...hits.values()];
}

function toSource(hit) {
  if (hit.kind === "app") {
    return {
      title: hit.name,
      heading: hit.name,
      url: `${APPS_SEARCH_URL}?search=${encodeURIComponent(hit.name)}`,
      path: null,
      section: "Software",
      text: renderModuleRecord(hit.name, hit.app),
      rerankScore: 1, // exact name match -- always confident
    };
  }
  const { term, aliases, definition } = hit.entry;
  return {
    title: term,
    heading: term,
    url: GLOSSARY_URL,
    path: "GLOSSARY.md",
    section: "GLOSSARY.md",
    text: `${term}${aliases.length ? ` (also: ${aliases.join(", ")})` : ""}: ${definition}`,
    rerankScore: 1,
  };
}

/** Exact-name hits for any module/jargon term mentioned in `question`, as retrieve()-shaped sources. */
export async function liveLookup(question) {
  const termIndex = await loadTermIndex();
  return findMentions(question, termIndex).map(toSource);
}
