// Cheap pre-retrieval gates, kept separate from worker.js so they're
// unit-testable without a running Worker. Each one answers with a canned
// reply before any embed/search/rerank/LLM call.
//
// containsSecret(): pasted private keys / tokens. Checked FIRST, on the
// question and on history, so the secret never reaches Workers AI.
//
// classifyJunk(): "test"/"hi"/keyboard mash, asking for a human, questions
// about the bot itself, and messages that are nothing but abuse. Would
// otherwise cost an embed + Vectorize query + rerank + status fetch only to
// hit the "not in the docs" fallback (or, worse, weakly match some chunk and
// get a grounded answer about something random).
//
// Deliberately conservative: every pattern is anchored to the WHOLE message,
// so "test" is junk but "test job on milan" is not, "stupid bot" is rude but
// "why the hell is my job pending" still gets answered, and there is no
// "short means junk" rule -- "R", "git", "ssh" are real questions. Callers
// should also skip classifyJunk() when liveLookup() finds a known app/term
// name (never containsSecret()).

const SUPPORT = "[support@nesi.org.nz](mailto:support@nesi.org.nz)";

/* ------------------------------ secrets ------------------------------ */

// Exact-format patterns only: a false positive here swallows a real question,
// so nothing generic like "password is ...". `key = value` forms require a
// long unbroken value so "access_key = <your key>" placeholders still pass.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, // SSH, PEM, PGP private keys
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/, // GitLab personal access tokens
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, // AWS-style access key ids (s3cmd / Freezer)
  /\b(aws_secret_access_key|secret_key|access_key)\s*[=:]\s*[A-Za-z0-9/+=]{20,}/i, // s3cmd .s3cfg / AWS credentials lines
  /\bsk-(ant-)?[A-Za-z0-9_-]{32,}\b/, // OpenAI / Anthropic API keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
];

/** True if `text` contains something that looks like a credential. */
export function containsSecret(text) {
  const t = String(text ?? "");
  return SECRET_PATTERNS.some((re) => re.test(t));
}

export const SECRET_REPLY =
  "You shouldn't paste credentials here!" +
  "You should treat it as compromised revoke or rotate it." +
  `If you need help with it, describe the problem without the secret, or email ${SUPPORT}.`;

/* ------------------------------- junk -------------------------------- */

