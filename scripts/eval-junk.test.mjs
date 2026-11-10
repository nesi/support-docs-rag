import { classifyJunk, junkReply, containsSecret, isRepeatQuestion, examples, allJunkReplies, EXAMPLE_QUESTIONS } from "../src/junk.mjs";

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
  // human
  ["Can I talk to a human?", "human"], ["speak to someone please", "human"], ["How do I contact NeSI support?", "human"],
  ["email support", "human"], ["human", "human"], ["agent please", "human"],
  // identity
  ["Who are you?", "identity"], ["what can you do", "identity"], ["Are you ChatGPT?", "identity"], ["what model are you", "identity"],
  ["help", "identity"], ["What is this?", "identity"],
  // rude
  ["you're useless", "rude"], ["You’re useless!", "rude"], ["stupid bot", "rude"], ["this is rubbish", "rude"], ["fuck you", "rude"],
  ["wtf", "rude"], ["this sucks", "rude"], ["useless ai", "rude"],
  // real questions near those categories -- must NOT be caught
  ["why the hell is my job still pending?", null], ["my job failed with a stupid segfault, how do I debug it?", null],
  ["How do I contact support about a failed job 12345?", null], ["help with sbatch --array", null],
  ["what can you do with Globus?", null], ["who are the project owners on my project?", null],
  ["how do I use GPUs", null], ["Is support available on weekends?", null], ["what is this error: Bus error (core dumped)", null],
  // ---- widened patterns ----
  ["Hey hey!", "greeting"], ["hello there 👋", "greeting"], ["Kia ora koutou", "greeting"], ["Mōrena", "greeting"], ["tēnā koe", "greeting"],
  ["good morning team", "greeting"], ["sup", "greeting"], ["hi all :)", "greeting"],
  ["ok, thanks!", "thanks"], ["great, cheers mate", "thanks"], ["thanks heaps", "thanks"], ["that worked, thank you", "thanks"],
  ["much appreciated", "thanks"], ["👍", "gibberish"], ["ok cool", "thanks"], ["nvm", "thanks"], ["Ngā mihi", "thanks"], ["perfect, thanks for the help", "thanks"],
  ["bye", "goodbye"], ["ok bye", "goodbye"], ["Ka kite anō", "goodbye"], ["see you later", "goodbye"], ["that's all", "goodbye"],
  ["testing 1 2 3", "test"], ["test test", "test"], ["is this working?", "test"], ["are you there?", "test"], ["anyone there", "test"],
  ["can you hear me", "test"], ["test message", "test"], ["is this thing on", "test"],
  ["lol", "gibberish"], ["hahaha", "gibberish"], ["hmm", "gibberish"], ["asdasdasd", "gibberish"], ["sdfghjkl", "gibberish"], ["zxcvbnm", "gibberish"], ["idk", "gibberish"],
  ["I want a human", "human"], ["get me a real person", "human"], ["what is the support email?", "human"], ["contact details", "human"],
  ["how do I open a ticket", "human"], ["raise a support ticket", "human"], ["how can I reach you", "human"], ["speak to a real person please", "human"],
  ["who made you?", "identity"], ["what's your name", "identity"], ["what can I ask you?", "identity"], ["I need some help", "identity"],
  ["can you help me?", "identity"], ["how does this work", "identity"], ["what do you know", "identity"], ["what is this for", "identity"],
  ["that's wrong", "unhelpful"], ["that didn't work", "unhelpful"], ["not helpful", "unhelpful"], ["still not working", "unhelpful"],
  ["you didn't answer my question", "unhelpful"], ["try again", "unhelpful"], ["No, that's not right", "unhelpful"],
  ["worst bot ever", "rude"], ["bad bot", "rude"], ["you are completely useless", "rude"], ["shut up", "rude"], ["ffs", "rude"], ["piss off", "rude"],
  // flirty
  ["I love you", "flirty"], ["will you marry me?", "flirty"], ["are you single", "flirty"], ["you're cute 😍", "flirty"],
  ["hey cutie", "flirty"], ["do you love me?", "flirty"], ["wanna go out with me", "flirty"], ["be my valentine", "flirty"], ["ur so hot", "flirty"], ["are you available?", "test"],
  // flirty near misses: must NOT be caught
  ["I love Python, how do I install packages?", null], ["is there a date for the next maintenance?", null], ["are you available on weekends", null],
  ["what are you able to do with MATLAB", null], ["do you like GROMACS or LAMMPS for MD", null], ["how do I date-stamp my output files", null],
  // apostrophes optional
  ["that didnt help", "unhelpful"], ["thats wrong", "unhelpful"], ["youre useless", "rude"], ["whats your name", "identity"],
  ["Id like to speak to a human", "human"], ["I'd like to speak to a human", "human"], ["gday", "greeting"], ["g'day mate", "greeting"],
  // ---- near misses for the widened patterns: must NOT be caught ----
  ["hi, my job failed with OOM, what do I do?", null], ["Thanks, but how do I request more memory?", null],
  ["ok so how do I submit a job array?", null], ["test my MPI code on 2 nodes", null], ["how do I test GPU availability", null],
  ["check my quota", null], ["is this module available on Mahuika?", null], ["are you able to run Gaussian?", null],
  ["who do I contact about a licence?", null], ["contact support about quota increase", null], ["how do I open a file in nano", null],
  ["what can I run on the GPU nodes?", null], ["help with conda environments", null], ["how does Slurm fairshare work", null],
  ["that didn't work, I still get 'module not found' for Python/3.11", null], ["wrong module version loaded, how do I fix it", null],
  ["my job is useless slow, why?", null], ["flask", null], ["torque", null], ["pipette", null], ["Is 8d walltime allowed?", null],
  ["start a jupyter session", null], ["done jobs not showing in sacct", null], ["later versions of GROMACS?", null],
  ["hmm, my sbatch script fails with exit code 1", null], ["lol my job got killed for memory, help", null],
];

