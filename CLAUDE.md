# CLAUDE.md

Retrieval-augmented assistant for [docs.nesi.org.nz](https://docs.nesi.org.nz), built entirely on Cloudflare. One Worker serves a chat UI (humans), an MCP server (AI agents), and a raw search API. Answers are grounded in the NeSI HPC/storage docs with inline citations; refuses when the docs don't cover a question instead of guessing.

## Architecture

Single Cloudflare Worker (`src/worker.js`), no npm dependencies, no build step. Routes:

- `POST /api/chat` — SSE stream: `sources` event, then `token` events, then `done`. Folds recent history into the retrieval query for follow-ups. `break` events between `token`s split the answer into separate chat bubbles (short answer / code block / "More:" docs link), inserted at those fixed points by `src/breaks.mjs`, not by the model. Clients that don't know `break` ignore it and show one bubble. Both clients handle it: `public/index.html` and the docs-site widget (`support-docs` `docs/assets/javascripts/chat.js`, which also stores `parts` in history to restore the bubbles).
- `POST /api/search` — JSON ranked chunks (raw retrieval, no LLM).
- `ALL /mcp` — stateless MCP server (JSON-RPC 2.0 over streamable HTTP). Tools: `search_nesi_docs`, `ask_nesi_docs`, `read_nesi_doc`.
- `GET /*` — falls through to static chat UI (`public/index.html`) via the `ASSETS` binding.

**Shortcuts** (`shortcutReply()` in worker.js, called from `handleChat` and `ask_nesi_docs`, not `/api/search`): canned replies before any embed/search/rerank/LLM call, in this order:
1. **Secrets** (`containsSecret()` in `src/junk.mjs`): pasted private keys/tokens (exact formats only). Never overridden, and `handleChat` also drops history turns containing one, since the client replays history every turn.
2. **Status** (`src/statusShortcut.mjs`): whole-message "is Mahuika down?"/"any outages?" answered from the raw Statuspage summary (`fetchStatusSummary()`), components matched by keyword against live component *names*. "why is X not working" only short-circuits when something matching is actually degraded; otherwise it falls through to docs troubleshooting. Replies are one short line per affected component + link, never incident bodies (same rule as `relevantStatusQuote()`), and unlinked incidents are only attributed by name.
3. **Junk** (`classifyJunk()` in `src/junk.mjs`): greeting/thanks/test/gibberish, asking for a human, questions about the bot itself, and whole-message abuse. A live-lookup hit overrides it.
4. **Repeats** (`isRepeatQuestion()` in `src/junk.mjs`, chat only): an exact (normalised) repeat of the user's previous message gets "that didn't help, what's the command/error?" plus the Contacting Support link instead of re-running the same retrieval. Checked last, so a repeated status question still re-checks live status.

Every pattern is anchored to the whole message (so "test job", "why the hell is my job pending" and "Is Mahuika down? I get connection refused" all reach retrieval), and there's no length rule (so "R"/"git" pass). False positives are the costly mistake, so `scripts/eval-junk.test.mjs` and `scripts/eval-status.test.mjs` are mostly near-miss real questions that must get through.

Five-stage retrieval (`retrieve()` in worker.js):
1. **Live lookup** — module-list.json apps (~861) and glossary jargon (~20 terms) matched by exact, case-sensitive, whole-word name against the question (`src/liveData.mjs`). These are structured, name-keyed records, not prose, so they're looked up directly instead of pre-embedded into Vectorize — cheaper and exactly precise for any question naming a known app/term. Data fetched live from the public upstream repos (`nesi/modules-list`, `nesi/nesi-wordlist`), edge-cached (`caches.default`, 1h). Hits get `rerankScore: 1`, so they always clear `MIN_RERANK_SCORE` and sort first.
2. **Embed** question — `@cf/baai/bge-m3` (1024 dims).
3. **Vector search** — Vectorize index `nesi-docs`, wide net `RETRIEVE_K=20`.
4. **Rerank** — cross-encoder `@cf/baai/bge-reranker-base`, keep top `CONTEXT_K=6`. Reads query+chunk together; biggest quality win. Falls back to vector order if rerank fails.
5. **Grounded answer** — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` under a strict system prompt (answer only from excerpts, cite `[n]`, refuse below `MIN_RERANK_SCORE=0.2`).

Ingest pipeline (offline, `scripts/`), reading only the local `support-docs` checkout — no dependency on a deployed site. Only prose docs are embedded; module-list.json/glossary content is never ingested at all, only looked up live (see above):
- `chunker.mjs` — markdown-aware. Splits on `##`/`###` headings, merges sections `< MIN_CHARS=400`, splits `> MAX_CHARS=3200`, targets `TARGET_CHARS=2200` (~450 tokens). `embedText` prepends breadcrumb + frontmatter description + tags so chunks carry context into vector space. Stable ids `path#chunkIndex`, or `sha256(path)[0:12]-<tail>#chunkIndex` when the path pushes the id past Vectorize's 64-byte limit (`chunkId()`). Ids must stay deterministic — that's what makes re-ingest overwrite in place. `Software/Available_Applications/*` pages' `applications[...]` macros are left for the generic Jinja strip to drop — live lookup covers that data instead, not reconstructed per page. Also honours MkDocs Material's own `search:` frontmatter convention, already hand-curated across ~70 support-docs pages for the site's own search: `search: exclude: true` drops the page from ingest entirely (`chunkFile` returns `[]`); `search: boost: N` is carried onto each chunk's metadata as `boost` and applied in `worker.js`'s `retrieve()` (see below) rather than at ingest time, since it's a query-time ranking adjustment, not a property of the chunk itself.
- `ingest.mjs` — chunks every file under the given docs root, batches by an estimated token budget (not a fixed count — Workers AI's context cap is a sum across the whole embed batch) with a reactive halving retry as the real safety net, upserts NDJSON to Vectorize. Re-runnable: stable ids overwrite in place. `--dry-run` runs the full chunk pass without calling Cloudflare.

`src/appData.mjs` / `src/glossaryData.mjs` — pure rendering/parsing for module-list.json apps and glossary jargon, no `node:fs`. Live in `src/`, not `scripts/`, because only `src/liveData.mjs` uses them — nothing in the offline ingest pipeline touches module-list.json/glossary data anymore.

## Commands

No package.json — use `npx wrangler` (or a global install).

```bash
# Deploy the Worker
npx wrangler deploy

# Create the vector index (first time only)
npx wrangler vectorize create nesi-docs --dimensions=1024 --metric=cosine

# Index the docs. Account API token needs: Workers AI Read + Workers AI Edit
# (the /ai/run REST endpoint requires both) and Vectorize Edit (upsert is a write).
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
node scripts/ingest.mjs /path/to/support-docs/docs [--index nesi-docs] [--dry-run] [--full] [--allow-mass-delete]

# Inspect chunking without embedding
node scripts/chunker.mjs /path/to/support-docs/docs --stats

# Local dev
npx wrangler dev
```

Stale vectors are deleted on each ingest, so a clean rebuild (`vectorize delete` → `vectorize create` → re-ingest) is only needed for index-level changes (dimensions, metric).

## Config & tuning

- **Bindings** (`wrangler.jsonc`): `AI` (Workers AI), `VECTORIZE` (index `nesi-docs`), `ASSETS` (`./public`).
- **Tuning knobs** (constants top of `worker.js`): `RETRIEVE_K`, `CONTEXT_K`, `MIN_RERANK_SCORE` (refusal threshold — raise to hallucinate less, refuse more), `CHAT_MODEL`.
- **Per-page relevance override**: a chunk's `metadata.boost` (from `search: boost: N` frontmatter, see chunker.mjs above) scales its `rerankScore` in `retrieve()` by `sqrt(boost)` — sqrt rather than a straight multiply so a hand-tuned outlier (`boost: 10`, `boost: 0.01`) can't single-handedly swing a chunk across `MIN_RERANK_SCORE`. Missing `boost` defaults to 1 (no-op).
- **Auth**: two modes. Preferred — put Worker behind Cloudflare Access, leave `API_KEY` unset. Alternative — `wrangler secret put API_KEY`, then clients send `Authorization: Bearer <key>`. `checkAuth()` returns true when `API_KEY` unset.

## Conventions

- Model IDs are `@cf/...` string constants — change in one place at the top of the relevant file.
- `read_nesi_doc` validates path against `/^[\w\-/.]+\.md$/` and blocks `..` — keep this on any path→fetch change (fetches raw from GitHub `nesi/support-docs`).
- Vectorize metadata `text` capped at 9000 chars (~10KiB per-vector limit).
- Chunk `embedText` (what's embedded) differs from `text` (what the LLM reads) — preserve that split.
