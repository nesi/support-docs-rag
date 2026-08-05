/**
 * Markdown-aware chunker for the NeSI support-docs repo.
 *
 * WHY THIS MATTERS (RAG concept #1 — chunking):
 * An embedding model maps a piece of text to a vector. If chunks are too big,
 * the vector becomes a blurry average of many topics and retrieval gets vague.
 * Too small, and chunks lack the context needed to answer anything.
 * We split on headings (which in these docs mark real topic boundaries),
 * merge tiny sections, and split oversized ones — aiming for ~300-500 tokens.
 *
 * Each chunk gets:
 *  - `text`        what the LLM will read as context
 *  - `embedText`   breadcrumb + title + text — what we embed. Prepending
 *                  "Batch Computing > Slurm > Job priority" lets a chunk about
 *                  "priority scores" match queries like "why is my slurm job queued".
 *  - `metadata`    url, title, section — stored in Vectorize, used for citations.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const TARGET_CHARS = 2200;   // ~450 tokens
const MIN_CHARS = 400;       // merge sections smaller than this into neighbours
const MAX_CHARS = 3200;      // hard split above this
const OVERLAP_CHARS = 250;   // overlap when force-splitting long sections

// The per-version release-note stub pages here are almost entirely the
// support_request boilerplate (median 635 chars, one changelog bullet + a
// "contact support" link) — their embedding is a near-pure "contact support"
// signal, purer than Getting_Help.md itself, so they out-rank the real page
// for any support/help query. Named precisely (not a blanket "Release_Notes"
// skip): Announcements/Release_Notes and Interactive_Computing/OnDemand's
// Release_Notes are real, substantive content and must stay.
const SKIP_DIRS = new Set(["assets", "Release_Notes_my-nesi-org-nz", "Release_Notes_freezer-nesi-org-nz"]);
const SKIP_FILES = new Set([
  "CONTRIBUTING.md", "FORMAT.md", "NEWPAGE.md", "MACROS.md", "tags.md", "updates.md", "mermaid-test.md",
]);

export function* walkMarkdown(root) {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walkMarkdown(p);
    } else if (entry.endsWith(".md") && !SKIP_FILES.has(entry)) {
      yield p;
    }
  }
}

/** Very small frontmatter parser — enough for this repo's simple YAML. */
export function parseFrontmatter(raw) {
  const meta = {};
  if (!raw.startsWith("---")) return { meta, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta, body: raw };
  const header = raw.slice(3, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);
  const descMatch = header.match(/^description:\s*(.+)$/m);
  if (descMatch) meta.description = descMatch[1].replace(/^['"]|['"]$/g, "").trim();
  const tagsBlock = header.match(/^tags:\n((?:\s+-\s*.+\n?)+)/m);
  if (tagsBlock) meta.tags = [...tagsBlock[1].matchAll(/-\s*(.+)/g)].map((m) => m[1].trim());
  return { meta, body };
}

// mkdocs-macros renders `{{ app.default }}` etc. into the real version string
// at docs.nesi.org.nz build time (see support-docs/macro_hooks.py) -- but we
// chunk the raw .md source, so left alone these are dead template syntax.
// Blindly deleting them (the old behaviour) silently turns e.g.
// `module load GROMACS/{{app.default}}` into `module load GROMACS/` in what
// the LLM is told is a documentation excerpt -- exactly the kind of broken
// grounding that invites it to fabricate the missing version instead of
// admitting it doesn't have one. Resolving these with the same data source
// mkdocs-macros itself uses (module-list.json + mkdocs.yml's `extra:` block,
// both already in the support-docs repo) fixes that at the source instead
// of relying on a runtime guardrail to catch it after the fact.
//
// Deliberately a small expression evaluator, not a full Jinja implementation
// -- covers exactly the subset actually used in this repo: dotted/bracket
// attribute access on a few root variables, plus `| last` and `| join(...)`.
// Anything outside that (a real corpus scan turned up nothing else) falls
// through to a visible `[template:...]` token below rather than vanishing.
const JINJA_ACCESS_RE = /^\.(\w+)|^\[(?:"([^"]*)"|'([^']*)')\]|^\[(\d+)\]/;
const JINJA_FILTER_RE = /^\s*\|\s*(\w+)(?:\(\s*(?:"([^"]*)"|'([^']*)')?\s*\))?/;

/** Repeatedly match `re` at the start of `s`, mapping each match through `extract`,
 *  until it stops matching. Shared shape behind both the access-chain and filter-chain
 *  loops in parseJinjaExpr -- same "match, extract, advance past it, repeat" idiom, only
 *  the regex and what's extracted differ. */
function consumeMatches(s, re, extract) {
  const items = [];
  let m;
  while ((m = s.match(re))) {
    items.push(extract(m));
    s = s.slice(m[0].length);
  }
  return { items, rest: s };
}

function parseJinjaExpr(expr) {
  let s = expr.trim();
  const rootMatch = s.match(/^(\w+)/);
  if (!rootMatch) return null;
  const root = rootMatch[1];
  s = s.slice(root.length);

  const access = consumeMatches(s, JINJA_ACCESS_RE, (m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
  const filters = consumeMatches(access.rest, JINJA_FILTER_RE, (m) => ({ name: m[1], arg: m[2] ?? m[3] ?? "" }));

  return filters.rest.trim() ? null : { root, path: access.items, filters: filters.items }; // leftover tail -> unparseable, bail to the token fallback
}

function applyJinjaFilters(value, filters) {
  for (const { name, arg } of filters) {
    if (name === "last" && Array.isArray(value)) value = value[value.length - 1];
    else if (name === "join" && Array.isArray(value)) value = value.join(arg);
    else return undefined; // unknown filter -- don't guess
  }
  return value;
}

/** `moduleList`/`extra` come from loadJinjaContext(); `app` is this page's own app record, if any. */
function resolveJinjaExpr(expr, { app, description, moduleList, extra }) {
  // "config.extra.X" and "extra.X" are the same data, just spelled two ways in this
  // corpus (mkdocs-macros exposes the `extra:` block under both names) -- normalizing
  // the prefix here means only one root branch below needs to know about it.
  const parsed = parseJinjaExpr(expr.replace(/^config\.extra\b/, "extra"));
  if (!parsed) return null;
  let { root, path, filters } = parsed;

  let value;
  if (root === "app") value = app;
  else if (root === "applications") { value = moduleList.get(path[0]); path = path.slice(1); }
  else if (root === "description") value = description; // this page's own frontmatter
  else if (root === "extra") value = extra;
  else if (Object.prototype.hasOwnProperty.call(extra, root)) value = extra[root]; // bare top-level `extra:` keys
  else return null;

  for (const key of path) {
    if (value == null) return null;
    value = value[key];
  }
  value = applyJinjaFilters(value, filters);
  return value != null && typeof value !== "object" ? String(value) : null;
}

function resolveJinjaVars(text, ctx) {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const resolved = resolveJinjaExpr(expr, ctx);
    return resolved ?? `[template:${expr}]`; // visible marker, never silent deletion
  });
}

/** Case-insensitive-by-key lookup, matching support-docs' own CaseInsensitiveDict (macro_hooks.py). */
function buildModuleIndex(moduleListObj) {
  const byLower = new Map(Object.entries(moduleListObj).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => (name ? byLower.get(name.toLowerCase()) : undefined) };
}

/** Just the flat scalar/array/string values under mkdocs.yml's `extra:` block -- not a general YAML parser. */
function parseMkdocsExtra(yamlText) {
  const lines = yamlText.split("\n");
  const start = lines.findIndex((l) => /^extra:\s*$/.test(l));
  if (start === -1) return {};
  const extra = {};
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // dedented back to top level -- extra: block ended
    const m = lines[i].match(/^ {2}([\w-]+):\s*(.*)$/);
    if (!m || !m[2]) continue; // no match, or a nested block (e.g. analytics:) -- not needed here
    extra[m[1]] = m[2].startsWith("[") ? JSON.parse(m[2]) : m[2].replace(/^["']|["']$/g, "");
  }
  return extra;
}

/** Loaded once per ingest run and threaded through chunkFile(); missing files degrade to token-fallback, not a crash. */
export function loadJinjaContext(docsRoot) {
  let moduleList = {}, extra = {};
  try { moduleList = JSON.parse(readFileSync(join(docsRoot, "assets/module-list.json"), "utf8")); } catch { /* fall back to unresolved */ }
  try { extra = parseMkdocsExtra(readFileSync(join(docsRoot, "..", "mkdocs.yml"), "utf8")); } catch { /* fall back to unresolved */ }
  return { moduleList: buildModuleIndex(moduleList), extra };
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|bmp|webp)$/i;

/** Basename of a (possibly relative) path, extension stripped. */
function basenameNoExt(src) {
  return basename(src.split(/[?#]/)[0]).replace(IMAGE_EXT_RE, "");
}

// Half the images in this repo have alt text auto-derived from the filename
// (e.g. "Globus_Transfer_1.png") -- pure noise for embedding/LLM context, worse
// than saying nothing. Only alt text that reads as actual prose is worth a
// literal "Image: ..." line; everything else is dropped rather than kept as
// "Image: Globus_Transfer_1.png"-style filler.
function isNoiseAlt(alt, src) {
  const trimmed = alt.trim();
  if (!trimmed) return true;
  if (IMAGE_EXT_RE.test(trimmed)) return true; // alt is literally "foo.png"
  if (trimmed.replace(IMAGE_EXT_RE, "").toLowerCase() === basenameNoExt(src).toLowerCase()) return true;
  if (/^[\w-]+_\d+$/.test(trimmed)) return true; // "Globus_Transfer_1"-style auto-numbered names
  if (/^(screenshot|image|diagram)$/i.test(trimmed)) return true;
  return false;
}

function cleanMarkdown(text) {
  return text
    .replace(/\{%\s*include\s*"partials\/support_request\.html"\s*%\}/g, "Contact our Support Team (support@nesi.org.nz)")
    .replace(/\{%[^%]*%\}/g, "")                 // jinja tags
    // Admonitions (!!!/???) and content tabs (=== "Label") are NOT handled
    // here anymore -- splitSections()/splitBlocksWithinSection() parse them
    // as structured blocks (kind, title, body) so they can be kept intact
    // across chunk boundaries and content tabs can be split into their own
    // per-platform pseudo-sections. A blind line-rewrite here would destroy
    // that structure before the real parser ever sees it.
    .replace(/<!--[\s\S]*?-->/g, "")
    // raw HTML <img alt="..." src="..."> tags (rare, but the few in this repo have
    // genuinely hand-written alt text worth keeping) -- attribute order varies, so
    // just pull out `alt` and discard the rest of the tag.
    .replace(/<img\b[^>]*\balt=(["'])(.*?)\1[^>]*>/gi, (_, __, alt) => (alt.trim() ? `Image: ${alt.trim()}` : ""))
    // markdown image syntax, with mkdocs' optional trailing `{ width=... }` attr list
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(?:\{[^}]*\})?/g, (_, alt, src) =>
      isNoiseAlt(alt, src) ? "" : `Image: ${alt.trim()}`)
    .replace(/[ \t]+$/gm, "")                    // trailing whitespace left by dropped images
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugify(heading) {
  return heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

// Vectorize rejects ids over 64 bytes, and 91 of the 306 doc paths are longer
// than that on their own (the release-note directories are the worst). Ids must
// stay stable so re-ingest overwrites in place, so long paths get a hash of the
// full path plus a readable tail rather than a counter.
const MAX_ID_BYTES = 64;
const ID_SUFFIX_BYTES = 4; // "#123" — budgeted for every chunk so all chunks of
                           // a page use the same scheme regardless of count
const ID_HASH_CHARS = 12;

/** Deterministic, <=64 bytes, readable whenever the path is short enough. */
export function chunkId(relPath, i) {
  const base = relPath.replace(/\.md$/, "");
  if (Buffer.byteLength(base) + ID_SUFFIX_BYTES <= MAX_ID_BYTES) return `${base}#${i}`;

  const hash = createHash("sha256").update(relPath).digest("hex").slice(0, ID_HASH_CHARS);
  const room = MAX_ID_BYTES - ID_SUFFIX_BYTES - ID_HASH_CHARS - 1; // 1 for the "-"
  // Keep the tail: the filename carries more signal than the directory prefix.
  let tail = base.slice(-room);
  while (Buffer.byteLength(tail) > room) tail = tail.slice(1); // multi-byte safety
  return `${hash}-${tail}#${i}`;
}

/** docs/Batch_Computing/Slurm/foo.md -> https://docs.nesi.org.nz/Batch_Computing/Slurm/foo/ */
export function pathToUrl(relPath, siteUrl = "https://docs.nesi.org.nz/") {
  let p = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
  // Nested index files (e.g. Software/Available_Applications/index.md) drop
  // just the "index" segment. The top-level docs/index.md is "index" with no
  // leading slash, so the same suffix check missed it — it kept resolving to
  // .../index/ instead of the site root, which 404s.
  if (p === "index" || p.endsWith("/index")) p = p.slice(0, p.length - "index".length);
  if (p.endsWith("/")) p = p.slice(0, -1); // avoid a double "//" once the trailing slash is re-added below
  return siteUrl + (p ? p + "/" : "");
}

/** Every line-scanner in this file that must ignore markdown syntax inside a fenced code
 *  block tests this same pattern to toggle its own `inCode` state -- named here so the
 *  three call sites share one definition instead of three copies of the same regex literal. */
const FENCE_RE = /^\s*```/;

/** First H1 outside a fenced code block, or null. A plain line-start regex would also
 *  match a `# comment` inside a bash example -- easy to hit given how many of these
 *  pages are Slurm/shell examples. */
function findH1(body) {
  let inCode = false;
  for (const line of body.split("\n")) {
    if (FENCE_RE.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

// MkDocs Material admonitions (`!!! kind "title"`) and content tabs
// (`=== "Label"`) both use the same shape: an opening marker line, then a
// body indented 4+ spaces relative to it, ending at the first line that
// returns to the marker's own indentation (or EOF). Parsed as structured
// blocks -- not just a label rewrite -- so a block's body can be kept
// intact across chunk boundaries (never severed mid-warning) and so each
// tab in a group can become its own pseudo-section instead of all tab
// bodies being concatenated into one.
const ADMONITION_RE = /^(\s*)(!!!|\?\?\?\+?)\s+(\w+)(?:\s+"([^"]*)")?\s*$/;
const TAB_RE = /^(\s*)=== "([^"]*)"\s*$/;

function leadingSpaces(line) {
  return line.match(/^ */)[0].length;
}

/** Remove up to `n` leading spaces -- never over-strips a shorter line. */
function dedent(line, n) {
  let i = 0;
  while (i < n && line[i] === " ") i++;
  return line.slice(i);
}

/** Lines belonging to a block opened at `indent`: blank, or indented further than it.
 *  Trailing blank lines are trimmed off (they separate the block from what follows,
 *  not part of its content) and the body is dedented by `indent + 4`. */
function collectIndentedBody(lines, startIdx, indent) {
  let end = startIdx;
  while (end < lines.length && (lines[end].trim() === "" || leadingSpaces(lines[end]) > indent)) end++;
  let bodyEnd = end;
  while (bodyEnd > startIdx && lines[bodyEnd - 1].trim() === "") bodyEnd--;
  return { body: lines.slice(startIdx, bodyEnd).map((l) => dedent(l, indent + 4)), nextIdx: end };
}

/** First ~150 chars of an admonition's body (the label already stripped), for the embedText hoist. */
function admonitionExcerpt(body, maxLen = 150) {
  return body.length > maxLen ? body.slice(0, maxLen).trim() + "…" : body;
}

/**
 * Within one heading-delimited group of lines, split out admonition and
 * content-tab blocks as their own atomic pieces. Usually returns exactly
 * one piece (plain text, no admonitions/tabs present) -- matching today's
 * behaviour for the common case exactly. `emitHeadingText` controls whether
 * chunkBody prepends "## heading" text: true for whichever piece comes
 * first (so a section's heading still appears exactly once, whatever kind
 * of content opens it) and always true for tabs (each needs its own
 * distinguishing heading); false for anything else, so continuation
 * pieces don't repeat the parent heading inline.
 */
function splitBlocksWithinSection(lines, parentHeading) {
  const pieces = [];
  let isFirstPiece = true;
  const pushPiece = (piece) => { pieces.push({ ...piece, emitHeadingText: isFirstPiece }); isFirstPiece = false; };

  let textRun = [];
  const flushText = () => {
    const text = textRun.join("\n").trim();
    if (text) pushPiece({ heading: parentHeading, text, atomic: false });
    textRun = [];
  };

  let inCode = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inCode = !inCode; textRun.push(line); i++; continue; }

    const admonition = !inCode && line.match(ADMONITION_RE);
    if (admonition) {
      flushText();
      const indent = admonition[1].length;
      const rawKind = admonition[3];
      const { body, nextIdx } = collectIndentedBody(lines, i + 1, indent);
      const bodyText = body.join("\n").trim();
      const label = admonition[4] || rawKind;
      pushPiece({
        heading: parentHeading,
        text: `**${label}:**` + (bodyText ? "\n" + bodyText : ""),
        body: bodyText,
        atomic: true,
        admonitionKind: rawKind.toLowerCase(),
      });
      i = nextIdx;
      continue;
    }

    const tab = !inCode && line.match(TAB_RE);
    if (tab) {
      flushText();
      const indent = tab[1].length;
      while (i < lines.length) {
        const t = lines[i].match(TAB_RE);
        if (!t || t[1].length !== indent) break;
        const { body, nextIdx } = collectIndentedBody(lines, i + 1, indent);
        const bodyText = body.join("\n").trim();
        if (bodyText) pushPiece({ heading: parentHeading ? `${parentHeading} — ${t[2]}` : t[2], text: bodyText, atomic: true, isTab: true });
        i = nextIdx;
      }
      continue;
    }

    textRun.push(line);
    i++;
  }
  flushText();
  return pieces;
}

/** Split body into sections at ## and ### headings, keeping the h1 as title. */
function splitSections(body) {
  const lines = body.split("\n");
  let title = null;
  const sections = [];
  let current = { heading: null, level: 0, lines: [] };
  let inCode = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) inCode = !inCode;
    const h = !inCode && line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1 && !title) { title = text; continue; }
      sections.push(current);
      current = { heading: text, level, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  // Each heading-delimited group can itself contain admonitions/tabs -- split
  // those out into their own atomic pieces before returning. Usually one
  // piece per group in, one piece out (no admonitions/tabs present).
  const pieces = sections.flatMap((s) => splitBlocksWithinSection(s.lines, s.heading));
  return { title, sections: pieces.filter((s) => s.text || s.heading) };
}

/** Split an oversized block on paragraph boundaries with overlap. */
function splitLong(text) {
  const parts = [];
  const paras = text.split(/\n\n+/);
  let buf = "";
  for (const para of paras) {
    if (buf.length + para.length > MAX_CHARS && buf) {
      parts.push(buf.trim());
      buf = buf.slice(-OVERLAP_CHARS) + "\n\n";
    }
    buf += para + "\n\n";
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/**
 * Force-split an overflowing buffer without splitting inside any piece (an
 * admonition/tab block, or any plain section): pieces are packed whole, and
 * only a single piece that's individually over MAX_CHARS falls back to
 * splitLong() on just that piece's own text, isolated from its neighbours.
 * Degenerates to splitLong()-or-passthrough for a single-piece input, so it
 * also covers the tab-isolation call site below -- one mechanism, not two.
 */
function splitPiecesRespectingAtomicity(texts) {
  const parts = [];
  let current = [];
  let currentLen = 0;
  const flushCurrent = () => { if (current.length) parts.push(current.join("\n\n")); current = []; currentLen = 0; };
  for (const text of texts) {
    if (text.length > MAX_CHARS) {
      flushCurrent();
      parts.push(...splitLong(text));
      continue;
    }
    if (current.length && currentLen + 2 + text.length > MAX_CHARS) flushCurrent();
    currentLen += (current.length ? 2 : 0) + text.length;
    current.push(text);
  }
  flushCurrent();
  return parts;
}

/**
 * The chunking logic proper, given already-cleaned body markdown (see
 * chunkFile: frontmatter parsed, app-data macros resolved, Jinja stripped).
 * `url` is used only for citations — the deployed site's URL for this path,
 * not where the content was read from.
 */
export function chunkBody(relPath, meta, cleaned, url) {
  if (cleaned.length < 80) return []; // stub/redirect pages
  const { title: h1, sections } = splitSections(cleaned);
  const title = h1 || filenameTitle(relPath);
  const breadcrumb = relPath.split("/").slice(0, -1).map((s) => s.replace(/_/g, " ")).join(" > ");

  // Greedily merge small adjacent sections; split big ones. `buf.texts` tracks
  // each section's rendered text alongside `buf.text` (the same strings, just
  // not yet joined) and `buf.hasAtomic` records whether any of them is an
  // admonition/tab block -- together, just enough for the MAX_CHARS branch
  // below to pick the atomicity-respecting split over the plain flat-string
  // one when it actually needs to force-split.
  const blocks = [];
  let buf = { headings: [], text: "", texts: [], hasAtomic: false };
  const flush = () => { if (buf.text.trim().length >= MIN_CHARS || (buf.text.trim() && blocks.length === 0)) blocks.push({ headings: buf.headings, text: buf.text }); else if (buf.text.trim() && blocks.length) { blocks[blocks.length - 1].text += "\n\n" + (buf.headings[0] ? `**${buf.headings[0]}**\n` : "") + buf.text; } buf = { headings: [], text: "", texts: [], hasAtomic: false }; };
  for (const s of sections) {
    // A tab is never merged with its sibling tabs, or with anything else --
    // not just "not severed" but fully isolated, since the whole point is a
    // query about one platform matching a chunk that's purely about that
    // platform. Bypasses the buf/flush accumulator entirely: flush whatever
    // came before (that content is unrelated to the tab), push this tab as
    // its own block directly, leave buf empty for whatever comes after.
    if (s.isTab) {
      flush();
      const tabText = `## ${s.heading}\n${s.text}`;
      for (const part of splitPiecesRespectingAtomicity([tabText])) blocks.push({ headings: [s.heading], text: part });
      continue;
    }

    const sectionText = (s.heading && s.emitHeadingText !== false ? `## ${s.heading}\n` : "") + s.text;
    if (buf.text.length + sectionText.length > TARGET_CHARS && buf.text) flush();
    if (s.heading) buf.headings.push(s.heading);
    buf.text += (buf.text ? "\n\n" : "") + sectionText;
    buf.texts.push(sectionText);
    if (s.atomic) buf.hasAtomic = true;
    if (buf.text.length > MAX_CHARS) {
      // A block alone exceeding MAX_CHARS is an explicit edge case, not a
      // crash risk: splitPiecesRespectingAtomicity() falls back to the same
      // paragraph-boundary splitLong() for that one oversized piece, same
      // mechanism as always, just scoped so it can't bleed into a neighbour.
      const parts = buf.hasAtomic ? splitPiecesRespectingAtomicity(buf.texts) : splitLong(buf.text);
      for (const part of parts.slice(0, -1)) blocks.push({ headings: buf.headings, text: part });
      const lastText = parts[parts.length - 1];
      buf = { headings: buf.headings.slice(-1), text: lastText, texts: [lastText], hasAtomic: false };
    }
  }
  flush();

  // Requirement #2's atomicity guarantee (a piece is never severed except
  // by its own oversized-alone case) means an admonition's exact rendered
  // text always ends up wholly within exactly one block -- so a plain
  // substring check reliably finds which block(s) it landed in, no need to
  // thread a `warnings` accumulator through the flush/force-split logic above.
  const warningPieces = sections.filter((s) => s.admonitionKind === "warning" || s.admonitionKind === "danger");

  return blocks.map((b, i) => {
    const anchor = b.headings[0] ? `#${slugify(b.headings[0])}` : "";
    const context = [breadcrumb, title].filter(Boolean).join(" > ");
    const tagLine = meta.tags?.length ? `Tags: ${meta.tags.join(", ")}` : "";
    const warningLines = warningPieces
      .filter((s) => b.text.includes(s.text))
      .map((s) => `${s.admonitionKind === "danger" ? "Danger" : "Warning"}: ${admonitionExcerpt(s.body)}`)
      .join("\n");
    return {
      id: chunkId(relPath, i),
      text: b.text,
      embedText: [context, meta.description || "", tagLine, warningLines, b.text].filter(Boolean).join("\n"),
      metadata: {
        url: url + anchor,
        title,
        section: relPath.split("/")[0].replace(/_/g, " "),
        path: relPath,
        heading: b.headings[0] || title,
        text: b.text.slice(0, 9000), // Vectorize metadata limit ~10KiB per vector
      },
    };
  });
}

/** "Batch_Computing/Slurm_Reference-Sheet.md" -> "Slurm Reference Sheet". Fallback title
 *  when a page has no H1, shared by chunkBody (citations) and guessPageTitle (app lookup). */
function filenameTitle(relPath) {
  return relPath.split("/").pop().replace(/\.md$/, "").replace(/[-_]/g, " ");
}

// mkdocs-macros resolves `applications[app_name]` via the page's own title
// (support-docs/macro_hooks.py: `app_name = page.title | trim`). We don't
// run a full markdown/mkdocs pipeline here, so this is a best-effort guess
// at the same value -- good enough for a `{{app.*}}` lookup (worst case,
// it resolves to nothing and falls through to the token fallback, same as
// today's baseline). Mirrors chunkBody's own h1-or-filename title fallback.
function guessPageTitle(relPath, body) {
  return findH1(body) ?? filenameTitle(relPath);
}

// module-list.json/GLOSSARY.md content is never embedded as its own source
// (src/liveData.mjs looks both up live, by exact name, at query time
// instead -- see CLAUDE.md); the only use of module-list.json here is
// resolving `{{app.*}}`/`{{applications...}}` template expressions in-place
// so the surrounding prose reads correctly, not indexing it separately.
export function chunkFile(absPath, docsRoot, siteUrl, jinjaCtx) {
  const raw = readFileSync(absPath, "utf8");
  const relPath = relative(docsRoot, absPath);
  const { meta, body } = parseFrontmatter(raw);
  // Most pages have no `{{...}}` at all -- skip the H1 scan (guessPageTitle)
  // and the resolver pass entirely rather than paying for both on every file.
  const hasTemplateVars = jinjaCtx && body.includes("{{");
  const app = hasTemplateVars ? jinjaCtx.moduleList.get(guessPageTitle(relPath, body)) : undefined;
  const resolved = hasTemplateVars ? resolveJinjaVars(body, { app, description: meta.description, ...jinjaCtx }) : body;
  return chunkBody(relPath, meta, cleanMarkdown(resolved), pathToUrl(relPath, siteUrl));
}

/** Frontmatter only, for callers (ingest.mjs) that source the body elsewhere. */
export function readFrontmatter(absPath) {
  return parseFrontmatter(readFileSync(absPath, "utf8")).meta;
}

export const DEFAULT_SITE_URL = "https://docs.nesi.org.nz/";

export function chunkRepo(docsRoot, siteUrl = DEFAULT_SITE_URL) {
  const jinjaCtx = loadJinjaContext(docsRoot);
  const chunks = [];
  for (const file of walkMarkdown(docsRoot)) chunks.push(...chunkFile(file, docsRoot, siteUrl, jinjaCtx));
  return chunks;
}

// CLI: node chunker.mjs /path/to/support-docs/docs [--stats]
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  const chunks = chunkRepo(root);
  const sizes = chunks.map((c) => c.text.length).sort((a, b) => a - b);
  const idBytes = chunks.map((c) => Buffer.byteLength(c.id));
  console.log(JSON.stringify({
    chunks: chunks.length,
    files: new Set(chunks.map((c) => c.metadata.path)).size,
    charSizes: { min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], p90: sizes[Math.floor(sizes.length * 0.9)], max: sizes[sizes.length - 1] },
    // Vectorize rejects the whole batch if any id exceeds 64 bytes.
    ids: { unique: new Set(chunks.map((c) => c.id)).size, maxBytes: Math.max(...idBytes), overLimit: idBytes.filter((n) => n > MAX_ID_BYTES).length },
  }, null, 2));
  console.log("\n--- sample chunk ---\n");
  const sample = chunks.find((c) => c.metadata.path.includes("Slurm") || c.metadata.section.includes("Batch"));
  console.log(JSON.stringify(sample, null, 2).slice(0, 1500));
}
