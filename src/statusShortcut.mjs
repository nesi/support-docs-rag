// "Is Mahuika down?"-style questions, answered straight from the Statuspage
// summary (status.nesi.org.nz/api/v2/summary.json) instead of the docs.
// Pure: worker.js fetches the summary and passes it in, so this is
// unit-testable with fixture JSON.
//
// Two kinds of question:
//  - "check" ("is mahuika down", "any outages", "status of ondemand"):
//    always answered from status, including "it's operational".
//  - "why" ("why is ondemand not working"): answered from status only when
//    something matching is actually degraded; otherwise null, so the caller
//    falls through to normal docs retrieval (troubleshooting pages).
//
// Replies stay to one short line per affected component plus a link -- the
// status page is where the detail lives (see the "status mention" rules
// around relevantStatusQuote() in worker.js).
//
// Whole-message patterns only, like junk.mjs: "is mahuika down? I get
// 'connection refused' when I ssh" is a real troubleshooting question and
// goes to retrieval, where the LLM already sees the live status block.

import { normalise } from "./junk.mjs";

const STATUS_PAGE = "[status.nesi.org.nz](https://status.nesi.org.nz)";

// User words -> which Statuspage components they mean, matched against the
// component NAMES from the live summary (not hard-coded names), so a renamed
// component still matches as long as the key word survives. `null` = all.
const TARGETS = [
  [/\b(mahuika|the cluster|cluster|hpc|the hpc|supercomputer|nesi|reannz)\b/, /\b(mahuika|hpc)\b/i],
  [/\b(login|log in|logins|ssh|lander|login nodes?)\b/, /\blog ?in\b/i],
  [/\b(jobs?|slurm|queue|scheduler|squeue|sbatch)\b/, /\bjobs?\b/i],
  [/\b(ondemand|on demand|jupyter|jupyterhub|jupyterlab|rstudio|vs ?code)\b/, /ondemand/i],
  [/\b(storage|filesystems?|file systems?|nobackup|scratch|weka|home directory|project directory)\b/, /\bhpc storage\b/i],
  [/\b(freezer|tape|long[- ]term storage|s3)\b/, /freezer|long-term/i],
  [/\b(globus|data transfer|transfers?)\b/, /data transfer/i],
  [/\b(my\.?nesi|mynesi|my nesi|portal|hpc portal|hpc-portal)\b/, /apply for access/i],
  [/\b(flexihpc|flexi hpc|cloud|openstack)\b/, /flexi|cloud/i],
  [/\b(docs|documentation|docs site|support docs)\b/, /documentation/i],
  [/\b(support system|helpdesk|help desk|jira|ticketing)\b/, /support system/i],
  [/\b(everything|anything|something|services|systems|all services|all systems)\b/, null],
];

const WHEN = "( (right )?now| today| at the moment| atm| again| currently| for anyone else| for everyone)?";
const DOWN = "(down|up|offline|online|working|broken|out|having (problems|issues|trouble)|ok|okay|available|unavailable|running|dead|slow)";

const CHECK_PATTERNS = [
  // "is mahuika down", "is the login node working right now"
  new RegExp(`^(is|are) (the )?(?<target>.+?) ${DOWN}${WHEN}$`),
  // "any outages", "is there maintenance on ondemand today"
  new RegExp(`^((is|are) )?(there )?(an? |any )?(current |known |planned |scheduled )?(outages?|issues?|problems?|maintenance|incidents?|downtime)( (with|on|for|affecting|to) (the )?(?<target>.+?))?${WHEN}$`),
  // "status", "system status", "what's the status of ondemand"
  new RegExp(`^((what is|what's|whats|check) )?(the )?(current )?(system |service |hpc |cluster )?status( (of|for) (the )?(?<target>.+?))?${WHEN}$`),
  // "mahuika down", "freezer outage" (not "<x> status": "job status" means squeue)
  new RegExp(`^(?<target>.+?) (down|outage|offline)${WHEN}$`),
];
const WHY_PATTERNS = [
  // "why is mahuika down", "why isn't ondemand working"
  new RegExp(`^why (is|are|isn't|aren't|is not|are not) (the )?(?<target>.+?) (down|offline|not working|working|unavailable|so slow|slow|broken)${WHEN}$`),
];

