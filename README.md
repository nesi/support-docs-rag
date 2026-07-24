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
     docs.nesi.org.nz (rendered) ───────┘  scripts/ingest.mjs (fetch → chunk → embed → upsert)
     nesi/support-docs (frontmatter only, local clone)
```

**Why this is more than a search engine.** Stage 2 (vector search) finds chunks that are *semantically near* the question — it matches "why is my job stuck" to a page about queue priority even with zero shared keywords. Stage 3 is a cross-encoder reranker that reads question + chunk together and scores true relevance, filtering the near-misses. Stage 4 hands only those vetted excerpts to the LLM under a strict system prompt: answer only from excerpts, cite every claim, refuse when confidence is low.

**Ingest sources page bodies from the rendered site, not raw markdown.** Several pages (all ~50 `Software/Available_Applications/*` pages, plus a shared "contact support" link used on ~80 pages) build real content from mkdocs-macros Jinja includes that only resolve at site-build time — the module version table, the mailto link. The raw `.md` never has that content; regex-stripping the Jinja tag just deletes it. `scripts/renderedPage.mjs` fetches the live page, strips the theme chrome (nav, edit-page button, JS-only placeholder widgets), flattens the site's own tables/admonitions/tabs, and runs the rest through `turndown` back to markdown. Frontmatter (`description`, `tags`) still comes from the local `.md` clone — the rendered page doesn't expose those reliably. If a page's rendered fetch fails, 404s, or extracts suspiciously short, that one page falls back to the raw-markdown path — logged by `ingest.mjs`, never silent.

**Chunking** (`scripts/chunker.mjs`) splits each page on headings, merges tiny sections, splits huge ones (~450 tokens target), and prepends a breadcrumb ("Batch Computing > Slurm > Job priority") plus the page's frontmatter description and tags to the embedded text — so chunks carry their context into the vector space.

## Deploy (first time, ~10 minutes)

Check `npm --version` first. An old npm (6.x, common as a stale `/usr/local/bin/npm`) shadowing a Node 22 install resolves `npx wrangler` to an unrelated package, and every command below fails with `unknown subcommand`. Put your Node manager's bin directory ahead on `PATH` until `npm --version` reports 9 or newer.

```bash
npm install -g wrangler        # or use npx wrangler everywhere
wrangler login

# 1. Create the vector index (1024 dims = bge-m3; cosine for text similarity)
wrangler vectorize create nesi-docs --dimensions=1024 --metric=cosine

# 2. Deploy the Worker (serves UI + API + MCP)
wrangler deploy

# 3. Index the docs. Create an Account API token with three permissions:
#      Workers AI  Read   +  Workers AI  Edit   (the /ai/run REST endpoint needs both)
#      Vectorize   Edit                         (upsert is a write)
#    dash.cloudflare.com -> My Profile -> API Tokens -> Create Custom Token,
#    scoped to this account only. Account ID is on the Workers overview page.
git clone https://github.com/nesi/support-docs
npm install                        # cheerio + turndown — ingest tooling only, the Worker itself has no deps
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
node scripts/ingest.mjs support-docs/docs

# 4. Open the URL wrangler printed — ask "How do I submit a Slurm job?"
```

Ingest fetches every page from docs.nesi.org.nz (politely — capped concurrency, real User-Agent), so it takes longer than a local-only chunker would and needs the live site to be reachable. Preview what it will do without spending anything: `node scripts/ingest.mjs support-docs/docs --dry-run`.

Cost at internal-team scale: Workers free tier covers the requests; ingest of ~865 chunks is well within Workers AI's free daily allocation; per query you pay fractions of a cent for the 70B model tokens. Expect single-digit dollars per month.

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

Currently manual: re-run `scripts/ingest.mjs` after docs change. (A `.github/workflows/reingest.yml` triggered on pushes to `docs/**`, with `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` as secrets, is the intended automation — not written yet.) Vector ids are stable (`path#chunkIndex`, hashed when a long path would exceed Vectorize's 64-byte id limit), so re-ingest overwrites in place. After large reorganisations (renamed/deleted pages leave stale vectors), rebuild clean: `wrangler vectorize delete nesi-docs`, recreate, re-ingest.

## Evaluating retrieval

Don't tune the knobs below by feel — measure. `evals/questions.jsonl` holds 58 cases: 48 questions the docs answer (each tagged with the pages that should be retrieved) and 10 they don't, including hard negatives like a PBS `qsub` question on a Slurm-only site.

```bash
RAG_URL=https://<your-worker>.workers.dev node scripts/eval.mjs
node scripts/eval.mjs --verbose      # show the top-3 pages for each failure
node scripts/eval.mjs --local        # against `wrangler dev`
node scripts/eval.test.mjs           # checks the scoring maths, no Worker needed
```

Both the deployed and `--local` runs need a populated `nesi-docs` index — Vectorize has no local emulation, so `wrangler dev` binds to the remote one.

The runner hits `/api/search`, so it costs no LLM tokens and is repeatable. It reports hit@k and MRR for retrieval, then scores the refusal decision the same way the Worker does (`results[0].rerankScore >= MIN_RERANK_SCORE`) and sweeps that threshold. Read the sweep as a trade-off, not a score: raising the threshold cuts false answers and adds false refusals. `MIN_RERANK_SCORE = 0.2` is an untested starting guess — the sweep is how you replace it with a number you can defend.

The metric that matters most is `grounded`: confident *and* holding a relevant chunk within `CONTEXT_K`. Cases that are confident with no relevant source are the hallucination-shaped failures.

## Tuning knobs (src/worker.js)

`RETRIEVE_K` (20) — how wide the vector-search net is. `CONTEXT_K` (6) — how many reranked chunks the LLM sees; raise for multi-page questions, costs tokens. `MIN_RERANK_SCORE` (0.2) — the refusal threshold; raise it and the bot says "not in the docs" more often but hallucinates less. Note the fallback path at `worker.js:100`: if the reranker call fails, `rerankScore` becomes the raw cosine score, which sits above 0.2 for almost any query — so a reranker outage effectively disables the refusal gate. The eval's threshold sweep is only valid while rerank succeeds. `CHAT_MODEL` — swap for `@cf/meta/llama-4-scout-17b-16e-instruct` (131k context) if you raise CONTEXT_K a lot, or point at Anthropic via AI Gateway for higher answer quality later.

## Files

`src/worker.js` — router, retrieval pipeline, chat SSE endpoint, MCP server (no dependencies). `public/index.html` — chat UI (vanilla JS, streaming, citations). `scripts/chunker.mjs` — markdown-aware chunker (frontmatter + splitting logic; body text can come from either source below). `scripts/renderedPage.mjs` — fetches and converts a rendered docs.nesi.org.nz page back to markdown. `scripts/ingest.mjs` — fetch (with raw-markdown fallback) → chunk → embed → upsert. `scripts/eval.mjs` — retrieval + refusal eval. `scripts/eval.test.mjs` — tests the eval's scoring. `evals/questions.jsonl` — the eval cases. `package.json` — `cheerio`/`turndown`, ingest tooling only.
