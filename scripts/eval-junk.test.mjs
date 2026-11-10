import { classifyJunk, junkReply, containsSecret, isRepeatQuestion } from "../src/junk.mjs";

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

for (const kind of ["greeting", "thanks", "test", "gibberish", "human", "identity", "rude"]) {
  if (!junkReply(kind)?.trim()) { console.log(`FAIL junkReply(${kind}) empty`); fail++; }
}

console.log(fail === 0 ? "junk OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
