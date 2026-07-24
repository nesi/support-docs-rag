/**
 * Extracts the real content of a rendered docs.nesi.org.nz page and converts
 * it back to markdown.
 *
 * Why: several pages' bodies are built from mkdocs-macros Jinja includes
 * (module version tables, a support-contact link) that don't exist in the
 * raw .md source — they're resolved at site-build time from data outside
 * docs/. The rendered HTML has already done that resolution, so pulling
 * content from there instead of the raw markdown sidesteps the problem
 * entirely rather than special-casing each include.
 *
 * Frontmatter (description, tags) still comes from the raw .md — the
 * rendered page doesn't expose those in a form worth trusting over the
 * source of truth.
 */

import * as cheerio from "cheerio";
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

/**
 * mkdocs-material wraps every page's content in this container; verified
 * against docs.nesi.org.nz across pages with tables, tabs, admonitions, and
 * code blocks. If a future theme change moves this, extraction should fail
 * loudly (empty/near-empty output) rather than silently return chrome.
 */
const CONTENT_SELECTOR = "article.md-content__inner";

function flattenTable($, table) {
  const rows = [];
  table.find("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td, th")
      .map((_, cell) => $(cell).text().trim().replace(/\s+/g, " "))
      .get();
    if (cells.some(Boolean)) rows.push(cells.join(" | "));
  });
  return rows.join("\n");
}

/**
 * div.admonition -> a bold label paragraph followed by the body, unwrapped
 * so turndown converts it normally. Some admonitions on this site (e.g. the
 * per-version warning box on app pages) are JS-populated placeholders that
 * render empty and only gain text on user interaction — emitting those as
 * an empty "**Warning:**" would be noise with nothing behind it, so they're
 * dropped rather than shown blank.
 */
function flattenAdmonition($, div) {
  const titleEl = div.children(".admonition-title").first();
  const cls = (div.attr("class") || "").split(/\s+/).find((c) => c !== "admonition");
  const title = titleEl.length ? titleEl.text().trim() : cls ? cls[0].toUpperCase() + cls.slice(1) : "Note";
  const body = div.clone();
  body.find(".admonition-title").remove();
  if (!body.text().trim()) return "";
  return `<p><strong>${title}:</strong></p>${body.html() || ""}`;
}

/**
 * .tabbed-set -> each tab becomes a bold label paragraph + its content,
 * unwrapped in order. mkdocs-material renders every tab's content in the
 * HTML regardless of which is initially selected, so nothing is lost.
 */
function flattenTabs($, tabSet) {
  const labels = tabSet
    .find("> .tabbed-labels > label")
    .map((_, l) => $(l).text().trim())
    .get();
  const blocks = tabSet.find("> .tabbed-content > .tabbed-block").toArray();
  return blocks
    .map((b, i) => `<p><strong>${labels[i] || `Option ${i + 1}`}:</strong></p>${$(b).html() || ""}`)
    .join("");
}

/**
 * @param {string} html - full page HTML from docs.nesi.org.nz
 * @returns {string} markdown text of the page body, or "" if the content
 *   container wasn't found (caller should fall back to raw markdown).
 */
export function extractBody(html) {
  const $ = cheerio.load(html);
  const article = $(CONTENT_SELECTOR).first();
  if (!article.length) return "";

  article.find("script, style, svg, aside.md-source-file, .md-content__button, .md-clipboard, a.headerlink").remove();

  // Elements the theme ships inert and reveals only via client-side JS
  // (e.g. a version-picker's warning box) — inline display:none is the
  // reliable static signal that a browser wouldn't render them either.
  article.find("[style]").each((_, el) => {
    if (/display\s*:\s*none/.test($(el).attr("style") || "")) $(el).remove();
  });

  // The top tag-list nav and each app's per-version nav share the base
  // class "md-tags" — only the tag-list one (no "-ver-" modifier) is chrome.
  article.find("nav.md-tags").each((_, el) => {
    if (!/md-tags-ver-/.test($(el).attr("class") || "")) $(el).remove();
  });

  article.find("table").each((_, el) => {
    const t = $(el);
    t.replaceWith(`<p>${flattenTable($, t).replace(/\n/g, "<br>")}</p>`);
  });
  article.find("div.admonition").each((_, el) => $(el).replaceWith(flattenAdmonition($, $(el))));
  article.find("div.tabbed-set").each((_, el) => $(el).replaceWith(flattenTabs($, $(el))));

  const md = turndown.turndown(article.html() || "");
  return md.replace(/\n{3,}/g, "\n\n").trim();
}
