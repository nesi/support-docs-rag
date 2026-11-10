/**
 * REANNZ HPC (NeSI) Support Docs RAG — Cloudflare Worker
 *
 * Endpoints:
 *   POST /api/chat    { question, history? }  -> SSE stream: sources event, then tokens
 *   POST /api/search  { query, topK? }        -> JSON ranked chunks (raw retrieval)
 *   ALL  /mcp                                 -> MCP server (streamable HTTP, JSON-RPC)
 *   GET  /*                                   -> chat UI (static assets)
 *
 * RAG concept #3 — two-stage retrieval:
 * Vector search (bge-m3 + Vectorize) is fast but approximate: it finds
 * "semantically nearby" chunks. A cross-encoder reranker (bge-reranker-base)
 * then reads query+chunk *together* and scores actual relevance. We fetch a
 * wide net (topK=20) and keep only the best few (6) for the LLM. This is the
 * single biggest quality win over a plain "semantic search engine".
 *
 * RAG concept #4 — grounding:
 * The system prompt forbids answering from model memory, requires [n]
 * citations, and we refuse outright when retrieval confidence is too low.
 *
 * RAG concept #5 — exact lookup alongside search:
 * Software module names and glossary jargon are structured, name-keyed data,
 * not prose -- liveLookup() (src/liveData.mjs) matches them directly by name
 * at query time rather than pre-embedding all ~880 of them into Vectorize.
 * Precise, cheap, and always current; vector search still covers everything
 * that isn't an exact name match.
 */

import { liveLookup } from "./liveData.mjs";
import { isConfidentResponse } from "./confidence.mjs";
import { isValidDocPath } from "./docPath.mjs";
import { classifyJunk, junkReply, containsSecret, SECRET_REPLY, isRepeatQuestion, REPEAT_REPLY } from "./junk.mjs";
import { classifyStatusQuestion, statusReply } from "./statusShortcut.mjs";
import { realignSbatchBlocks, fillMissingModuleVersions, createSbatchStreamFilter } from "./slurmFormat.mjs";
import { cleanAnswer, createCitationStreamFilter } from "./citations.mjs";
import { createBreakStreamFilter } from "./breaks.mjs";

const EMBED_MODEL = "@cf/baai/bge-m3";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
// const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CHAT_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";
// Covers hidden reasoning plus the answer. Nemotron's reasoning counts toward
// this; at 1024 it sometimes used the whole budget and returned no answer.
// Billed on tokens used, so a higher cap costs nothing on typical answers.
const CHAT_MAX_TOKENS = 4096;
// Shown when the model returns no visible text (e.g. ran out of tokens).
const EMPTY_ANSWER = "Sorry, I couldn't produce an answer that time. Please try again, or contact [support@nesi.org.nz](mailto:support@nesi.org.nz).";

const RETRIEVE_K = 20;      // wide net from Vectorize
const CONTEXT_K = 6;        // chunks handed to the LLM after reranking
const MIN_RERANK_SCORE = 0.4; // below this a chunk isn't shown as a source at all, and below this for the best chunk => "not in the docs" — see scripts/eval-search.mjs's threshold sweep for why 0.4

// The docs site embeds a live status widget (status.nesi.org.nz) that the
// static ingest pipeline can't capture — it's dynamic, not a doc page. This
// is the standard unauthenticated Atlassian Statuspage summary endpoint;
// fetched fresh (edge-cached briefly) alongside retrieval so the model can
// tell "the docs don't cover this" apart from "this is a live outage".
const STATUS_API = "https://status.nesi.org.nz/api/v2/summary.json";
const STATUS_CACHE_TTL = 60; // seconds — edge cache for the status subrequest

// Appended AFTER the excerpts, not inside SYSTEM_PROMPT: the chat model
// (nemotron) followed a "keep it short, link the section" rule buried in
// rule 5 poorly -- it still listed every cause from the excerpts. Placed
// last, closest to the question, it carries more weight.
const ANSWER_SHAPE = `

=== ANSWER SHAPE (most important, overrides completeness) ===
- At most 3 short sentences or 4 short bullets. Pick only the cause/steps that best fit THIS question; don't list every possibility the excerpts mention.
- Then point to the docs for the rest with one line: "More: [Page title › Section heading](URL)" using the URL (with its #anchor) from the header of the excerpt you used most. Use only URLs from the excerpt headers, as markdown links — never bare <...> links or guessed URLs.
- A requested Slurm script still goes in full (rule 12); the link replaces extra explanation, not the script.
- No preamble, no closing filler ("If none of these work...", "If the problem persists..."). Mention support only if the excerpts say this needs support.`;

