# NeSI Support Docs RAG

A retrieval-augmented assistant for [docs.nesi.org.nz](https://docs.nesi.org.nz), built entirely on Cloudflare: a chat UI for people and an MCP server for their AI agents. Answers are grounded in the documentation with inline citations — if the docs don't cover something, it says so instead of guessing.

## How it works

```
                     ┌─────────────────────── Cloudflare Worker ───────────────────────┐
  Browser (chat UI)──┤  /api/chat                                                      │
  AI agents (MCP) ───┤  /mcp        1. embed question        @cf/baai/bge-m3           │
  Scripts ───────────┤  /api/search 2. vector search         Vectorize (nesi-docs)     │
                     │              3. rerank top-20 → 6     @cf/baai/bge-reranker-base│
                     │              4. grounded answer       @cf/meta/llama-3.3-70b    │
                     └─────────────────────────────────────────────────────────────────┘
                                        ▲
        nesi/support-docs (GitHub) ─────┘  scripts/ingest.mjs (chunk → embed → upsert)
```

**Why this is more than a search engine.** Stage 2 (vector search) finds chunks that are *semantically near* the question — it matches "why is my job stuck" to a page about queue priority even with zero shared keywords. Stage 3 is a cross-encoder reranker that reads question + chunk together and scores true relevance, filtering the near-misses. Stage 4 hands only those vetted excerpts to the LLM under a strict system prompt: answer only from excerpts, cite every claim, refuse when confidence is low.

**Chunking** (`scripts/chunker.mjs`) splits each page on headings, merges tiny sections, splits huge ones (~450 tokens target), and prepends a breadcrumb ("Batch Computing > Slurm > Job priority") plus the page's frontmatter description and tags to the embedded text — so chunks carry their context into the vector space.

## Deploy (first time, ~10 minutes)

```bash
npm install -g wrangler        # or use npx wrangler everywhere
wrangler login

# 1. Create the vector index (1024 dims = bge-m3; cosine for text similarity)
wrangler vectorize create nesi-docs --dimensions=1024 --metric=cosine

# 2. Deploy the Worker (serves UI + API + MCP)
wrangler deploy

# 3. Index the docs. Needs an API token with Workers AI:Read + Vectorize:Edit
#    (dash.cloudflare.com -> My Profile -> API Tokens; account ID is on the Workers overview page)
git clone https://github.com/nesi/support-docs
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
node scripts/ingest.mjs support-docs/docs

# 4. Open the URL wrangler printed — ask "How do I submit a Slurm job?"
```

Cost at internal-team scale: Workers free tier covers the requests; ingest of ~685 chunks is well within Workers AI's free daily allocation; per query you pay fractions of a cent for the 70B model tokens. Expect single-digit dollars per month.

## Locking it down (internal team)

Preferred: put the Worker behind **Cloudflare Access** (Zero Trust → Access → Applications → add your `workers.dev` URL or custom domain, allow your team's email domain). SSO in front, no code changes, leave `API_KEY` unset.

Simple alternative: `wrangler secret put API_KEY` — then the UI's key field and the MCP `Authorization: Bearer` header are required. Fine for a pilot; Access is the production answer (note: for MCP clients behind Access, use a [service token](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/) in headers).

## Connecting AI agents (MCP)

The Worker exposes an MCP server (streamable HTTP) at `/mcp` with three tools: `search_nesi_docs` (raw excerpts + URLs, lets the agent reason itself), `ask_nesi_docs` (full grounded answer with citations), and `read_nesi_doc` (full markdown of one page, fetched from GitHub).

```bash
# Claude Code
claude mcp add --transport http nesi-docs https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <API_KEY>"
```

claude.ai (Settings → Connectors → Add custom connector) and other MCP clients take the same URL.

## Keeping the index fresh

`.github/workflows/reingest.yml` re-runs ingestion on every push to `docs/**` (add `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` as GitHub secrets). Vector ids are stable (`path#chunkIndex`), so re-ingest overwrites in place. After large reorganisations (renamed/deleted pages leave stale vectors), rebuild clean: `wrangler vectorize delete nesi-docs`, recreate, re-ingest.

## Tuning knobs (src/worker.js)

`RETRIEVE_K` (20) — how wide the vector-search net is. `CONTEXT_K` (6) — how many reranked chunks the LLM sees; raise for multi-page questions, costs tokens. `MIN_RERANK_SCORE` (0.2) — the refusal threshold; raise it and the bot says "not in the docs" more often but hallucinates less. `CHAT_MODEL` — swap for `@cf/meta/llama-4-scout-17b-16e-instruct` (131k context) if you raise CONTEXT_K a lot, or point at Anthropic via AI Gateway for higher answer quality later.

## Files

`src/worker.js` — router, retrieval pipeline, chat SSE endpoint, MCP server (no dependencies). `public/index.html` — chat UI (vanilla JS, streaming, citations). `scripts/chunker.mjs` — markdown-aware chunker. `scripts/ingest.mjs` — embed + upsert to Vectorize. `.github/workflows/reingest.yml` — auto-sync on docs changes.
