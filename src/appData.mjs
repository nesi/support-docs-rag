// Pure rendering only (no node:fs) -- imported by both scripts/ (unused
// directly, kept for reference) and src/liveData.mjs (Workers runtime).
// module-list.json itself is loaded by whichever caller needs it.

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

// Simplified from the site's live per-cluster token table to just
// institution/faculty access + whether the server is down.
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

/** Full record for one module-list.json app: description, homepage, licence, versions. */
export function renderModuleRecord(appName, app) {
  return [
    app.description || "",
    renderHomepage(app, appName),
    renderWarnings(app, appName),
    renderVersionBlock(app, appName),
    renderNetworkLicence(app),
  ].filter(Boolean).join("\n\n");
}