const SYSTEM_PROMPT = `You are the REANNZ HPC support assistant. You answer questions about REANNZ's HPC and storage services (Research Education Advanced Network New Zealand).

Rules — follow all of them strictly:
1. Answer ONLY from the documentation excerpts provided below. Never use outside knowledge about HPC, Slurm, or REANNZ.
2. Cite sources inline with bracketed numbers like [1] or [2][3] that refer to the numbered excerpts. Every factual claim needs a citation. Use only this plain [n] form — never 【n】, 【n†...】, line ranges, or any other citation style.
3. If the excerpts do not contain the answer, say so plainly and suggest what to search the docs for or to contact [support@nesi.org.nz](mailto:support@nesi.org.nz). Do not guess.
4. Preserve exact command syntax, module names, paths and Slurm directives from the excerpts - put them in code blocks.
5. Be concise: lead with the answer or command, no preamble ("Let's walk through some steps", "I'd be happy to help") and no closing filler ("If none of these steps work...", "If you're still having trouble..."). Give only the steps that apply to this question — don't enumerate every possible cause. Prefer a couple of sentences or short bullets over multi-paragraph explanations. Give one script or one command, not several variants side by side — if the excerpts support multiple genuinely different approaches, pick the most basic/common one, or ask the user which they mean instead of dumping all of them. This applies even when the excerpts present the variants as separate tabs/sections for the same tool (e.g. "Serial" vs "Distributed Memory") — that is one question with multiple modes, not multiple questions each needing its own excerpt answered; pick the simplest (usually Serial/single-node) unless the question itself specifies scale or parallelism.
   Link rather than reproduce: see ANSWER SHAPE at the end, which takes priority over completeness.
6. The entity NeSI (New Zealand eScience Infrastructure) has been incorporated into REANNZ (Research Education Advanced Network New Zealand).
   Avoid saying "NeSI" for the organisation — say "REANNZ HPC" instead. This does NOT apply to hardware/service names: keep using the specific name from the excerpts (e.g. "Mahuika", "HPC3", "Freezer", "OnDemand") when talking about clusters, storage, or tools.
   Each cluster and service keeps its own single name — OnDemand is called "OnDemand", full stop, regardless of which cluster the user is on. Only prefix or combine two proper nouns together if an excerpt itself writes them that way as one phrase.
7. Format every web address or email address as a markdown link (e.g. [status.nesi.org.nz](https://status.nesi.org.nz), [support@nesi.org.nz](mailto:support@nesi.org.nz)) — never output a bare URL or email address, and never wrap a link in backticks or a code block. Do not cite a link to internal documentation with itself.
8. Information from pages about specific software should be given more weight than general information when talking about that software.
(for example, if user asks 'How do I run ANSYS on GPUs' the small amount of information on the ANSYS page about GPUs should be weighted higher than general GPU use advice, no matter how extensive or relevent.)
9. A "LIVE SERVICE STATUS" block may be provided above the documentation excerpts, with its own instructions on when and how prominently to use it — follow those. It reflects real-time incidents/maintenance, not documentation, and always quote its text directly rather than paraphrasing.
10. Terminology mapping — two related cases:
    a. If the user names a service, cluster, or tool that the excerpts show has been renamed, replaced, or decommissioned (e.g. Māui, JupyterHub, Nearline), say so explicitly as fact in one short clause (e.g. "Nearline was replaced by Freezer") before answering with the current equivalent — don't just silently answer about the replacement as if that's what they asked.
    b. If the user uses a generic or third-party term that isn't NeSI/REANNZ terminology at all but has an obvious documented equivalent (e.g. "S3", "Glacier", "cold storage", "object storage" for Freezer), open with "Assuming you mean <current name>..." before answering — this is a vocabulary guess, not a documented fact, so phrase it as one and give the user room to correct it. Only do this when the mapping is unambiguous; if genuinely unsure which service they mean, ask instead of guessing.
11. For job submission, the preferred and default answer is a Slurm script submitted with \`sbatch\` (see the shape below). Don't recommend OnDemand's Slurm Job Composer unless the user specifically asks about it or about a GUI/OnDemand-based workflow.
12. When showing a Slurm submission script, use this shape — this overrides rule 4 for #SBATCH line formatting specifically. Use a single space between each flag and its value — column alignment is computed and applied downstream, not by you; do not try to pad or align the values yourself, that's how flags and values get run together or merged onto the wrong line.
    - Exactly one script, in its own fenced code block — per rule 5, don't add a second script or a second fence for an alternate mode/variant, and never combine two scripts (or a script plus an unrelated snippet) inside one fence.
    - Shebang \`#!/bin/bash -e\`, then one blank line.
    - Then the #SBATCH header: long-form flags only (--job-name, not -j). Every script needs --job-name, --account nesi99991, and --time, even a minimal example.
    - One blank line after the header, then the body.
    - Before any \`module load\`, put \`module purge\` on its own line. Include a version if the excerpts give one; otherwise a bare \`module load NAME\` is fine. Never invent a version number that isn't in the excerpts — this is rule 1 (no outside knowledge) applied to module versions specifically.
    - If an excerpt gives a real, complete script for the software/task asked about, reproduce its body as-is (variables, options, comments, the logic that makes it that software's script) — rule 4 governs, this is not the case the next sentence is about. Only when you're building a generic example with no specific script in the excerpts (e.g. a bare module-load demo) should you keep the body to the bare minimum needed to demonstrate the concept, with no invented flags or error handling.
    - Prefer a runnable example over an abstract placeholder when the excerpts give one (e.g. a tutorial's sample file via \`wget\`, a reference to \`$EB_ROOT\`) so the user can copy-paste and actually run it.

    Example shape (illustrative only — real values must come from the excerpts; note the single space before each value, no column alignment):
    \`\`\`
    #!/bin/bash -e

    #SBATCH --job-name example_job
    #SBATCH --account nesi99991
    #SBATCH --time 00:10:00

    module purge
    module load Python/3.12.5-foss-2023a

    python my_script.py
    \`\`\`
`;
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    try {
      // The three routes below all call Workers AI, which is metered and has
      // no built-in per-visitor throttle -- one shared per-IP budget across
      // them keeps a scripted loop from running up billed usage unattended.
      if (path === "/api/chat" || path === "/api/search" || path === "/mcp" || path === "/mcp/") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) return withCors(json({ error: "Too many requests, please slow down." }, 429));
      }
      if (path === "/api/chat") return withCors(await handleChat(request, env));
      if (path === "/api/search") return withCors(await handleSearch(request, env));
      if (path === "/mcp" || path === "/mcp/") return withCors(await handleMcp(request, env));
      // Anything else falls through to static assets (the chat UI)
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return withCors(json({ error: String(err.message || err) }, 500));
    }
  },
};

