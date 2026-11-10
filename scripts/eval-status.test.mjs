import { classifyStatusQuestion, statusReply } from "../src/statusShortcut.mjs";

let fail = 0;
const check = (label, ok) => { if (!ok) { console.log(`FAIL ${label}`); fail++; } };

/* ------------------------- question classification ------------------------- */

// [question, expected mode or null]
const questions = [
  ["Is Mahuika down?", "check"], ["is the cluster down right now", "check"], ["Is OnDemand working?", "check"],
  ["are there any outages", "check"], ["any outages?", "check"], ["Is there maintenance on Freezer today?", "check"],
  ["status", "check"], ["What's the system status?", "check"], ["what's the status of globus", "check"],
  ["mahuika down?", "check"], ["is everything ok", "check"], ["Is anything down?", "check"], ["is slurm working", "check"],
  ["Is the login node down?", "check"], ["Is the HPC down again?", "check"], ["Are the login nodes down?", "check"],
  ["why is ondemand not working", "why"], ["Why is Mahuika down?", "why"], ["why isn't jupyter working?", "why"],
  ["why isnt jupyter working", "why"], ["whats the status of globus", "check"],
  // not status questions
  ["is my job running", null], ["Is it down?", null], ["job status", null], ["how do I check my job status", null],
  ["Is Python available on Mahuika?", null], ["is GROMACS working with GPUs", null],
  ["Is Mahuika down? I get connection refused when I ssh", null], ["Why is my job pending?", null],
  ["What is the status of my allocation request?", null], ["how do I get my project storage increased", null],
];
for (const [q, want] of questions) {
  const got = classifyStatusQuestion(q)?.mode ?? null;
  check(`classifyStatusQuestion(${JSON.stringify(q)}): got ${got} want ${want}`, got === want);
}

/* --------------------------------- replies --------------------------------- */

const comp = (name, status = "operational", extra = {}) => ({ id: name, name, status, group: false, ...extra });
const base = () => ({
  status: { indicator: "none", description: "All Systems Operational" },
  components: [
    comp("Login to Mahuika"), comp("Submit new HPC Jobs"), comp("Jobs running on HPC"), comp("HPC Storage"),
    comp("NeSI OnDemand"), comp("Long-term Storage (Freezer)"), comp("Data Transfer"),
    { id: "g", name: "Flexible High Performance Cloud Services", status: "operational", group: true },
    comp("FlexiHPC Dashboard (web interface)", "operational", { group_id: "g" }),
  ],
  incidents: [],
  scheduled_maintenances: [],
});
const ask = (q, summary, now) => statusReply(summary, classifyStatusQuestion(q), now);

// all operational
let r = ask("Is Mahuika down?", base());
check(`operational mahuika mentions components: ${r}`, /No problems reported/.test(r) && /Login to Mahuika/.test(r) && /HPC Storage/.test(r) && !/OnDemand/.test(r));
check("operational why -> falls through to docs", ask("why is ondemand not working", base()) === null);
r = ask("any outages?", base());
check(`operational all: ${r}`, /All services are operational/.test(r));
check("fetch failed, check -> pointer", /couldn't reach/.test(ask("Is Mahuika down?", null)));
check("fetch failed, why -> fall through", ask("why is mahuika down", null) === null);

// degraded component + linked incident
let s = base();
s.components[0].status = "major_outage";
s.incidents = [{ name: "Mahuika login unavailable", status: "investigating", components: [{ name: "Login to Mahuika" }], incident_updates: [{ body: "LONG BODY" }] }];
r = ask("Is Mahuika down?", s);
check(`major outage reported: ${r}`, /Login to Mahuika: major outage/.test(r) && /Mahuika login unavailable \(investigating\)/.test(r) && !/LONG BODY/.test(r));
check(`why + outage answered: `, /major outage/.test(ask("why is mahuika down", s) || ""));
r = ask("Is OnDemand down?", s);
check(`unrelated outage not attributed to OnDemand: ${r}`, /No problems reported/.test(r) && !/Mahuika login unavailable/.test(r));

// unlinked incident (no components): only attributed by name
s = base();
s.incidents = [{ name: "Freezer tape library fault", status: "identified", components: [] }];
check("unlinked freezer incident not credited to mahuika", /No problems reported/.test(ask("is mahuika down", s)));
check("unlinked freezer incident credited to freezer", /Freezer tape library fault/.test(ask("is freezer down", s)));
check("unlinked incident shown for all", /Freezer tape library fault/.test(ask("any outages", s)));

// maintenance: in progress vs upcoming vs far future
const now = Date.parse("2026-11-10T00:00:00Z");
s = base();
s.scheduled_maintenances = [
  { name: "OnDemand upgrade", status: "in_progress", components: [{ name: "NeSI OnDemand" }], scheduled_for: "2026-11-09T20:00:00Z" },
  { name: "Storage firmware", status: "scheduled", components: [{ name: "HPC Storage" }], scheduled_for: "2026-11-12T20:00:00Z" },
  { name: "Far future work", status: "scheduled", components: [{ name: "HPC Storage" }], scheduled_for: "2027-03-01T20:00:00Z" },
];
r = ask("is ondemand down", s, now);
check(`in-progress maintenance: ${r}`, /Maintenance in progress: OnDemand upgrade/.test(r));
r = ask("is mahuika down", s, now);
check(`upcoming maintenance mentioned, far one not: ${r}`, /No problems reported/.test(r) && /Upcoming maintenance: Storage firmware/.test(r) && !/Far future/.test(r));

console.log(fail === 0 ? "status OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
