/**
 * Resolves the mkdocs-macros patterns used by NeSI's ~50 application pages
 * (docs/Software/Available_Applications/*.md) directly from
 * docs/assets/module-list.json, instead of running mkdocs to render them.
 *
 * These pages get their real content — description, version list, licence
 * warnings, network-licence table — from `{% set app = applications[app_name] %}`
 * plus four `{% include "partials/app/..." %}` calls. Regex-stripping that
 * Jinja (like the rest of cleanMarkdown does) would delete the page's actual
 * content, not just noise. Rather than replicate the full Jinja template
 * (interactive version-picker buttons, per-cluster licence-token tables), this
 * renders the same underlying data as plain markdown — enough for retrieval
 * and grounded answers, not a pixel-identical copy of the site.
 *
 * A handful of other pages reference other apps' data directly (e.g.
 * `{{ applications.ANSYS.default }}`, `{% for pyext in applications.Python.extensions %}`)
 * — resolveCrossAppRefs handles the dotted/bracket lookups and the one
 * loop-over-a-list-field shape actually used in this repo. Anything stranger
 * is left to chunker.mjs's generic Jinja strip.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadModuleList(docsRoot) {
  try {
    return JSON.parse(readFileSync(join(docsRoot, "assets/module-list.json"), "utf8"));
  } catch {
    return {}; // missing/unreadable -> every lookup below is a no-op passthrough
  }
}

function findApp(moduleList, key) {
  if (!key) return null;
  if (moduleList[key]) return moduleList[key];
  const lower = key.toLowerCase();
  const found = Object.keys(moduleList).find((k) => k.toLowerCase() === lower);
  return found ? moduleList[found] : null;
}

/** name of the app a page documents, from its own filename (e.g. ABAQUS.md -> "ABAQUS"). */
export function appNameFromPath(relPath) {
  const base = relPath.split("/").pop().replace(/\.md$/, "");
  return base;
}

function warningFor(app, version) {
  const hit = app.admin_list?.find((kvp) => Object.keys(kvp)[0] === version);
  return hit ? Object.values(hit)[0] : null;
}

function renderVersionBlock(app, appName) {
  if (!app.versions?.length) return app.default ? `Default version: ${app.default}` : "";
  const lines = app.versions.map((v) => {
    const w = warningFor(app, v);
    return `- ${v}${v === app.default ? " (default)" : ""}${w ? ` — ${w}` : ""}`;
  });
  return `Available versions of ${appName}:\n${lines.join("\n")}\n\nLoad with: \`module load ${appName}/${app.default}\``;
}

function renderHomepage(app, appName) {
  const url = app.homepage || app.url;
  return url ? `[${appName} Homepage](${url})` : "";
}

function renderWarnings(app, appName) {
  if (app.licence_type !== "proprietary") return "";
  return `**Warning:** ${appName} is proprietary software. Make sure you meet the requirements for its usage.`;
}

/**
 * Simplified from the site's interactive table (institution, faculty, live
 * per-cluster token usage) down to which institutions/faculties have access
 * and whether the licence server is currently down — the part relevant to
 * "do I have access to X" questions, not real-time token accounting.
 */
function renderNetworkLicence(app) {
  const licences = app.network_licences;
  if (!licences?.length) return "";
  const rows = licences.map((l) => {
    const inst = l.institution_long || l.institution_short || "";
    const fac = l.faculty_long || l.faculty_short || "";
    const status = l.server_uptime < 0.5 ? " (licence server currently down)" : "";
    return `- ${[inst, fac].filter(Boolean).join(", ")}${status}`;
  });
  return `Institutions with network licence access:\n${rows.join("\n")}`;
}

/** Resolve the page's own `applications[app_name]` macros — see module header. */
export function resolveAppMacros(body, relPath, moduleList) {
  const appName = appNameFromPath(relPath);
  const app = findApp(moduleList, appName);
  if (!app) return body;
  return body
    .replace(/\{%\s*set\s+app_name[^%]*%\}\s*/g, "")
    .replace(/\{%\s*set\s+app\s*=\s*applications\[[^%]*%\}\s*/g, "")
    .replace(/\{\{\s*app\.description\s*\}\}/g, app.description || "")
    .replace(/\{\{\s*app\.default\s*\}\}/g, app.default || "")
    .replace(/\{%\s*include\s*"partials\/app\/app_version\.html"\s*-?%\}/g, renderVersionBlock(app, appName))
    .replace(/\{%\s*include\s*"partials\/app\/app_homepage\.html"\s*-?%\}/g, renderHomepage(app, appName))
    .replace(/\{%\s*include\s*"partials\/app\/app_warnings\.html"\s*-?%\}/g, renderWarnings(app, appName))
    .replace(/\{%\s*include\s*"partials\/app\/app_network_licence\.html"\s*-?%\}/g, renderNetworkLicence(app));
}

/** `{{ applications.ANSYS.default }}` / `{{ applications["foss"].versions | last }}` on other pages. */
export function resolveCrossAppRefs(body, moduleList) {
  let out = body.replace(
    /\{\{\s*applications(?:\.(\w+)|\[["'](\w+)["']\])\.(\w+)\s*(\|\s*last\s*)?\}\}/g,
    (_, dotKey, bracketKey, field, last) => {
      const app = findApp(moduleList, dotKey || bracketKey);
      const val = app?.[field];
      if (Array.isArray(val)) return last ? (val[val.length - 1] ?? "") : val.join(", ");
      return val ?? "";
    }
  );
  // {% for x in applications.APP.FIELD %}...{{ x }}...{% endfor %} - the one loop
  // shape actually used here (docs/Software/Available_Applications/Python.md
  // listing extensions) - joined list, not per-item template rendering.
  out = out.replace(
    /\{%\s*for\s+(\w+)\s+in\s+applications\.(\w+)\.(\w+)\s*-?%\}[\s\S]*?\{%\s*endfor\s*-?%\}/g,
    (_, __, appKey, field) => {
      const app = findApp(moduleList, appKey);
      const val = app?.[field];
      return Array.isArray(val) ? val.join(", ") : "";
    }
  );
  return out;
}