/* ------------------------------ auth ------------------------------ */
// Two supported modes, in order of preference:
//  1. Put the whole Worker behind Cloudflare Access (Zero Trust) and leave
//     API_KEY unset — Access handles SSO before requests reach us.
//  2. Set a shared secret:  npx wrangler secret put API_KEY
//     Clients send  Authorization: Bearer <key>   (the UI has a field for it).
function checkAuth(request, env) {
  if (!env.API_KEY) return true; // rely on Cloudflare Access
  const header = request.headers.get("Authorization") || "";
  return header === `Bearer ${env.API_KEY}`;
}

/* --------------------------- retrieval ---------------------------- */
async function embed(env, text) {
  const res = await env.AI.run(EMBED_MODEL, { text: [text] });
  const v = (res.data ?? res.embeddings)?.[0];
  if (!v) throw new Error("embedding failed");
  return v;
}

// `query` (which may have prior turns folded in, for recall on follow-ups
// like "and how much memory does that need?") drives the wide vector-search
// net -- a broad recall step, where pulling in a prior turn's wording is
// harmless. `rerankQuery` -- the current question alone, if given -- is
// tried first for the precise cross-encoder scoring step, so a prior turn's
// topic can't inflate this turn's relevance scores just because its wording
// is still present in `query`. Only if that alone doesn't clear the
// confidence bar (an elliptical follow-up like "and how do I check its
// status?", meaningless without the prior turn) do we retry scoring against
// the full folded `query`. Defaults to `query` for callers with no separate
// history to fold, which skips the fallback entirely.
async function retrieve(env, query, topK = CONTEXT_K, rerankQuery = query, applyMinScore = true) {
  const liveHits = await liveLookup(query).catch((e) => { console.warn("live lookup failed", e); return []; });
  // App hits (e.g. "ANSYS") often have a real docs page covering the same software in far more
  // depth -- rerank them against that page's chunks instead of pinning them in unconditionally,
  // so the more relevant one wins rather than the module-list card always shadowing the page.
  // Glossary hits have no competing page, so they keep the guaranteed top slot.
  const appHits = liveHits.filter((h) => h.section === "Software");
  const pinnedHits = liveHits.filter((h) => h.section !== "Software");
  if (pinnedHits.length >= topK) return pinnedHits.slice(0, topK); // exact matches alone fill the request -- skip embed/search/rerank

  const vector = await embed(env, query);
  const result = await env.VECTORIZE.query(vector, {
    topK: RETRIEVE_K,
    returnValues: false,
    returnMetadata: "all",
  });
  const matches = [
    ...(result.matches ?? []),
    ...appHits.map((h) => ({ metadata: { title: h.title, heading: h.heading, url: h.url, path: h.path, section: h.section, text: h.text }, score: 1 })),
  ];

  // Second stage: cross-encoder rerank, adjusted by the page's `search: boost`
  // frontmatter (see scripts/chunker.mjs). sqrt rather than a straight multiply
  // or a hard clamp: it pulls extreme values (boost: 10, boost: 0.01) toward 1
  // while still preserving direction, so one hand-tuned outlier page can't
  // single-handedly swing a chunk across MIN_RERANK_SCORE.
  const boostFactor = (m) => Math.sqrt(m.metadata?.boost ?? 1);
  const rerank = async (q) => {
    try {
      const rr = await env.AI.run(RERANK_MODEL, {
        query: q,
        contexts: matches.map((m) => ({ text: (m.metadata?.text || "").slice(0, 2000) })),
      });
      const scores = rr.response ?? rr; // [{id, score}] where id = index into contexts
      return scores
        .map((s) => ({ ...matches[s.id], rerankScore: s.score * boostFactor(matches[s.id]) }))
        .sort((a, b) => b.rerankScore - a.rerankScore);
    } catch (e) {
      console.warn("rerank failed, falling back to vector order", e);
      return matches.map((m) => ({ ...m, rerankScore: m.score * boostFactor(m) }));
    }
  };

  let ranked = [];
  if (matches.length) {
    ranked = await rerank(rerankQuery);
    if (rerankQuery !== query && !(ranked[0]?.rerankScore >= MIN_RERANK_SCORE)) {
      ranked = await rerank(query);
    }
  }

  const vectorSources = ranked
    .filter((m) => !applyMinScore || m.rerankScore >= MIN_RERANK_SCORE) // drop marginal chunks rather than padding out to topK; skipped for /api/search, which is raw retrieval (see eval-search.mjs's threshold sweep)
    .map((m) => ({
      title: m.metadata?.title,
      heading: m.metadata?.heading,
      url: m.metadata?.url,
      path: m.metadata?.path, // read_nesi_doc's argument — its description promises this

      section: m.metadata?.section,
      text: m.metadata?.text,
      vectorScore: m.score,
      rerankScore: m.rerankScore,
    }));

  // Glossary hits first: rerankScore 1 sorts them ahead and clears MIN_RERANK_SCORE outright.
  // App hits are already folded into vectorSources above, ranked on merit against their own page.
  return [...pinnedHits, ...vectorSources].slice(0, topK);
}

