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
 */

const EMBED_MODEL = "@cf/baai/bge-m3";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const RETRIEVE_K = 20;      // wide net from Vectorize
const CONTEXT_K = 6;        // chunks handed to the LLM after reranking
const MIN_RERANK_SCORE = 0.2; // below this for the best chunk => "not in the docs"

const SYSTEM_PROMPT = `You are the NeSI support assistant. You answer questions about NeSI's HPC and storage services (New Zealand eScience Infrastructure).

Rules — follow all of them strictly:
1. Answer ONLY from the documentation excerpts provided below. Never use outside knowledge about HPC, Slurm, or NeSI.
2. Cite sources inline with bracketed numbers like [1] or [2][3] that refer to the numbered excerpts. Every factual claim needs a citation.
3. If the excerpts do not contain the answer, say so plainly and suggest what to search the docs for or to contact support@nesi.org.nz. Do not guess.
4. Preserve exact command syntax, module names, paths and Slurm directives from the excerpts — put them in code blocks.
5. Be concise and practical. Users are researchers who want working commands.`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    try {
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

async function retrieve(env, query, topK = CONTEXT_K) {
  const vector = await embed(env, query);
  const result = await env.VECTORIZE.query(vector, {
    topK: RETRIEVE_K,
    returnValues: false,
    returnMetadata: "all",
  });
  const matches = result.matches ?? [];
  if (matches.length === 0) return [];

  // Second stage: cross-encoder rerank.
  let ranked = matches;
  try {
    const rr = await env.AI.run(RERANK_MODEL, {
      query,
      contexts: matches.map((m) => ({ text: (m.metadata?.text || "").slice(0, 2000) })),
    });
    const scores = rr.response ?? rr; // [{id, score}] where id = index into contexts
    ranked = scores
      .map((s) => ({ ...matches[s.id], rerankScore: s.score }))
      .sort((a, b) => b.rerankScore - a.rerankScore);
  } catch (e) {
    console.warn("rerank failed, falling back to vector order", e);
    ranked = matches.map((m) => ({ ...m, rerankScore: m.score }));
  }

  return ranked.slice(0, topK).map((m) => ({
    title: m.metadata?.title,
    heading: m.metadata?.heading,
    url: m.metadata?.url,
    path: m.metadata?.path, // read_nesi_doc's argument — its description promises this

    section: m.metadata?.section,
    text: m.metadata?.text,
    vectorScore: m.score,
    rerankScore: m.rerankScore,
  }));
}

function buildContext(sources) {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.heading} (${s.url})\n${s.text}`)
    .join("\n\n---\n\n");
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

  const sources = await retrieve(env, retrievalQuery);
  const confident = sources.length > 0 && sources[0].rerankScore >= MIN_RERANK_SCORE;

  const encoder = new TextEncoder();
  const sse = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  if (!confident) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "sources", sources: [] }));
        controller.enqueue(sse({ type: "token", text: "I couldn't find anything in the NeSI support docs that answers that. Try rephrasing with the specific service or tool name (e.g. Slurm, JupyterHub, Globus), or contact support@nesi.org.nz." }));
        controller.enqueue(sse({ type: "done" }));
        controller.close();
      },
    });
    return sseResponse(body);
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT + "\n\nDocumentation excerpts:\n\n" + buildContext(sources) },
    ...history.slice(-6),
    { role: "user", content: question },
  ];

  const aiStream = await env.AI.run(CHAT_MODEL, { messages, stream: true, max_tokens: 1024 });

  // Re-emit the model's SSE stream as our own event shape, with sources first.
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse({ type: "sources", sources: sources.map(({ text, ...s }) => s) }));
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
            if (parsed.response) controller.enqueue(sse({ type: "token", text: parsed.response }));
          } catch { /* partial line */ }
        }
      }
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
      ? results.map((r, i) => `[${i + 1}] ${r.title} — ${r.heading}\nURL: ${r.url}\nPath: ${r.path}\nRelevance: ${r.rerankScore?.toFixed(3)}\n\n${r.text}`).join("\n\n====\n\n")
      : "No relevant documentation found.";
    return { content: [{ type: "text", text }] };
  }
  if (name === "ask_nesi_docs") {
    const sources = await retrieve(env, args.question);
    if (!sources.length || sources[0].rerankScore < MIN_RERANK_SCORE) {
      return { content: [{ type: "text", text: "The NeSI support docs don't appear to cover this. Contact support@nesi.org.nz." }] };
    }
    const res = await env.AI.run(CHAT_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT + "\n\nDocumentation excerpts:\n\n" + buildContext(sources) },
        { role: "user", content: args.question },
      ],
      max_tokens: 1024,
    });
    const cites = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.url}`).join("\n");
    return { content: [{ type: "text", text: `${res.response}\n\nSources:\n${cites}` }] };
  }
  if (name === "read_nesi_doc") {
    const path = String(args.path || "");
    if (!/^[\w\-/.]+\.md$/.test(path) || path.includes("..")) throw new Error("invalid path");
    const raw = await fetch(`https://raw.githubusercontent.com/nesi/support-docs/main/docs/${path}`);
    if (!raw.ok) throw new Error(`page not found: ${path}`);
    return { content: [{ type: "text", text: await raw.text() }] };
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
