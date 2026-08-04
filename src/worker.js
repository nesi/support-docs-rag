/**
 * NeSI Support Docs RAG — Cloudflare Worker
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
import { realignSbatchBlocks, fillMissingModuleVersions, createSbatchStreamFilter } from "./slurmFormat.mjs";

const EMBED_MODEL = "@cf/baai/bge-m3";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const RETRIEVE_K = 20;      // wide net from Vectorize
const CONTEXT_K = 6;        // chunks handed to the LLM after reranking
const MIN_RERANK_SCORE = 0.4; // below this a chunk isn't shown as a source at all, and below this for the best chunk => "not in the docs" — see scripts/eval.test.mjs's threshold sweep for why 0.4

// The docs site embeds a live status widget (status.nesi.org.nz) that the
// static ingest pipeline can't capture — it's dynamic, not a doc page. This
// is the standard unauthenticated Atlassian Statuspage summary endpoint;
// fetched fresh (edge-cached briefly) alongside retrieval so the model can
// tell "the docs don't cover this" apart from "this is a live outage".
const STATUS_API = "https://status.nesi.org.nz/api/v2/summary.json";
const STATUS_CACHE_TTL = 60; // seconds — edge cache for the status subrequest

const SYSTEM_PROMPT = `You are the REANNZ HPC support assistant. You answer questions about REANNZ's HPC and storage services (Research Education Advanced Network New Zealand).

Rules — follow all of them strictly:
1. Answer ONLY from the documentation excerpts provided below. Never use outside knowledge about HPC, Slurm, or NeSI.
2. Cite sources inline with bracketed numbers like [1] or [2][3] that refer to the numbered excerpts. Every factual claim needs a citation.
3. If the excerpts do not contain the answer, say so plainly and suggest what to search the docs for or to contact [support@nesi.org.nz](mailto:support@nesi.org.nz). Do not guess.
4. Preserve exact command syntax, module names, paths and Slurm directives from the excerpts - put them in code blocks.
5. Be concise: lead with the answer or command, no preamble ("Let's walk through some steps", "I'd be happy to help") and no closing filler ("If none of these steps work...", "If you're still having trouble..."). Give only the steps that apply to this question — don't enumerate every possible cause. Prefer a couple of sentences or short bullets over multi-paragraph explanations.
6. The entity NeSI (New Zealand eScience Infrastructure) has been incorporated into REANNZ (Research Education Advanced Network New Zealand).
   Avoid saying "NeSI" for the organisation — say "REANNZ HPC" instead. This does NOT apply to hardware/service names: keep using the specific name from the excerpts (e.g. "Mahuika", "HPC3", "Freezer", "OnDemand") when talking about clusters, storage, or tools.
   Each cluster and service keeps its own single name — OnDemand is called "OnDemand", full stop, regardless of which cluster the user is on. Only prefix or combine two proper nouns together if an excerpt itself writes them that way as one phrase.
7. Do not include unformatted links, and do not cite a link to internal documentation with itself.
8. Information from pages about specific software should be given more weight than general information when talking about that software.
(for example, if user asks 'How do I run ANSYS on GPUs' the small amount of information on the ANSYS page about GPUs should be weighted higher than general GPU use advice, no matter how extensive or relevent.)
9. A "LIVE SERVICE STATUS" block may be provided above the documentation excerpts, with its own instructions on when and how prominently to use it — follow those. It reflects real-time incidents/maintenance, not documentation: never cite it with [n], and always quote its text directly rather than paraphrasing.
10. If the user names a service, cluster, or tool that the excerpts show has been renamed, replaced, or decommissioned (e.g. Māui, JupyterHub, Nearline), say so explicitly in one short clause before answering with the current equivalent — don't just silently answer about the replacement as if that's what they asked.
11. When showing a Slurm submission script, use this exact shape — this overrides rule 4 for #SBATCH line formatting specifically: keep the flag names and values an excerpt gives you, but always rewrite the spacing/delimiter into the house style below, even if the excerpt itself writes that flag with \`=\` (e.g. an excerpt's \`--cpus-per-task=16\` becomes \`--cpus-per-task 16\`, column-aligned with the rest of the header).
    - Shebang \`#!/bin/bash -e\`, then one blank line.
    - Then the #SBATCH header: long-form flags only (--job-name, not -j), a space (not \`=\`) between flag and value — this applies to every #SBATCH line in the script, not only the three below, even ones copied from an excerpt. Every script needs --job-name, --account nesi99991, and --time, even a minimal example.
    - Alignment: find the longest flag name used in THIS script, then pad every flag (with spaces after the flag name, before its value) so every value starts in that same column — i.e. every flag name + its padding spaces must total the same character count. Recompute this per script; do not reuse the padding width from the example below, which is sized for its own shorter flag names.
    - One blank line after the header, then the body.
    - Before any \`module load\`, put \`module purge\` on its own line. Always give a version with the module (e.g. \`module load Python/3.12.5-foss-2023a\`, never a bare \`module load Python\`) — use the version marked "(default)" or given in a "Load with:" line in the excerpts; if several versions are listed with no marker, use the highest one shown. Never invent a version number that isn't in the excerpts — this is rule 1 (no outside knowledge) applied to module versions specifically. If the excerpts don't give you a real name+version for the software the user asked about, use a placeholder like \`module load your_module/your_version\` and say plainly that you don't have the exact module name on hand, rather than guessing one that looks plausible.
    - Keep the body to the bare minimum that demonstrates the concept — no extra flags, comments, or error handling beyond what's needed for a safe, correct example.
    - Prefer a runnable example over an abstract placeholder when the excerpts give one (e.g. a tutorial's sample file via \`wget\`, a reference to \`$EB_ROOT\`) so the user can copy-paste and actually run it.

    Example shape (illustrative only — real values must come from the excerpts):
    \`\`\`
    #!/bin/bash -e

    #SBATCH --job-name    example_job
    #SBATCH --account     nesi99991
    #SBATCH --time        00:10:00

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
async function retrieve(env, query, topK = CONTEXT_K, rerankQuery = query) {
  const liveHits = await liveLookup(query).catch((e) => { console.warn("live lookup failed", e); return []; });
  if (liveHits.length >= topK) return liveHits.slice(0, topK); // exact matches alone fill the request -- skip embed/search/rerank

  const vector = await embed(env, query);
  const result = await env.VECTORIZE.query(vector, {
    topK: RETRIEVE_K,
    returnValues: false,
    returnMetadata: "all",
  });
  const matches = result.matches ?? [];

  // Second stage: cross-encoder rerank.
  const rerank = async (q) => {
    try {
      const rr = await env.AI.run(RERANK_MODEL, {
        query: q,
        contexts: matches.map((m) => ({ text: (m.metadata?.text || "").slice(0, 2000) })),
      });
      const scores = rr.response ?? rr; // [{id, score}] where id = index into contexts
      return scores
        .map((s) => ({ ...matches[s.id], rerankScore: s.score }))
        .sort((a, b) => b.rerankScore - a.rerankScore);
    } catch (e) {
      console.warn("rerank failed, falling back to vector order", e);
      return matches.map((m) => ({ ...m, rerankScore: null }));
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
    .filter((m) => m.rerankScore == null || m.rerankScore >= MIN_RERANK_SCORE) // drop marginal chunks rather than padding out to topK; null = rerank failed, fall back to vector order untouched
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

  // Live hits first: rerankScore 1 sorts them ahead and clears MIN_RERANK_SCORE outright.
  return [...liveHits, ...vectorSources].slice(0, topK);
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
async function fetchStatus() {
  try {
    const res = await fetch(STATUS_API, { cf: { cacheTtl: STATUS_CACHE_TTL, cacheEverything: true } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.status || data.status.indicator === "none") return null;

    const incidents = (data.incidents || [])
      .filter((i) => i.status !== "resolved" && i.status !== "postmortem")
      .map((i) => {
        const latest = i.incident_updates?.[0];
        return `- ${i.name} [${i.status}, impact: ${i.impact}]${latest ? `: ${latest.body}` : ""}`;
      });

    const maintenances = (data.scheduled_maintenances || [])
      .filter((m) => m.status === "in_progress" || m.status === "scheduled")
      .map((m) => `- ${m.name} [${m.status}]: ${m.scheduled_for} → ${m.scheduled_until}`);

    const affected = (data.components || [])
      .filter((c) => c.status && c.status !== "operational")
      .map((c) => `- ${c.name}: ${c.status.replace(/_/g, " ")}${c.description ? ` — ${c.description}` : ""}`);

    return { indicator: data.status.indicator, description: data.status.description, incidents, maintenances, affected };
  } catch (e) {
    console.warn("status fetch failed", e);
    return null;
  }
}

function buildStatusBlock(status) {
  if (!status) return "";
  const parts = [`Indicator (background only, do not quote this line — use the incident detail below instead): ${status.description}`];
  if (status.incidents.length) parts.push("Incident detail (quote this part if relevant):\n" + status.incidents.join("\n"));
  if (status.affected.length) parts.push("Affected components (for matching to the user's question only — do not list them all in your reply):\n" + status.affected.join("\n"));
  if (status.maintenances.length) parts.push("Scheduled maintenance:\n" + status.maintenances.join("\n"));
  const severe = status.indicator === "major" || status.indicator === "critical";
  const directive = severe
    ? "This is a major/critical outage. If the user's question could plausibly be affected by it (access, jobs, storage, transfers, portals — most things, during an outage this size), your ENTIRE reply should be: which specific component(s) from the list below match their question, quoting the relevant part of the incident detail (not the indicator line, not the full component list) — then \"See https://status.nesi.org.nz for details.\" Skip doc-based troubleshooting entirely; it won't help until the outage is resolved."
    : "Only mention this if a listed affected component is what the user's specific action actually depends on — not merely in the same general area (e.g. a tape/long-term-storage incident does not affect a live transfer into project storage). When in doubt, leave it out. If you do mention it, quote the relevant incident-detail line (not the indicator line) in one sentence, then point to https://status.nesi.org.nz for details.";
  return "\n\n=== LIVE SERVICE STATUS (not a documentation source — never cite with [n]) ===\n" + directive + "\n\n" + parts.join("\n\n");
}

/* ---------------------------- /api/chat --------------------------- */
async function handleChat(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
  const { question, history = [] } = await request.json();
  if (!question?.trim()) return json({ error: "question required" }, 400);

  // Fold short conversation history into the retrieval query so follow-ups
  // like "and how much memory?" still retrieve the right pages.
  const retrievalQuery = [...history.slice(-4).filter((m) => m.role === "user").map((m) => m.content), question]
    .join("\n").slice(-1000);

  const [sources, status] = await Promise.all([retrieve(env, retrievalQuery, CONTEXT_K, question), fetchStatus()]);
  const confident = isConfidentResponse(sources, MIN_RERANK_SCORE);

  const encoder = new TextEncoder();
  const sse = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  if (!confident) {
    const quote = status?.incidents[0] || status?.maintenances[0];
    const fallback = status
      ? `I couldn't find anything in the NeSI support docs that answers that — but there's a live status update that might explain it: "${quote}". Check https://status.nesi.org.nz for details, or contact support@nesi.org.nz if this doesn't look related.`
      : "I couldn't find anything in the NeSI support docs that answers that. Try rephrasing with the specific service or tool name (e.g. Slurm, JupyterHub, Globus), or contact support@nesi.org.nz.";
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
    { role: "system", content: SYSTEM_PROMPT + buildStatusBlock(status) + "\n\nDocumentation excerpts:\n\n" + buildContext(sources) },
    ...history.slice(-6),
    { role: "user", content: question },
  ];

  const aiStream = await env.AI.run(CHAT_MODEL, { messages, stream: true, max_tokens: 1024 });

  // Re-emit the model's SSE stream as our own event shape, with sources first.
  // Plain text is forwarded token-by-token as it arrives; #SBATCH blocks are
  // buffered whole by the filter so flag alignment can be applied before
  // they reach the client (see createSbatchStreamFilter).
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type: "sources", sources: sources.map(({ text, ...s }) => s) }));
      const sbatchFilter = createSbatchStreamFilter((text) => controller.enqueue(sse({ type: "token", text })));
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
            if (parsed.response) await sbatchFilter.push(parsed.response);
          } catch { /* partial line */ }
        }
      }
      sbatchFilter.flush();
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
  const results = await retrieve(env, query, Math.min(topK, 20));
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
    description: "Semantic search over the NeSI (New Zealand eScience Infrastructure) HPC and storage support documentation. Returns the most relevant documentation excerpts with their source URLs. Use this to ground answers about NeSI clusters, Slurm, storage, data transfer, software modules, and accounts.",
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
    description: "Ask a question and get a complete answer grounded in the NeSI support documentation, with inline citations and source URLs. Prefer search_nesi_docs if you want to reason over raw excerpts yourself.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "The question to answer" } },
      required: ["question"],
    },
  },
  {
    name: "read_nesi_doc",
    description: "Fetch the full markdown source of a single NeSI documentation page, given its repo path (as returned in search results metadata, e.g. 'Batch_Computing/Slurm/Job_prioritisation.md').",
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
    const [sources, status] = await Promise.all([retrieve(env, args.question), fetchStatus()]);
    if (!isConfidentResponse(sources, MIN_RERANK_SCORE)) {
      const quote = status?.incidents[0] || status?.maintenances[0];
      const note = status ? ` There is a live status update that might be relevant: "${quote}" (see status.nesi.org.nz).` : "";
      return { content: [{ type: "text", text: `The NeSI support docs don't appear to cover this. Contact support@nesi.org.nz.${note}` }] };
    }
    const res = await env.AI.run(CHAT_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT + buildStatusBlock(status) + "\n\nDocumentation excerpts:\n\n" + buildContext(sources) },
        { role: "user", content: args.question },
      ],
      max_tokens: 1024,
    });
    const cites = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.url}`).join("\n");
    const answer = realignSbatchBlocks(await fillMissingModuleVersions(res.response));
    return { content: [{ type: "text", text: `${answer}\n\nSources:\n${cites}` }] };
  }
  if (name === "read_nesi_doc") {
    const path = String(args.path || "");
    if (!/^[\w\-/.]+\.md$/.test(path) || path.includes("..")) throw new Error("invalid path");
    const raw = await fetch(`https://raw.githubusercontent.com/nesi/support-docs/main/docs/${path}`);
    if (!raw.ok) throw new Error(`page not found: ${path}`);
    return { content: [{ type: "text", text: await raw.text() }] };
  }
  if (name === "check_nesi_status") {
    const status = await fetchStatus();
    const text = status
      ? `Status: ${status.description}\n\n` +
        (status.incidents.length ? `Active incidents:\n${status.incidents.join("\n")}\n\n` : "") +
        (status.affected.length ? `Affected services:\n${status.affected.join("\n")}\n\n` : "") +
        (status.maintenances.length ? `Scheduled maintenance:\n${status.maintenances.join("\n")}\n\n` : "")
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