function buildContext(sources) {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.heading} (${s.url})\n${s.text}`)
    .join("\n\n---\n\n");
}

/* --------------------------- live status ---------------------------- */
// Fetches the Atlassian Statuspage summary. Returns null on any failure, or
// when everything is operational — there's nothing worth surfacing to the
// model in that case, and it keeps the "not confident" refusal path honest
// (no live status = don't imply we checked and it's fine).
// Raw Statuspage summary (edge-cached), or null on failure. fetchStatus()
// below reduces it to "only what's wrong"; the status shortcut needs the
// full component list too, to answer "is X down?" with "no, it's operational".
async function fetchStatusSummary() {
  try {
    const res = await fetch(STATUS_API, { cf: { cacheTtl: STATUS_CACHE_TTL, cacheEverything: true } });
    return res.ok ? await res.json() : null;
  } catch (e) {
    console.warn("status fetch failed", e);
    return null;
  }
}

async function fetchStatus() {
  try {
    const data = await fetchStatusSummary();
    if (!data?.status || data.status.indicator === "none") return null;

    // Each entry keeps its raw `name` alongside the formatted `text` line so
    // relevantStatusQuote() can match against the question without re-parsing.
    const incidents = (data.incidents || [])
      .filter((i) => i.status !== "resolved" && i.status !== "postmortem")
      .map((i) => {
        const latest = i.incident_updates?.[0];
        // `components` is this incident's OWN affected components (per the Statuspage
        // API), not the site-wide list -- relevantStatusQuote() needs that distinction
        // to avoid crediting an unrelated degraded component to this incident's detail.
        return {
          name: i.name,
          status: i.status,
          components: (i.components || []).map((c) => c.name),
          text: `- ${i.name} [${i.status}, impact: ${i.impact}]${latest ? `: ${latest.body}` : ""}`,
        };
      });

    const maintenances = (data.scheduled_maintenances || [])
      .filter((m) => m.status === "in_progress" || m.status === "scheduled")
      .map((m) => ({
        name: m.name,
        status: m.status,
        components: (m.components || []).map((c) => c.name),
        text: `- ${m.name} [${m.status}]: ${m.scheduled_for} → ${m.scheduled_until}`,
      }));

    const affected = (data.components || [])
      .filter((c) => c.status && c.status !== "operational")
      .map((c) => ({ name: c.name, status: c.status, text: `- ${c.name}: ${c.status.replace(/_/g, " ")}${c.description ? ` — ${c.description}` : ""}` }));

    return { indicator: data.status.indicator, description: data.status.description, incidents, maintenances, affected };
  } catch (e) {
    console.warn("status fetch failed", e);
    return null;
  }
}

// A truthy `status` (indicator !== "none") doesn't guarantee an open incident
// or scheduled maintenance entry -- a component can be manually marked
// degraded on Statuspage with neither, so this checks affected components
// on their own too, not just the primary incident/maintenance. Otherwise a
// "Jobs running on HPC: degraded_performance" flag with no incident text
// attached is invisible here even though it's exactly the kind of thing
// worth a one-line mention for a "why is my job slow to start" question.
//
// The primary incident/maintenance is only matched against ITS OWN name and
// components (from the Statuspage API), not the site-wide affected list --
// otherwise an unrelated degraded component (e.g. "Jobs running on HPC")
// gets wrongly credited to whatever the primary incident happens to be
// (e.g. a Freezer/tape incident that doesn't actually touch that component).
//
// Used only on the "docs found nothing" path, where there's no LLM call to
// judge relevance itself — so this does the matching heuristically (name or
// significant-word overlap with the question, singular/plural-insensitive:
// a component named "Jobs ..." should still match a question about "job").
// Returns a short "name (status)" string rather than the full incident
// body -- this is a passing mention pointing at the status page, not the
// place to explain the incident in detail. No match -> null, so the caller
// falls back to a generic "there's an unrelated outage" mention instead.
function relevantStatusQuote(status, question) {
  if (!status) return null;
  const q = question.toLowerCase();
  const nameMatches = (name) => {
    const lower = name.toLowerCase();
    if (q.includes(lower)) return true;
    return lower.split(/\s+/).some((w) => w.length > 3 && (q.includes(w) || q.includes(w.replace(/s$/, ""))));
  };

  const primary = status.incidents[0] || status.maintenances[0];
  if (primary) {
    const names = [primary.name, ...(primary.components || [])];
    if (names.some(nameMatches)) return `${primary.name} (${primary.status})`;
  }

  const component = status.affected.find((a) => nameMatches(a.name));
  return component ? `${component.name}: ${component.status.replace(/_/g, " ")}` : null;
}

function buildStatusBlock(status) {
  if (!status) return "";
  const parts = [`Indicator (background only, do not quote this line — use the incident detail below instead): ${status.description}`];
  if (status.incidents.length) parts.push("Incident detail (quote this part if relevant):\n" + status.incidents.map((i) => i.text).join("\n"));
  if (status.affected.length) parts.push("Affected components (for matching to the user's question only — do not list them all in your reply):\n" + status.affected.map((a) => a.text).join("\n"));
  if (status.maintenances.length) parts.push("Scheduled maintenance:\n" + status.maintenances.map((m) => m.text).join("\n"));
  const severe = status.indicator === "major" || status.indicator === "critical";
  const directive = severe
    ? "This is a major/critical outage. If the user's question could plausibly be affected by it (access, jobs, storage, transfers, portals — most things, during an outage this size), your ENTIRE reply should be: which specific component(s) from the list below match their question, quoting the relevant part of the incident detail (not the indicator line, not the full component list) — then \"See [status.nesi.org.nz](https://status.nesi.org.nz) for details.\" Skip doc-based troubleshooting entirely; it won't help until the outage is resolved."
    : "Mention this if the user's question is about, or names, a component listed as affected below — even a general how-to question about that component, not just \"is it down\"-style questions. Only skip it when the affected component is in a clearly different area from what they're asking about (e.g. a tape/long-term-storage incident does not affect a live transfer into project storage). If you mention it, quote the relevant incident-detail line (not the indicator line) in one sentence, then point to [status.nesi.org.nz](https://status.nesi.org.nz) for details.";
  return "\n\n=== LIVE SERVICE STATUS ===\n" + directive + "\n\n" + parts.join("\n\n");
}

/* ---------------------------- /api/chat --------------------------- */
// Junk gate ("test", "hi", keyboard mash): answered with a canned reply before
// any embed/search/rerank/LLM call. A known app/term name (liveLookup hit)
// always overrides it, so a module that happens to be called e.g. "foo" still
// gets looked up. Only the current question is checked, never history.
async function junkKind(question) {
  const kind = classifyJunk(question);
  if (!kind) return null;
  const hits = await liveLookup(question).catch(() => []);
  return hits.length ? null : kind;
}

// All pre-retrieval shortcuts, in priority order. Returns canned reply text,
// or null to carry on with normal retrieval.
//  1. Pasted secrets -- first, and never overridden: the text must not reach Workers AI.
//  2. "Is Mahuika down?" -- answered from the live status page (statusShortcut.mjs).
//  3. Junk / human / identity / rude (junk.mjs), overridable by a known app/term name.
//  4. Exact repeat of the user's previous message (chat only -- MCP has no
//     history). After status/junk on purpose: a repeated "is mahuika down?"
//     should re-check live status, and a repeated "hi" just gets the greeting.
async function shortcutReply(question, history = []) {
  if (containsSecret(question)) return SECRET_REPLY;
  const statusQ = classifyStatusQuestion(question);
  if (statusQ) {
    const reply = statusReply(await fetchStatusSummary(), statusQ);
    if (reply) return reply;
  }
  const junk = await junkKind(question);
  if (junk) return junkReply(junk);
  return isRepeatQuestion(question, history) ? REPEAT_REPLY : null;
}

async function handleChat(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
  const { question, history: rawHistory = [] } = await request.json();
  if (!question?.trim()) return json({ error: "question required" }, 400);
  // The client replays history every turn, so a secret pasted earlier would
  // otherwise reach the LLM on every later question. Drop those turns.
  const history = rawHistory.filter((m) => !containsSecret(m?.content));

  const shortcut = await shortcutReply(question, history);
  if (shortcut) {
    const encoder = new TextEncoder();
    const sse = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
    return sseResponse(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "sources", sources: [] }));
        controller.enqueue(sse({ type: "token", text: shortcut }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      },
    }));
  }

  // Fold short conversation history into the retrieval query so follow-ups
  // like "and how much memory?" still retrieve the right pages.
  const retrievalQuery = [...history.slice(-4).filter((m) => m.role === "user").map((m) => m.content), question]
    .join("\n").slice(-1000);

  const [sources, status] = await Promise.all([retrieve(env, retrievalQuery, CONTEXT_K, question), fetchStatus()]);
  const confident = isConfidentResponse(sources, MIN_RERANK_SCORE);

  const encoder = new TextEncoder();
  const sse = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  if (!confident) {
    const quote = relevantStatusQuote(status, retrievalQuery);
    const fallback = quote
      ? `I couldn't find anything in the NeSI support docs that answers that — but there's a live status update that might explain it: "${quote}". Check [status.nesi.org.nz](https://status.nesi.org.nz) for details, or contact [support@nesi.org.nz](mailto:support@nesi.org.nz) if this doesn't look related.`
      : status
        ? `I couldn't find anything in the NeSI support docs that answers that. There's also a live status update for a ${status.indicator} outage or maintenance right now, though it doesn't look related — check [status.nesi.org.nz](https://status.nesi.org.nz) if you think otherwise, or contact [support@nesi.org.nz](mailto:support@nesi.org.nz).`
        : "I couldn't find anything in the NeSI support docs that answers that. Try rephrasing with the specific service or tool name (e.g. Slurm, JupyterHub, Globus), or contact [support@nesi.org.nz](mailto:support@nesi.org.nz).";
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "sources", sources: [] }));
        controller.enqueue(sse({ type: "token", text: fallback }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      },
    });
    return sseResponse(body);
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + buildStatusBlock(status) + "\n\nDocumentation excerpts:\n\n" + buildContext(sources) + ANSWER_SHAPE },
    ...history.slice(-6),
    { role: "user", content: question },
  ];

  const aiStream = await env.AI.run(CHAT_MODEL, { messages, stream: true, max_tokens: CHAT_MAX_TOKENS });

  // Re-emit the model's SSE stream as our own event shape, with sources first.
  // Plain text is forwarded token-by-token as it arrives; #SBATCH blocks are
  // buffered whole by the filter so flag alignment can be applied before
  // they reach the client (see createSbatchStreamFilter).
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type: "sources", sources: sources.map(({ text, ...s }) => s) }));
      // Last stage: splits the answer into chat bubbles (answer / code block /
      // "More:" link) with `break` events -- see breaks.mjs.
      const breakFilter = createBreakStreamFilter(
        (text) => controller.enqueue(sse({ type: "token", text })),
        () => controller.enqueue(sse({ type: "break" })),
      );
      const sbatchFilter = createSbatchStreamFilter((text) => breakFilter.push(text));
      // Runs first: rewrites 【n†...】 citations to [n] (see citations.mjs).
      // The citation filter drops leading whitespace, so any emit is visible text.
      let answered = false;
      const citationFilter = createCitationStreamFilter((text) => { answered = true; return sbatchFilter.push(text); });
      const reader = aiStream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            // Older Workers AI models (llama) emit {response}; newer OpenAI-compatible
            // models (granite) emit {choices:[{delta:{content}}]} chunks instead.
            const chunk = parsed.response ?? parsed.choices?.[0]?.delta?.content;
            if (chunk) await citationFilter.push(chunk);
          } catch { /* partial line */ }
        }
      }
      await citationFilter.flush();
      if (!answered) await sbatchFilter.push(EMPTY_ANSWER);
      sbatchFilter.flush();
      breakFilter.flush();
      controller.enqueue(sse({ type: "done" }));
      controller.close();
    },
  });
  return sseResponse(body);
}