function resolveTargets(target) {
  if (!target) return { all: true, matchers: [] }; // "any outages?" with no subject
  if (/\bmy\b/.test(target)) return null; // "is my job running" is about their job, not the service
  const hits = TARGETS.filter(([words]) => words.test(target));
  if (!hits.length) return null; // unknown subject -> let retrieval have it
  if (hits.some(([, comp]) => comp === null)) return { all: true, matchers: [] };
  return { all: false, matchers: hits.map(([, comp]) => comp) };
}

/**
 * @returns {{mode: "check"|"why", all: boolean, matchers: RegExp[]} | null}
 */
export function classifyStatusQuestion(question) {
  const t = normalise(question);
  // "why" first: "why is mahuika down" also fits the bare "<x> down" check pattern.
  for (const [mode, patterns] of [["why", WHY_PATTERNS], ["check", CHECK_PATTERNS]]) {
    for (const re of patterns) {
      const m = t.match(re);
      if (!m) continue;
      const resolved = resolveTargets(m.groups?.target?.trim());
      if (resolved) return { mode, ...resolved };
    }
  }
  return null;
}

const pretty = (s) => s.replace(/_/g, " ");
const ACTIVE_MAINT = new Set(["in_progress", "verifying"]);
const UPCOMING_WINDOW_MS = 7 * 24 * 3600 * 1000;

function nzTime(iso) {
  try {
    return new Date(iso).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/**
 * Reply text for a classified status question, or null to fall through to
 * docs retrieval. `summary` is the raw Statuspage summary JSON, or null if
 * the fetch failed.
 */
export function statusReply(summary, match, now = Date.now()) {
  if (!summary?.components) {
    return match.mode === "check" ? `I couldn't reach the status page just now. Check ${STATUS_PAGE} directly.` : null;
  }

  // Leaf components only (groups are just containers on Statuspage).
  const leaves = summary.components.filter((c) => !c.group);
  const wanted = match.all ? leaves : leaves.filter((c) => match.matchers.some((re) => re.test(c.name)));
  if (!wanted.length) return match.mode === "check" ? `See ${STATUS_PAGE} for current service status.` : null;
  const wantedNames = new Set(wanted.map((c) => c.name));
  // An incident/maintenance counts if it's linked to a wanted component, or --
  // when it has no linked components at all -- if its NAME matches the target.
  // Never "unlinked means everything": that credits e.g. a Freezer incident to
  // a "is mahuika down" question (the misattribution relevantStatusQuote() avoids too).
  const touches = (item) =>
    match.all ||
    (item.components?.length
      ? item.components.some((c) => wantedNames.has(c.name))
      : match.matchers.some((re) => re.test(item.name || "")));

  const degraded = wanted.filter((c) => c.status && c.status !== "operational");
  const incidents = (summary.incidents || []).filter((i) => i.status !== "resolved" && i.status !== "postmortem" && touches(i));
  const maint = (summary.scheduled_maintenances || []).filter(touches);
  const activeMaint = maint.filter((m) => ACTIVE_MAINT.has(m.status));
  const upcoming = maint.filter(
    (m) => m.status === "scheduled" && Date.parse(m.scheduled_for) - now < UPCOMING_WINDOW_MS
  );

  const problems = degraded.length || incidents.length || activeMaint.length;
  if (!problems && match.mode === "why") return null; // nothing reported -> docs troubleshooting is the better answer

  const lines = [];
  if (problems) {
    for (const c of degraded) lines.push(`${c.name}: ${pretty(c.status)}.`);
    for (const i of incidents) lines.push(`Current incident: ${i.name} (${pretty(i.status)}).`);
    for (const m of activeMaint) lines.push(`Maintenance in progress: ${m.name}.`);
    lines.push(`See ${STATUS_PAGE} for details and updates.`);
  } else {
    const what = match.all
      ? "All services are"
      : wanted.length === 1
        ? `${wanted[0].name} is`
        : `${wanted.slice(0, -1).map((c) => c.name).join(", ")} and ${wanted.at(-1).name} are`;
    lines.push(`No problems reported: ${what} operational on ${STATUS_PAGE}.`);
  }
  for (const m of upcoming) lines.push(`Upcoming maintenance: ${m.name}, from ${nzTime(m.scheduled_for)}.`);
  if (!problems) lines.push("If something still isn't working for you, tell me the command and error message you're seeing.");
  return lines.join(" ");
}
