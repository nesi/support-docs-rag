# NeSI Support Docs RAG

A retrieval-augmented assistant for [docs.nesi.org.nz](https://docs.nesi.org.nz), built entirely on Cloudflare: a chat UI for people and an MCP server for their AI agents. Answers are grounded in the documentation with inline citations — if the docs don't cover something, it says so instead of guessing.

## How it works

```
                     ┌─────────────────────── Cloudflare Worker ───────────────────────┐
  Browser (chat UI)──┤  /api/chat                                                      │
  AI agents (MCP) ───┤  /mcp        1. live lookup           module/glossary names     │
  Scripts ───────────┤  /api/search 2. embed question        @cf/baai/bge-m3           │
                     │              3. vector search         Vectorize (nesi-docs)     │
                     │              4. rerank top-20 → 6     @cf/baai/bge-reranker-base│
                     │              5. grounded answer       @cf/meta/llama-3.3-70b    │
                     └─────────────────────────────────────────────────────────────────┘
                                        ▲
     nesi/support-docs (local clone) ───┘  scripts/ingest.mjs (chunk → embed → upsert)
                                           prose docs only -- module/glossary data is
                                           looked up live instead (src/liveData.mjs)
```

**Why this is more than a search engine.** Stage 3 (vector search) finds chunks that are *semantically near* the question — it matches "why is my job stuck" to a page about queue priority even with zero shared keywords. Stage 4 is a cross-encoder reranker that reads question + chunk together and scores true relevance, filtering the near-misses. Stage 5 hands only those vetted excerpts to the LLM under a strict system prompt: answer only from excerpts, cite every claim, refuse when confidence is low.

**Module-list.json apps and glossary jargon are looked up live, not ingested.** These are structured, name-keyed data (~861 apps, ~20 jargon terms) — vector search only *approximates* rediscovering something you could just look up directly by name. Stage 1, `src/liveData.mjs`, fetches `module-list.json`/`snippets.md` straight from their public upstream repos (`nesi/modules-list`, `nesi/nesi-wordlist` — the same ones `support-docs` itself mirrors), edge-cached for an hour, and matches known names against the question with a case-sensitive whole-word regex. Cheaper than embedding all ~880 of them, exactly precise for any question naming a known app/term, and always current with upstream. `src/appData.mjs`/`src/glossaryData.mjs` render that structured data into readable text — description, version list, licence warnings for apps; term + definition for jargon — pure functions with no `node:fs`, which is what makes them importable into the Workers runtime at all. `Software/Available_Applications/*` pages still reference `applications[...]` via mkdocs-macros in their raw markdown, but ingest just lets the generic Jinja strip drop those — live lookup covers that data uniformly for every app, not just the ~50 with a page.

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
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
node scripts/ingest.mjs support-docs/docs

# 4. Open the URL wrangler printed — ask "How do I submit a Slurm job?"
```

Ingest reads only the local checkout — no network fetch of the deployed site, no dependency on it being caught up with your local edits. Preview what it will do without spending anything: `node scripts/ingest.mjs support-docs/docs --dry-run`.

Cost at internal-team scale: Workers free tier covers the requests; ingest of ~630 chunks is well within Workers AI's free daily allocation; per query you pay fractions of a cent for the 70B model tokens, plus live lookup's own near-zero cost (edge-cached fetches, no embedding involved). Expect single-digit dollars per month.

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

Automated: `support-docs`'s own CI (`deploy.yml`) triggers a pipeline on `nesi-docs-rag` on every push to `main`. `nesi-docs-rag` lives on GitLab, not GitHub, so that's a GitLab pipeline-trigger API call, not a shared-repo checkout — the pipeline (`.gitlab-ci.yml`) clones `support-docs` itself (public, no auth needed) and runs `scripts/ingest_local.sh`, the same script you'd run by hand locally. Needs `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` set as GitLab CI/CD variables on the project, plus a GitLab pipeline trigger token stored as a `GITLAB_TRIGGER_TOKEN` secret on the `support-docs` GitHub repo — not yet added as of writing, so the pipeline exists but isn't live until those are set. Vector ids are stable (`path#chunkIndex`, hashed when a long path would exceed Vectorize's 64-byte id limit), so re-ingest overwrites in place. After large reorganisations (renamed/deleted pages leave stale vectors), rebuild clean: `wrangler vectorize delete nesi-docs`, recreate, re-ingest. Module-list.json/glossary content never needs re-ingesting at all — it's resolved live on every question.

## Evaluating retrieval

Don't tune the knobs below by feel — measure. `evals/questions.jsonl` holds 58 cases: 48 questions the docs answer (each tagged with the pages that should be retrieved) and 10 they don't, including hard negatives like a PBS `qsub` question on a Slurm-only site.

```bash
RAG_URL=https://<your-worker>.workers.dev node scripts/eval.mjs
node scripts/eval.mjs --verbose      # show the top-3 pages for each failure
node scripts/eval.mjs --local        # against `wrangler dev`
node scripts/eval.test.mjs           # checks the scoring maths, no Worker needed
```

Both the deployed and `--local` runs need a populated `nesi-docs` index — Vectorize has no local emulation, so `wrangler dev` binds to the remote one.

The runner hits `/api/search`, so it costs no LLM tokens and is repeatable. `/api/search` returns unfiltered raw retrieval (no score floor applied), specifically so this sweep can test threshold values below the Worker's own `MIN_RERANK_SCORE` against real scores. It reports hit@k and MRR for retrieval, then scores the refusal decision the same way the Worker's *pre-LLM score gate* does (`results[0].rerankScore >= MIN_RERANK_SCORE`) and sweeps that threshold. Read the sweep as a trade-off, not a score: raising the threshold cuts false answers and adds false refusals. `MIN_RERANK_SCORE = 0.4` is the current production value — re-run the sweep after any retrieval or corpus change to check it still holds.

The metric that matters most is `grounded`: confident *and* holding a relevant chunk within `CONTEXT_K`. Cases that are confident with no relevant source are the hallucination-shaped failures.

**`false answers` is an upper bound, not an observed hallucination rate — don't quote it as one.** The score gate only decides whether to skip the LLM call as a cost optimisation; a case that passes it still reaches the LLM, which has its own instructed judgment (system prompt: "if the excerpts don't contain the answer, say so"). Verified directly against the real `ask_nesi_docs`/`/api/chat` pipeline: every hard-negative case that "false answers" here (PBS on a Slurm-only site, installing Windows Server on a compute node, a personal Gmail password reset, REANNZ's BGP policy, staff annual leave) was correctly refused end-to-end, each with a helpful redirect (contact support, or Google's own help for the Gmail case). If you want the true end-to-end rate, you'd need an eval mode that actually calls the LLM — costs tokens, not built here.

## Tuning knobs (src/worker.js)

`RETRIEVE_K` (20) — how wide the vector-search net is. `CONTEXT_K` (6) — how many reranked chunks the LLM sees; raise for multi-page questions, costs tokens. `MIN_RERANK_SCORE` (0.4) — the refusal threshold; raise it and the bot says "not in the docs" more often but hallucinates less. It also doubles as the floor below which a chunk is dropped from the sources shown to the user — except on `/api/search`, which returns unfiltered raw retrieval specifically so `scripts/eval.mjs` can sweep other threshold values against real scores. Note the fallback path at `worker.js:171`: if the reranker call fails, `rerankScore` becomes the raw cosine score, which sits above 0.4 for almost any query — so a reranker outage effectively disables the refusal gate, rather than refusing outright. Live-lookup hits (`src/liveData.mjs`) always carry `rerankScore: 1` by design — an exact name match clears this threshold regardless of where it's set, independent of the vector-search confidence question entirely. `CHAT_MODEL` — swap for `@cf/meta/llama-4-scout-17b-16e-instruct` (131k context) if you raise CONTEXT_K a lot, or point at Anthropic via AI Gateway for higher answer quality later.

## Files

`src/worker.js` — router, retrieval pipeline, chat SSE endpoint, MCP server. `src/liveData.mjs` — live exact-name lookup for module-list.json apps and glossary jargon, fetched from their public upstream repos and edge-cached. `src/appData.mjs` / `src/glossaryData.mjs` — pure rendering/parsing for that data (no `node:fs`, which is what makes them importable into the Workers runtime). `public/index.html` — chat UI (vanilla JS, streaming, citations). `scripts/chunker.mjs` — markdown-aware chunker for prose docs (frontmatter, splitting logic). `scripts/ingest.mjs` — chunk → embed → upsert. `scripts/ingest_local.sh` — thin wrapper around ingest.mjs, shared by CI and local testing. `.gitlab-ci.yml` — the ingest pipeline itself (`nesi-docs-rag` lives on GitLab). `scripts/eval.mjs` — retrieval + refusal eval. `scripts/eval.test.mjs` — tests the eval's scoring. `evals/questions.jsonl` — the eval cases. No npm dependencies anywhere in the repo.