/* --------------------------- /api/search -------------------------- */
async function handleSearch(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
  const { query, topK = 8 } = await request.json();
  if (!query?.trim()) return json({ error: "query required" }, 400);
  const results = await retrieve(env, query, Math.min(topK, 20), query, false);
  return json({ results });
}

/* ------------------------------ /mcp ------------------------------ */
/**
 * Minimal MCP server over streamable HTTP (stateless mode).
 * MCP is JSON-RPC 2.0: the client POSTs one message, we answer it.
 * Implementing initialize / tools/list / tools/call is enough for
 * Claude Code, claude.ai connectors, and most other MCP clients.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http nesi-docs https://<worker-url>/mcp \
 *     --header "Authorization: Bearer <API_KEY>"
 */
const MCP_TOOLS = [
  {
    name: "search_nesi_docs",
    description: "Semantic search over the REANNZ (Research and Education Advanced Network New Zealand eScience Infrastructure) HPC and storage support documentation. Returns the most relevant documentation excerpts with their source URLs. Use this to ground answers about NeSI clusters, Slurm, storage, data transfer, software modules, and accounts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        topK: { type: "number", description: "Number of excerpts to return (default 6, max 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "ask_nesi_docs",
    description: "Ask a question and get a complete answer grounded in the REANNZ support documentation, with inline citations and source URLs. Prefer search_nesi_docs if you want to reason over raw excerpts yourself.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "The question to answer" } },
      required: ["question"],
    },
  },
  {
    name: "read_nesi_doc",
    description: "Fetch the full markdown source of a single REANNZ documentation page, given its repo path (as returned in search results metadata, e.g. 'Batch_Computing/Slurm/Job_prioritisation.md').",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative path under docs/, ending in .md" } },
      required: ["path"],
    },
  },
  {
    name: "check_nesi_status",
    description: "Check live NeSI/REANNZ HPC service status (status.nesi.org.nz) for active incidents or scheduled maintenance. Use this when a user's problem could plausibly be a temporary outage rather than a usage question — e.g. jobs stuck/not starting, login failures, storage or data-transfer errors — before concluding the docs don't have an answer.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleMcp(request, env) {
  if (!checkAuth(request, env)) return json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }, 401);
  if (request.method === "GET") return new Response(null, { status: 405 }); // no server-initiated stream in stateless mode
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const msg = await request.json();
  if (Array.isArray(msg)) return json({ error: "batching not supported" }, 400);

  // Notifications (no id) get an empty 202 per the streamable HTTP spec.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

  const reply = (result) => json({ jsonrpc: "2.0", id: msg.id, result });
  const rpcError = (code, message) => json({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "nesi-support-docs", version: "0.1.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call":
      try {
        return reply(await callTool(env, msg.params.name, msg.params.arguments || {}));
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    default:
      return rpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(env, name, args) {
  if (name === "search_nesi_docs") {
    const results = await retrieve(env, args.query, Math.min(args.topK || 6, 20));
    const text = results.length
      ? results.map((r, i) => `[${i + 1}] ${r.title} — ${r.heading}\nURL: ${r.url}\n${r.path ? `Path: ${r.path}\n` : ""}Relevance: ${r.rerankScore?.toFixed(3)}\n\n${r.text}`).join("\n\n====\n\n")
      : "No relevant documentation found.";
    return { content: [{ type: "text", text }] };
  }
  if (name === "ask_nesi_docs") {
    const shortcut = await shortcutReply(String(args.question ?? ""));
    if (shortcut) return { content: [{ type: "text", text: shortcut }] };
    const [sources, status] = await Promise.all([retrieve(env, args.question), fetchStatus()]);
    if (!isConfidentResponse(sources, MIN_RERANK_SCORE)) {
      const quote = relevantStatusQuote(status, args.question);
      const note = quote
        ? ` There is a live status update that might be relevant: "${quote}" (see status.nesi.org.nz).`
        : status
          ? ` Note: there is an unrelated live status update for a ${status.indicator} outage or maintenance right now — see status.nesi.org.nz if you think it could be relevant after all.`
          : "";
      return { content: [{ type: "text", text: `The NeSI support docs don't appear to cover this. Contact support@nesi.org.nz.${note}` }] };
    }
    const res = await env.AI.run(CHAT_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT + buildStatusBlock(status) + "\n\nDocumentation excerpts:\n\n" + buildContext(sources) + ANSWER_SHAPE },
        { role: "user", content: args.question },
      ],
      max_tokens: CHAT_MAX_TOKENS,
    });
    const cites = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.url}`).join("\n");
    // Older Workers AI models (llama) return {response}; newer OpenAI-compatible
    // models (granite, mistral) return {choices:[{message:{content}}]} instead.
    const text = res.response ?? res.choices?.[0]?.message?.content;
    // content is null when the model returns only reasoning.
    const cleaned = cleanAnswer(text ?? "");
    const answer = cleaned ? realignSbatchBlocks(await fillMissingModuleVersions(cleaned)) : EMPTY_ANSWER;
    return { content: [{ type: "text", text: `${answer}\n\nSources:\n${cites}` }] };
  }
  if (name === "read_nesi_doc") {
    const path = String(args.path || "");
    if (!isValidDocPath(path)) throw new Error("invalid path");
    const raw = await fetch(`https://raw.githubusercontent.com/nesi/support-docs/main/docs/${path}`);
    if (!raw.ok) throw new Error(`page not found: ${path}`);
    return { content: [{ type: "text", text: await raw.text() }] };
  }
  if (name === "check_nesi_status") {
    const status = await fetchStatus();
    const text = status
      ? `Status: ${status.description}\n\n` +
        (status.incidents.length ? `Active incidents:\n${status.incidents.map((i) => i.text).join("\n")}\n\n` : "") +
        (status.affected.length ? `Affected services:\n${status.affected.map((a) => a.text).join("\n")}\n\n` : "") +
        (status.maintenances.length ? `Scheduled maintenance:\n${status.maintenances.map((m) => m.text).join("\n")}\n\n` : "")
      : "All systems operational — no active incidents or scheduled maintenance reported at status.nesi.org.nz.";
    return { content: [{ type: "text", text: text.trim() }] };
  }
  throw new Error(`unknown tool: ${name}`);
}

/* ----------------------------- helpers ---------------------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function sseResponse(body) {
  return withCors(new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  }));
}
function withCors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  return new Response(res.body, { status: res.status, headers: h });
}
