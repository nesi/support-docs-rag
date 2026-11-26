import { noAnswerReply, NO_ANSWER_PARTS } from "../src/fallback.mjs";

let fail = 0;
const check = (label, ok) => { if (!ok) { console.log(`FAIL ${label}`); fail++; } };
const linksOk = (r) => !/\]\((?!https:\/\/|mailto:)/.test(r) && !/undefined|\$\{/.test(r);

// Every combination of each case, by stepping `rand` through each index.
const n = Math.max(...Object.values(NO_ANSWER_PARTS).map((a) => a.length));
for (let i = 0; i < n; i++) {
  const r = () => (i + 0.5) / n;
  const plain = noAnswerReply({}, r);
  check(`plain #${i}: ${plain}`, linksOk(plain) && /support@nesi\.org\.nz/.test(plain) && !/status\.nesi/.test(plain));
  const rel = noAnswerReply({ quote: "Login to Mahuika: major outage", status: { indicator: "major" } }, r);
  check(`relevant #${i}: ${rel}`, linksOk(rel) && rel.includes('"Login to Mahuika: major outage"') && /status\.nesi\.org\.nz/.test(rel));
  const unrel = noAnswerReply({ status: { indicator: "minor" } }, r);
  check(`unrelated #${i}: ${unrel}`, linksOk(unrel) && /minor outage or maintenance/.test(unrel) && /doesn't look related/.test(unrel));
}
check("rand -> 1 stays in range", Boolean(noAnswerReply({}, () => 0.9999999)));
check("varies", new Set(Array.from({ length: 200 }, () => noAnswerReply())).size > 3);
check("no NeSI-as-organisation / JupyterHub wording", ![...NO_ANSWER_PARTS.OPENERS, ...NO_ANSWER_PARTS.SUGGESTIONS].some((s) => /NeSI support docs|JupyterHub/.test(s)));

console.log(fail === 0 ? "fallback OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
