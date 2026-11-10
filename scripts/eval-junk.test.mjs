import { classifyJunk, junkReply } from "../src/junk.mjs";

// The expensive mistake is a false positive (a real question gets a canned
// brush-off), so most cases here are short-but-real questions that must pass.
const cases = [
  // junk
  ["test", "test"], ["Test!", "test"], ["testing 123", "test"], ["  this is a test. ", "test"], ["ping", "test"],
  ["hi", "greeting"], ["Hello!!", "greeting"], ["Kia ora", "greeting"], ["hey there", "greeting"], ["Good morning", "greeting"],
  ["thanks", "thanks"], ["Thank you so much!", "thanks"], ["ok", "thanks"], ["cheers", "thanks"],
  ["asdf", "gibberish"], ["asdfghjkl", "gibberish"], ["qwerty", "gibberish"],
  ["???", "gibberish"], ["...", "gibberish"], ["123", "gibberish"], ["#$%^", "gibberish"], ["aaaaaaa", "gibberish"], ["cc", null], ["gcc", null], ["", "gibberish"],
  // real questions -- must NOT be junk
  ["R", null], ["git", null], ["ssh", null], ["sbatch", null], ["GPU", null], ["Python?", null],
  ["test job", null], ["How do I test my job script?", null], ["hi, how do I log in?", null],
  ["thanks, and how much memory can I request?", null], ["ok what about GPUs", null],
  ["how do i use slurm", null], ["module load", null], ["Kia ora, how do I get an account?", null],
  ["什么是 Slurm", null], ["Me pēhea taku takiuru?", null], ["CUDA 12", null],
];

let fail = 0;
for (const [q, want] of cases) {
  const got = classifyJunk(q);
  if (got !== want) {
    console.log(`FAIL classifyJunk(${JSON.stringify(q)}): got ${got} want ${want}`);
    fail++;
  }
}
for (const kind of ["greeting", "thanks", "test", "gibberish"]) {
  if (!junkReply(kind)?.trim()) { console.log(`FAIL junkReply(${kind}) empty`); fail++; }
}

console.log(fail === 0 ? "junk OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