const PATTERNS = [
  ["greeting", /^(hi|hello|hey|heya|hiya|yo|howdy|kia ora|good (morning|afternoon|evening|day)|g'?day)( there| bot| claude)?$/],
  ["thanks", /^(thanks|thank you|thankyou|thx|ty|cheers|ta|ok|okay|k|cool|great|nice|awesome|got it|perfect)( (so much|heaps|mate|a lot))?$/],
  ["test", /^(test(ing)?|this is a test|just testing|test(ing)? ?\d*|ping|hello world|foo|bar|foobar|lorem ipsum.*)$/],
  ["gibberish", /^(asdf\w*|qwer\w*|zxcv\w*|jkl;?\w*|sdf\w*|hjk\w*|aoeu\w*|xyz)$/],
  ["human", new RegExp(
    "^(" +
      "((can|could|may) i |i (want|need|would like|'d like) to |let me |how (do|can) i )?(talk|speak|chat) (to|with) (a |an |the )?(human|person|real person|someone|somebody|staff|support|support team|agent|operator)" +
      "|((how (do|can) i |i need to |i want to )?(contact|email|e-mail|reach|get in touch with) (nesi |reannz )?(support|the support team|support team|helpdesk|help desk|a human|someone|a person|staff))" +
      "|(human|agent|operator|real person|live agent|helpdesk|help desk|support)" +
    ")( please| pls)?$"
  )],
  ["identity", new RegExp(
    "^(" +
      "(who|what) are you" +
      "|what (can|do) you do" +
      "|what (is|'s) this( bot| thing| tool| chat)?" +
      "|are you (a |an )?(bot|robot|human|person|real|ai|llm|chatbot|chatgpt|gpt|claude|real person)" +
      "|what (model|llm|ai)( are you| is this| do you use| are you using)?" +
      "|help( me)?" +
      "|how (do i|does this|to) (use|work)( (you|this|it))?" +
    ")$"
  )],
  ["rude", new RegExp(
    "^(" +
      "(you('re| are)|ur|u r|this (bot |thing |assistant )?is|this) (so |really |fucking |bloody )?(useless|stupid|dumb|crap|shit|shite|garbage|rubbish|terrible|hopeless|pathetic|an idiot|a joke|trash)( (bot|ai|thing|assistant))?" +
      "|(stupid|useless|dumb|crap|shit|shite|rubbish|garbage|idiot|terrible) (bot|ai|thing|assistant|machine)" +
      "|(fuck|f\\*+k|screw|bugger) (you|off|this( bot| thing)?)" +
      "|(you|this|it) sucks?" +
      "|(fuck|shit|wtf|ffs|omfg|piss off|ugh+|bullshit|crap)" +
    ")$"
  )],
];

/** Lowercase, trim, drop leading/trailing punctuation, collapse spaces. */
export function normalise(question) {
  return String(question ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/[\s!?.,:;~*…'"`)(]+$/u, "")
    .replace(/^[\s!?.,:;~*…'"`)(]+/u, "")
    .replace(/\s+/g, " ");
}

/**
 * Classify `question` as junk, or null if it should go through normal retrieval.
 * @returns {"greeting"|"thanks"|"test"|"gibberish"|"human"|"identity"|"rude"|null}
 */
export function classifyJunk(question) {
  const t = normalise(question);
  if (!t) return "gibberish"; // only punctuation, e.g. "???" or "..."
  for (const [kind, re] of PATTERNS) if (re.test(t)) return kind;
  if (!/\p{L}/u.test(t)) return "gibberish"; // no letters in any script: "123", "#$%", "1 2 3" (single letters like "R" pass)
  if (/^(.)\1{3,}$/u.test(t.replace(/\s/g, ""))) return "gibberish"; // one char repeated 4+ times: "aaaaaa" (not "cc")
  return null;
}

/* ------------------------------ repeats ------------------------------ */

/**
 * True if `question` is the same as the user's previous message (after
 * normalise(), so only case/punctuation/whitespace differences). Exact only:
 * "and for GPUs?" style follow-ups must still reach retrieval. A repeat
 * almost always means the last answer didn't help, so re-running the same
 * retrieval and serving a near-identical answer is the worst response.
 */
export function isRepeatQuestion(question, history = []) {
  const t = normalise(question);
  if (!t) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") return normalise(history[i].content) === t;
  }
  return false;
}

export const REPEAT_REPLY =
  "Looks like my last answer didn't help. What's the exact command you ran and the error message you're seeing? " +
  `With that I can try again, or you can contact the support team: see [Contacting Support › What to include](https://docs.nesi.org.nz/Getting_Started/Getting_Help/Contacting_Support/#what-to-include).`;

const EXAMPLES = `For example: "How do I submit a GPU job?", "What storage quotas do I have?", or "How do I load Python?"`;

/** Canned reply for a junk class -- no retrieval, no LLM. */
export function junkReply(kind) {
  switch (kind) {
    case "thanks":
      return "You're welcome! Ask another question about REANNZ HPC or storage any time.";
    case "test":
      return `I'm working. Ask me a question about REANNZ HPC or storage and I'll answer from the support docs. ${EXAMPLES}`;
    case "greeting":
      return `Kia ora! I answer questions about REANNZ HPC and storage using the support docs. ${EXAMPLES}`;
    case "human":
      return `You can reach the support team at ${SUPPORT}. See [Contacting Support › What to include](https://docs.nesi.org.nz/Getting_Started/Getting_Help/Contacting_Support/#what-to-include) for what to put in your request so they can help sooner.`;
    case "identity":
      return `I'm an AI assistant that answers questions about REANNZ HPC and storage from the support docs at [docs.nesi.org.nz](https://docs.nesi.org.nz), with links to the pages I used. I can't see your account, jobs or files, and I can make mistakes, so for anything account-specific email ${SUPPORT}. ${EXAMPLES}`;
    case "rude":
      return `Thats nice. If you tell me more about what you are you're dealing with, I'll try again, or raise you concerns with the support team at ${SUPPORT}.`;
    default:
      return `I didn't catch a question there. I answer questions about REANNZ HPC and storage using the support docs. ${EXAMPLES}`;
  }
}
