import { chunkHash, planIngest } from "./ingestPlan.mjs";

const MODEL = "@cf/baai/bge-m3";

function chunk(id, embedText, extra = {}) {
  const c = { id, embedText, metadata: { path: id.split("#")[0], text: embedText, ...extra } };
  c.metadata.hash = chunkHash(c, MODEL);
  return c;
}

let fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL ${name}: got ${g} want ${w}`); fail++; }
}
function throws(name, fn) {
  try { fn(); console.log(`FAIL ${name}: expected throw`); fail++; } catch { /* expected */ }
}

// chunkHash
const a = chunk("A.md#0", "alpha");
check("hash stable", chunkHash(a, MODEL), a.metadata.hash);
check("hash ignores stored hash", chunkHash({ ...a, metadata: { ...a.metadata, hash: "x" } }, MODEL), a.metadata.hash);
check("hash changes with text", chunk("A.md#0", "alpha!").metadata.hash !== a.metadata.hash, true);
check("hash changes with metadata", chunk("A.md#0", "alpha", { heading: "H" }).metadata.hash !== a.metadata.hash, true);
check("hash changes with model", chunkHash(a, "@cf/other") !== a.metadata.hash, true);

// planIngest
const b = chunk("B.md#0", "beta");
const c = chunk("C.md#0", "gamma");
const d = chunk("D.md#0", "delta");
const cur = [a, b, c, d];
const ids = (p) => ({ upsert: p.upsert.map((x) => x.id), delete: p.delete, unchanged: p.unchanged });

check("empty index -> embed all", ids(planIngest(cur, new Map())), { upsert: ["A.md#0", "B.md#0", "C.md#0", "D.md#0"], delete: [], unchanged: 0 });

const same = new Map(cur.map((x) => [x.id, x.metadata.hash]));
check("all unchanged", ids(planIngest(cur, same)), { upsert: [], delete: [], unchanged: 4 });
check("--full", ids(planIngest(cur, same, { full: true })).upsert.length, 4);

const changed = new Map(same).set("B.md#0", "stale");
check("changed hash", ids(planIngest(cur, changed)), { upsert: ["B.md#0"], delete: [], unchanged: 3 });

const legacy = new Map(same).set("C.md#0", undefined);
check("pre-hash vector re-embedded", ids(planIngest(cur, legacy)).upsert, ["C.md#0"]);

const orphan = new Map(same).set("A.md#1", "h"); // page shrank from 2 chunks to 1
check("orphan tail deleted", ids(planIngest(cur, orphan)), { upsert: [], delete: ["A.md#1"], unchanged: 4 });

// mass-delete guard
throws("no chunks", () => planIngest([], same));
check("no chunks, allowed", planIngest([], same, { allowMassDelete: true }).delete.length, 4);
throws(">50% delete", () => planIngest([a], same));
check(">50% delete, allowed", planIngest([a], same, { allowMassDelete: true }).delete.length, 3);
check("50% delete ok", planIngest([a, b], same).delete, ["C.md#0", "D.md#0"]);

console.log(fail === 0 ? "ingestPlan OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
