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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TARGET_CHARS = 2200;   // ~450 tokens
const MIN_CHARS = 400;       // merge sections smaller than this into neighbours
const MAX_CHARS = 3200;      // hard split above this
const OVERLAP_CHARS = 250;   // overlap when force-splitting long sections

const SKIP_DIRS = new Set(["assets"]);
const SKIP_FILES = new Set([
  "CONTRIBUTING.md", "FORMAT.md", "NEWPAGE.md", "MACROS.md", "tags.md", "updates.md",
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

/** docs/Batch_Computing/Slurm/foo.md -> https://docs.nesi.org.nz/Batch_Computing/Slurm/foo/ */
export function pathToUrl(relPath, siteUrl = "https://docs.nesi.org.nz/") {
  let p = relPath.replace(/\\/g, "/").replace(/\.md$/, "");
  if (p.endsWith("/index")) p = p.slice(0, -"index".length);
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

export function chunkFile(absPath, docsRoot, siteUrl) {
  const raw = readFileSync(absPath, "utf8");
  const relPath = relative(docsRoot, absPath);
  const { meta, body } = parseFrontmatter(raw);
  const cleaned = cleanMarkdown(body);
  if (cleaned.length < 80) return []; // stub/redirect pages
  const { title: h1, sections } = splitSections(cleaned);
  const title = h1 || relPath.split("/").pop().replace(/\.md$/, "").replace(/[-_]/g, " ");
  const breadcrumb = relPath.split("/").slice(0, -1).map((s) => s.replace(/_/g, " ")).join(" > ");
  const url = pathToUrl(relPath, siteUrl);

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
      id: `${relPath}#${i}`,
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

export function chunkRepo(docsRoot, siteUrl = "https://docs.nesi.org.nz/") {
  const chunks = [];
  for (const file of walkMarkdown(docsRoot)) chunks.push(...chunkFile(file, docsRoot, siteUrl));
  return chunks;
}

// CLI: node chunker.mjs /path/to/support-docs/docs [--stats]
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  const chunks = chunkRepo(root);
  const sizes = chunks.map((c) => c.text.length).sort((a, b) => a - b);
  console.log(JSON.stringify({
    chunks: chunks.length,
    files: new Set(chunks.map((c) => c.metadata.path)).size,
    charSizes: { min: sizes[0], median: sizes[Math.floor(sizes.length / 2)], p90: sizes[Math.floor(sizes.length * 0.9)], max: sizes[sizes.length - 1] },
  }, null, 2));
  console.log("\n--- sample chunk ---\n");
  const sample = chunks.find((c) => c.metadata.path.includes("Slurm") || c.metadata.section.includes("Batch"));
  console.log(JSON.stringify(sample, null, 2).slice(0, 1500));
}