let fail = 0;
for (const [q, want] of cases) {
  const got = classifyJunk(q);
  if (got !== want) {
    console.log(`FAIL classifyJunk(${JSON.stringify(q)}): got ${got} want ${want}`);
    fail++;
  }
}
// Secrets: fakes are built at runtime so this file doesn't trip secret scanners.
const secretCases = [
  ["-----BEGIN OPENSSH " + "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA...", true],
  ["here is my key -----BEGIN RSA " + "PRIVATE KEY----- MIIEpAIBAAKCAQEA", true],
  ["my token is " + "ghp_" + "a1B2".repeat(9), true],
  ["access key " + "AKIA" + "IOSFODNN7EXAMPLE", true],
  ["secret_key = " + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", true],
  ["sk-ant-" + "x".repeat(40), true],
  // must pass
  ["How do I set up an SSH key for Mahuika?", false],
  ["What goes in access_key = <your access key> in .s3cfg?", false],
  ["My password is not working", false],
  ["password: is it the same as my university one?", false],
  ["ssh-keygen -t ed25519 gave me id_ed25519.pub, where does it go?", false],
];
for (const [text, want] of secretCases) {
  if (containsSecret(text) !== want) { console.log(`FAIL containsSecret(${JSON.stringify(text.slice(0, 50))}): want ${want}`); fail++; }
}

// Repeats: only an exact (normalised) match with the user's PREVIOUS message.
const turn = (u, a = "answer") => [{ role: "user", content: u }, { role: "assistant", content: a }];
const repeatCases = [
  ["How do I submit a GPU job?", turn("how do I submit a GPU job"), true],
  ["  HOW DO I SUBMIT A GPU JOB??  ", turn("How do I submit a GPU job?"), true],
  ["How do I submit a GPU job?", [...turn("How do I submit a GPU job?"), ...turn("and on Milan?")], false], // not the previous one
  ["and for GPUs?", turn("How much memory can I request?"), false],
  ["How do I submit a GPU job on Milan?", turn("How do I submit a GPU job?"), false],
  ["How do I submit a GPU job?", [], false],
  ["How do I submit a GPU job?", [{ role: "assistant", content: "How do I submit a GPU job?" }], false], // only user turns count
];
for (const [q, h, want] of repeatCases) {
  if (isRepeatQuestion(q, h) !== want) { console.log(`FAIL isRepeatQuestion(${JSON.stringify(q)}): want ${want}`); fail++; }
}

// Replies: every variant non-empty, no leftover placeholders, links well-formed.
for (const kind of ["greeting", "thanks", "goodbye", "test", "gibberish", "human", "identity", "flirty", "unhelpful", "rude"]) {
  const all = allJunkReplies(kind);
  if (all.length < 2) { console.log(`FAIL ${kind}: want 2+ variants, got ${all.length}`); fail++; }
  for (const r of all) {
    if (!r.trim() || /undefined|\$\{|\.\.$/.test(r) || /\]\((?!https:\/\/|mailto:)/.test(r)) { console.log(`FAIL ${kind} variant: ${JSON.stringify(r)}`); fail++; }
  }
}
// Random variant selection reaches more than one variant, and stays in range at rand -> 1.
const seen = new Set(Array.from({ length: 200 }, () => junkReply("greeting")));
if (seen.size < 2) { console.log("FAIL junkReply never varies"); fail++; }
if (!junkReply("greeting", () => 0.9999999)) { console.log("FAIL junkReply(rand~1) empty"); fail++; }
// Examples: always exactly two, always different, always from the pool.
for (let n = 0; n < 500; n++) {
  const ex = examples();
  const qs = [...ex.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (qs.length !== 2 || qs[0] === qs[1] || !qs.every((q) => EXAMPLE_QUESTIONS.includes(q))) { console.log(`FAIL examples(): ${ex}`); fail++; break; }
}
for (const r of [0, 0.5, 0.9999999]) {
  const qs = [...examples(() => r).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (qs.length !== 2 || qs[0] === qs[1]) { console.log(`FAIL examples(rand=${r}): ${qs}`); fail++; }
}

for (const kind of ["greeting", "thanks", "goodbye", "test", "gibberish", "human", "identity", "flirty", "unhelpful", "rude"]) {
  if (!junkReply(kind)?.trim()) { console.log(`FAIL junkReply(${kind}) empty`); fail++; }
}

console.log(fail === 0 ? "junk OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
