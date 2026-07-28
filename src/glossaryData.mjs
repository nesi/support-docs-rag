// appData.mjs's renderModuleRecord() covers every app more fully, 
// so anything that's an app name is excluded here.

const ENTRY_LINE = /^\*\[(.+?)\]:\s?(.*)$/;

export function parseGlossaryEntries(raw) {
  const entries = [];
  let current = null;
  for (const line of raw.split("\n")) {
    const m = line.match(ENTRY_LINE);
    if (m) {
      if (current) entries.push(current);
      current = { term: m[1].trim(), parts: [m[2]] };
    } else if (current) {
      current.parts.push(line);
    }
  }
  if (current) entries.push(current);
  return entries
    .map((e) => ({ term: e.term, definition: e.parts.join(" ").replace(/\s+/g, " ").trim() }))
    .filter((e) => e.definition);
}

/** Group terms sharing a definition into one entry with aliases. */
function groupByDefinition(entries) {
  const order = [];
  const terms = new Map(); // definition -> terms seen, in first-seen order
  for (const e of entries) {
    if (!terms.has(e.definition)) { terms.set(e.definition, []); order.push(e.definition); }
    terms.get(e.definition).push(e.term);
  }
  return order.map((definition) => {
    const group = terms.get(definition);
    const term = group.reduce((a, b) => (b.length < a.length ? b : a)); // shortest reads as the acronym
    return { term, aliases: group.filter((t) => t !== term), definition };
  });
}

/** True jargon/acronyms only -- excludes anything that's a module-list.json app name. */
export function resolveGlossaryEntries(raw, moduleList) {
  const appNames = new Set(Object.keys(moduleList).map((k) => k.toLowerCase()));
  return groupByDefinition(parseGlossaryEntries(raw))
    .filter((e) => ![e.term, ...e.aliases].some((t) => appNames.has(t.toLowerCase())));
}
