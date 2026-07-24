import { score, report } from "./eval.mjs";

const rows = [
  { id: "a", expect: "answer", rank: 1, topScore: 0.9, top3: [] },   // grounded
  { id: "b", expect: "answer", rank: 3, topScore: 0.45, top3: [] },  // grounded
  { id: "c", expect: "answer", rank: 8, topScore: 0.4, top3: [] },   // confident, source outside CONTEXT_K
  { id: "d", expect: "answer", rank: null, topScore: 0.15, top3: [] }, // false refusal + never retrieved
  { id: "e", expect: "refuse", rank: null, topScore: 0.31, top3: [] }, // false answer
  { id: "f", expect: "refuse", rank: null, topScore: 0.05, top3: [] }, // correct refusal
  { id: "g", expect: "answer", rank: null, topScore: null, top3: [], error: "boom" }, // must be excluded
];

const s = score(rows, 0.2);
const got = {
  excluded: s.excluded,
  answerable: s.answerable,
  negatives: s.negatives,
  hits: s.hits.map((h) => `${h.k}:${h.n}`).join(" "),
  mrr: s.mrr.toFixed(4),
  grounded: s.grounded.map((r) => r.id),
  ungrounded: s.ungrounded.map((r) => r.id),
  falseRefusal: s.falseRefusal.map((r) => r.id),
  falseAnswer: s.falseAnswer.map((r) => r.id),
};
const want = {
  excluded: 1,
  answerable: 4,          // a b c d; g excluded
  negatives: 2,
  hits: "1:1 3:2 6:2 20:3", // ranks 1,3,8 -> @1=1 @3=2 @6=2 @20=3
  mrr: ((1 / 1 + 1 / 3 + 1 / 8 + 0) / 4).toFixed(4),
  grounded: ["a", "b"],
  ungrounded: ["c"],
  falseRefusal: ["d"],
  falseAnswer: ["e"],
};

let fail = 0;
for (const k of Object.keys(want)) {
  const g = JSON.stringify(got[k]), w = JSON.stringify(want[k]);
  if (g !== w) { console.log(`FAIL ${k}: got ${g} want ${w}`); fail++; }
}

// false answers must not increase as the threshold rises; false refusals must not decrease.
let prevFA = Infinity, prevFR = -Infinity;
for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
  const x = score(rows, t);
  if (x.falseAnswer.length > prevFA) { console.log(`FAIL monotonic false-answer at ${t}`); fail++; }
  if (x.falseRefusal.length < prevFR) { console.log(`FAIL monotonic false-refusal at ${t}`); fail++; }
  if (x.grounded.length > x.hits.find((h) => h.k === 6).n) { console.log(`FAIL grounded > hit@6 at ${t}`); fail++; }
  prevFA = x.falseAnswer.length;
  prevFR = x.falseRefusal.length;
}

console.log(fail === 0 ? "\nscoring OK\n" : `\n${fail} failures\n`);
report(rows, { threshold: 0.2, verbose: true });
process.exit(fail === 0 ? 0 : 1);
