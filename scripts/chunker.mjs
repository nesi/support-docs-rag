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
import { join, relative } from "node:path";
import { loadModuleList, resolveAppMacros, resolveCrossAppRefs } from "./appData.mjs";
import { resolveGlossaryEntries } from "./glossaryData.mjs";

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

/** Strip mkdocs-material / jinja constructs that add noise to embeddings. */
function cleanMarkdown(text) {
  return text
    // The generic jinja-tag strip below deletes this include with nothing to
    // show for it — on pages where it's the whole point (e.g. Getting_Help.md,
    // whose one paragraph is entirely this include) that erases the page's
    // only content. Resolve it to what docs.nesi.org.nz actually renders
    // before the generic strip runs. Confirmed against the 80 files that use
    // it — one consistent, unparameterised call site.
    .replace(/\{%\s*include\s*"partials\/support_request\.html"\s*%\}/g, "Contact our Support Team (support@nesi.org.nz)")
    .replace(/\{\{[^}]*\}\}/g, "")               // jinja macros
    .replace(/\{%[^%]*%\}/g, "")                 // jinja tags
    .replace(/^\s*(!!!|\?\?\?\+?)\s+(\w+)(\s+"([^"]*)")?/gm, (_, __, kind, ___, title) =>
      `**${title || kind}:**`)                   // admonitions -> bold label
    .replace(/^(\s*)(=== ".*")\s*$/gm, "$1**$2**") // content tabs
    .replace(/<!--[\s\S]*?-->/g, "")
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

/** Split body into sections at ## and ### headings, keeping the h1 as title. */
function splitSections(body) {
  const lines = body.split("\n");
  let title = null;
  const sections = [];
  let current = { heading: null, level: 0, lines: [] };
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inCode = !inCode;
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
  return { title, sections: sections.map((s) => ({ ...s, text: s.lines.join("\n").trim() })).filter((s) => s.text || s.heading) };
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
 * The chunking logic proper, given already-cleaned body markdown (see
 * chunkFile: frontmatter parsed, app-data macros resolved, Jinja stripped).
 * `url` is used only for citations — the deployed site's URL for this path,
 * not where the content was read from.
 */
export function chunkBody(relPath, meta, cleaned, url) {
  if (cleaned.length < 80) return []; // stub/redirect pages
  const { title: h1, sections } = splitSections(cleaned);
  const title = h1 || relPath.split("/").pop().replace(/\.md$/, "").replace(/[-_]/g, " ");
  const breadcrumb = relPath.split("/").slice(0, -1).map((s) => s.replace(/_/g, " ")).join(" > ");

  // Greedily merge small adjacent sections; split big ones.
  const blocks = [];
  let buf = { headings: [], text: "" };
  const flush = () => { if (buf.text.trim().length >= MIN_CHARS || (buf.text.trim() && blocks.length === 0)) blocks.push(buf); else if (buf.text.trim() && blocks.length) { blocks[blocks.length - 1].text += "\n\n" + (buf.headings[0] ? `**${buf.headings[0]}**\n` : "") + buf.text; } buf = { headings: [], text: "" }; };
  for (const s of sections) {
    const sectionText = (s.heading ? `## ${s.heading}\n` : "") + s.text;
    if (buf.text.length + sectionText.length > TARGET_CHARS && buf.text) flush();
    if (s.heading) buf.headings.push(s.heading);
    buf.text += (buf.text ? "\n\n" : "") + sectionText;
    if (buf.text.length > MAX_CHARS) {
      const parts = splitLong(buf.text);
      for (const part of parts.slice(0, -1)) blocks.push({ headings: buf.headings, text: part });
      buf = { headings: buf.headings.slice(-1), text: parts[parts.length - 1] };
    }
  }
  flush();

  return blocks.map((b, i) => {
    const anchor = b.headings[0] ? `#${slugify(b.headings[0])}` : "";
    const context = [breadcrumb, title].filter(Boolean).join(" > ");
    const tagLine = meta.tags?.length ? `Tags: ${meta.tags.join(", ")}` : "";
    return {
      id: chunkId(relPath, i),
      text: b.text,
      embedText: [context, meta.description || "", tagLine, b.text].filter(Boolean).join("\n"),
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

// Cached per docsRoot so every file in a chunkRepo() run shares one parse of
// module-list.json rather than re-reading it per page.
const moduleListCache = new Map();
function moduleListFor(docsRoot) {
  if (!moduleListCache.has(docsRoot)) moduleListCache.set(docsRoot, loadModuleList(docsRoot));
  return moduleListCache.get(docsRoot);
}

// GLOSSARY.md's entries are atomic, unrelated jargon/acronym definitions —
// running them through chunkBody()'s MIN_CHARS merge would blur several
// unrelated terms into one embedding, the "blurry average" failure mode this
// chunker otherwise avoids. One chunk per surviving entry instead.
function chunkGlossary(relPath, entries, url) {
  return entries.map((e, i) => {
    const names = [e.term, ...e.aliases];
    const text = `## ${e.term}${e.aliases.length ? ` (also: ${e.aliases.join(", ")})` : ""}\n\n${e.definition}`;
    return {
      id: chunkId(relPath, i),
      text,
      embedText: `Glossary: ${names.join(", ")}\n${e.definition}`,
      metadata: {
        url: `${url}#${slugify(e.term)}`,
        title: "Glossary",
        section: relPath.split("/")[0].replace(/_/g, " "),
        path: relPath,
        heading: e.term,
        text: text.slice(0, 9000),
      },
    };
  });
}

/** Read the raw .md, resolve app-data macros and Jinja noise, chunk it. */
export function chunkFile(absPath, docsRoot, siteUrl) {
  const raw = readFileSync(absPath, "utf8");
  const relPath = relative(docsRoot, absPath);
  const { meta, body } = parseFrontmatter(raw);
  const moduleList = moduleListFor(docsRoot);

  if (relPath === "GLOSSARY.md") {
    const entries = resolveGlossaryEntries(docsRoot, moduleList);
    return chunkGlossary(relPath, entries, pathToUrl(relPath, siteUrl));
  }

  const resolved = resolveCrossAppRefs(resolveAppMacros(body, relPath, moduleList), moduleList);
  return chunkBody(relPath, meta, cleanMarkdown(resolved), pathToUrl(relPath, siteUrl));
}

/** Frontmatter only, for callers (ingest.mjs) that source the body elsewhere. */
export function readFrontmatter(absPath) {
  return parseFrontmatter(readFileSync(absPath, "utf8")).meta;
}

export const DEFAULT_SITE_URL = "https://docs.nesi.org.nz/";

export function chunkRepo(docsRoot, siteUrl = DEFAULT_SITE_URL) {
  const chunks = [];
  for (const file of walkMarkdown(docsRoot)) chunks.push(...chunkFile(file, docsRoot, siteUrl));
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
