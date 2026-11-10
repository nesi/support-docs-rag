import { createBreakStreamFilter } from "../src/breaks.mjs";

let fail = 0;

// Feed `pieces` through the filter and return the resulting bubbles.
function run(pieces) {
  const bubbles = [""];
  const f = createBreakStreamFilter((t) => { bubbles[bubbles.length - 1] += t; }, () => bubbles.push(""));
  for (const p of pieces) f.push(p);
  f.flush();
  return bubbles;
}
// Split prose into small chunks the way the model streams it; code blocks
// arrive whole (createSbatchStreamFilter emits them as one piece).
const chunk = (s, n = 3) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) || [];

function check(name, pieces, want) {
  const got = run(pieces);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    fail++;
  }
}

const SCRIPT = "```\n#!/bin/bash -e\n\n#SBATCH --job-name x\n```";
const MORE = "More: [Job Arrays › Basics](https://docs.nesi.org.nz/x/#basics)";

check("plain answer stays one bubble", chunk("Use `sbatch` to submit [1].\n\nIt queues the job."),
  ["Use `sbatch` to submit [1].\n\nIt queues the job."]);

check("answer / More", chunk(`Use sbatch [1].\n\n${MORE}`),
  ["Use sbatch [1].\n\n", MORE]);

check("answer / script / More", [...chunk("Here's a script [1]:\n\n"), SCRIPT, ...chunk(`\n\n${MORE}`)],
  ["Here's a script [1]:\n\n", SCRIPT, MORE]);

check("script first, no empty leading bubble", [SCRIPT, ...chunk(`\n\n${MORE}`)],
  [SCRIPT, MORE]);

check("bold More", chunk("Short answer.\n\n**More:** [X](https://docs.nesi.org.nz/x/)"),
  ["Short answer.\n\n", "**More:** [X](https://docs.nesi.org.nz/x/)"]);

check("'More' mid-sentence or as another word is not a break", chunk("Request more memory with --mem [1].\nMoreover, check usage.\nmore than 2 GB"),
  ["Request more memory with --mem [1].\nMoreover, check usage.\nmore than 2 GB"]);

check("text after script continues in a new bubble", ["Run:\n", SCRIPT, ...chunk("\nThen check squeue [2].")],
  ["Run:\n", SCRIPT, "Then check squeue [2]."]);

check("two scripts -> separate bubbles", ["A:\n", SCRIPT, ...chunk("\n\nB:\n"), SCRIPT],
  ["A:\n", SCRIPT, "B:\n", SCRIPT]);

check("held 'Mo' at end of stream is flushed", chunk("Ok.\nMo", 2), ["Ok.\nMo"]);

check("leading whitespace dropped", chunk("\n\n  Answer."), ["Answer."]);

check("empty stream -> one empty bubble", [], [""]);

console.log(fail === 0 ? "breaks OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
