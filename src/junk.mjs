// Cheap pre-retrieval gates, kept separate from worker.js so they're
// unit-testable without a running Worker. Each one answers with a canned
// reply before any embed/search/rerank/LLM call.
//
// containsSecret(): pasted private keys / tokens. Checked FIRST, on the
// question and on history, so the secret never reaches Workers AI.
//
// classifyJunk(): greetings, thanks, goodbyes, "test", keyboard mash, asking
// for a human, questions about the bot itself, "that didn't help" feedback,
// and messages that are nothing but abuse. Would otherwise cost an embed +
// Vectorize query + rerank + status fetch only to hit the "not in the docs"
// fallback (or, worse, weakly match some chunk and get a grounded answer
// about something random).
//
// Deliberately conservative: every pattern is anchored to the WHOLE message,
// so "test" is junk but "test job on milan" is not, "stupid bot" is rude but
// "why the hell is my job pending" still gets answered, and there is no
// "short means junk" rule -- "R", "git", "ssh" are real questions. Callers
// should also skip classifyJunk() when liveLookup() finds a known app/term
// name (never containsSecret()). scripts/eval-junk.test.mjs is mostly
// near-miss real questions that must get through -- add to it when widening
// a pattern.

const SUPPORT = "[support@nesi.org.nz](mailto:support@nesi.org.nz)";
const WHAT_TO_INCLUDE = "[Contacting Support › What to include](https://docs.nesi.org.nz/Getting_Started/Getting_Help/Contacting_Support/#what-to-include)";

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
  "You shouldn't paste credentials here! " +
  "Treat it as compromised: revoke or rotate it. " +
  `If you need help with it, describe the problem without the secret, or email ${SUPPORT}.`;

/* ------------------------------- junk -------------------------------- */

// Small helper so the patterns below read as word lists, not regex soup.
const any = (...alts) => `(?:${alts.join("|")})`;
const opt = (...alts) => `(?: ${any(...alts)})?`;
// Compile with apostrophes removed, matching normalise(): "that's" -> "thats".
export const rx = (src) => new RegExp(String(src).replace(/'\??/g, ""));

const ADDRESSEE = opt("there", "bot", "claude", "all", "everyone", "team", "folks", "mate", "guys", "y'all", "again", "friend");
const POLITE = opt("please", "pls", "plz", "thanks", "thank you");

const GREETING = any(
  "hi", "hello", "hey", "heya", "hiya", "hullo", "yo", "howdy", "sup", "wassup", "what's up", "whats up", "greetings",
  "kia ora", "kia ora koutou", "tena koe", "tēnā koe", "tena koutou", "tēnā koutou", "morena", "mōrena",
  "good (?:morning|afternoon|evening|day)", "morning", "afternoon", "evening", "g'?day", "gday",
  "bonjour", "hola", "aloha", "namaste",
);
const THANKS = any(
  "thanks", "thank you", "thankyou", "thank u", "thanku", "thx", "ty", "tysm", "tyvm", "cheers", "ta",
  "many thanks", "much appreciated", "appreciate it", "appreciated", "kia ora rawa atu", "nga mihi", "ngā mihi",
);
const ACK = any(
  "ok", "okay", "k", "kk", "okie", "okey", "alright", "all right", "right", "sure", "cool", "great", "nice", "nice one",
  "awesome", "perfect", "brilliant", "excellent", "sweet", "sweet as", "legend", "got it", "gotcha", "understood",
  "noted", "fair enough", "good to know", "makes sense", "that makes sense", "that helps", "that helped",
  "that worked", "it worked", "that's it", "no worries", "all good", "nvm", "nevermind", "never mind", "np",
);
const BYE = any(
  "bye", "goodbye", "good bye", "bye bye", "see ya", "see you", "see you later", "cya", "later", "laters",
  "ka kite", "ka kite ano", "ka kite anō", "hei konā", "hei kona", "good night", "goodnight", "night", "that's all", "that is all", "done",
);

const PATTERNS = [
  // "hi", "hey hey", "kia ora koutou", "hello there", "good morning team"
  ["greeting", rx(`^${GREETING}(?: ${GREETING})*${ADDRESSEE}$`)],
  // "thanks", "ok thanks", "great, cheers mate", "thanks heaps", "that worked thanks"
  ["thanks", rx(
    `^(?:${ACK} )*${THANKS}${opt("so much", "heaps", "mate", "a lot", "very much", "again", "for that", "for the help", "for your help", "anyway")}${opt("bye", "cya", "cheers")}$` +
    `|^${ACK}(?: ${ACK})*${opt(...["thanks", "cheers", "ta"])}$`
  )],
  // "bye", "ok bye", "thanks bye", "ka kite anō"
  ["goodbye", rx(`^(?:${ACK} |${THANKS} )*${BYE}${ADDRESSEE}$`)],
  // "test", "testing 1 2 3", "is this working", "are you there", "can you hear me"
  ["test", rx("^" + any(
    "test(?:ing)?(?: (?:test(?:ing)?|\\d+))*", "tst", "this is (?:a|just a) test", "just (?:a )?test(?:ing)?", "test (?:message|question|query|msg)",
    "ping", "pong", "hello world", "foo", "bar", "foobar", "baz", "lorem ipsum.*", "mic check", "check",
    "(?:is|does) (?:this|it) (?:thing )?(?:work|working|on)", "are you (?:there|working|alive|awake|online|on|available|up)",
    "(?:is )?(?:any(?:one|body)|some(?:one|body)) (?:there|home|here)", "can you hear me", "you there", "still there",
  ) + "$")],
  // keyboard mash (explicit) -- see also the generic rules in classifyJunk()
  ["gibberish", rx("^" + any(
    "asdf\\w*", "qwer\\w*", "zxcv\\w*", "jkl;?\\w*", "sdf\\w*", "hjk\\w*", "aoeu\\w*", "xyz",
    "lol+", "lmao+", "rofl", "ha(?:ha)+h?", "he(?:he)+", "hm+", "um+", "uh+", "er+m*", "meh", "idk", "oops", "whatever", "blah(?: blah)*",
  ) + "$")],
  ["human", rx("^" + any(
    `(?:(?:can|could|may) i |i (?:want|need|would like) to |i'd like to |let me |how (?:do|can) i |is it possible to )?(?:talk|speak|chat) (?:to|with) (?:a |an |the |some )?(?:real |actual |live )?(?:human|person|someone|somebody|staff|staff member|support|support team|agent|operator|people|humans)`,
    `(?:how (?:do|can) i |i need to |i want to |where (?:do|can) i )?(?:contact|email|e-mail|reach|get in touch with|message) (?:nesi |reannz )?(?:support|the support team|support team|helpdesk|help desk|a human|someone|a person|staff|you|you guys|the team)`,
    `(?:i (?:want|need) |get me |give me |is there |are there any )(?:a |an )?(?:real |actual |live )?(?:human|person|people|humans|agent|operator)(?: i can talk to)?`,
    `(?:what(?: is|'s) (?:the |your )?)?(?:support|helpdesk|help desk|contact) (?:email|e-mail|address|email address|details|info|number|phone number)`,
    `contact(?: us| details| info)?`,
    `(?:how (?:do|can) i )?(?:open|raise|log|submit|create|file|lodge) (?:a )?(?:support )?(?:ticket|request|case)`,
    "human", "agent", "operator", "real person", "live agent", "helpdesk", "help desk", "support",
  ) + POLITE + "$")],
  ["identity", rx("^" + any(
    "(?:who|what) are you", "who(?:'s| is) this", "what are you for", "what(?: is|'s) your (?:name|purpose)", "your name",
    "who (?:made|built|created|wrote|runs) (?:you|this)", "are you (?:sentient|alive|conscious)",
    "what (?:can|do) you (?:do|know)", "what (?:can|should) i ask(?: you)?", "what questions can you answer",
    "what (?:can|do) you help (?:me )?with", "can you help(?: me)?", "help", "help me", "help please", "i need (?:some )?help",
    "what(?: is|'s) this(?: bot| thing| tool| chat| site| for)?",
    "are you (?:a |an )?(?:bot|robot|human|person|real|ai|llm|chatbot|chatgpt|gpt|claude|real person|machine)",
    "what (?:model|llm|ai)(?: are you| is this| do you use| are you using| powers you)?",
    "how (?:do i|does this|to|do you) (?:use|work)(?: (?:you|this|it))?",
    "commands", "menu", "options", "about", "start", "get started", "getting started",
  ) + POLITE + "$")],
  // Flirting with the bot: "i love you", "are you single", "marry me". Deflected politely.
  ["flirty", rx("^" + any(
    "i (?:love|luv|adore|like|fancy) (?:you|u)(?: so much| a lot)?", "love (?:you|u|ya)", "ily", "i think i(?:'m| am) in love(?: with you)?",
    "(?:do|could|would) you (?:love|like|fancy) me", "(?:will|would) you (?:marry|date|go out with) me", "marry me", "date me", "kiss me",
    "(?:will|would) you be my (?:girlfriend|boyfriend|partner|valentine|wife|husband)", "be my (?:girlfriend|boyfriend|partner|valentine)",
    "are you (?:single|seeing anyone|taken|married)", "(?:can|could) (?:i|we) (?:date|go on a date|go out)(?: with you)?",
    "(?:wanna|want to) (?:go out|date|get a drink|grab a drink|get dinner)(?: with me)?",
    "(?:you(?:'re| are)|ur|u r) (?:so |really |very )?(?:cute|hot|sexy|gorgeous|beautiful|handsome|adorable|lovely|sweet|charming|the best|perfect|my type)",
    "(?:hey |hi )?(?:cutie|sexy|gorgeous|handsome|babe|baby|sweetheart|darling|honey)", "send nudes",
    "what are you wearing",
  ) + "$")],
  // Feedback on the last answer, not abuse: "that's wrong", "that didn't work"
  ["unhelpful", rx("^" + any(
    "(?:that(?:'s| is)|this is|it(?:'s| is)|you(?:'re| are)) (?:wrong|incorrect|not (?:right|correct|helpful|it|what i asked|what i meant)|unhelpful|no help)",
    "wrong(?: answer)?", "incorrect", "not helpful", "unhelpful", "not useful", "no help", "not what i (?:asked|meant|wanted)",
    "(?:that|it|this) (?:didn't|did not|doesn't|does not|won't) (?:help|work)", "didn't (?:help|work)", "doesn't (?:help|work)",
    "still (?:not working|doesn't work|broken|stuck)", "(?:that|it) still (?:doesn't|does not) work", "nope(?: that's wrong)?",
    "no(?:,)? that(?:'s| is) (?:wrong|not (?:it|right))", "try again", "you didn't answer(?: my question)?", "that's not an answer",
  ) + "$")],
  ["rude", rx("^" + any(
    "(?:you(?:'re| are)|ur|u r|this (?:bot |thing |assistant |chat )?is|this|it(?:'s| is)) (?:so |really |fucking |bloody |completely |totally |utterly )?(?:useless|stupid|dumb|crap|shit|shite|garbage|rubbish|terrible|hopeless|pathetic|an idiot|a joke|trash|awful|the worst|worthless|pointless|braindead|brain dead|a waste of time)(?: (?:bot|ai|thing|assistant))?",
    "(?:stupid|useless|dumb|crap|shit|shite|rubbish|garbage|idiot|terrible|bad|worst|pointless|awful) (?:bot|ai|thing|assistant|machine|answer|response|reply)(?: ever)?",
    "(?:fuck|f\\*+k|screw|bugger|sod) (?:you|off|this|it|this bot|this thing)",
    "(?:you|this|it) (?:sucks?|blows|is shit)", "shut up", "go away", "get lost", "piss off",
    "idiot", "moron", "useless", "pointless", "rubbish", "garbage",
    "fuck", "fucks? sake", "shit", "wtf+", "ffs", "omfg", "ugh+", "argh+", "bullshit", "crap", "damn(?: it)?", "for fucks? sake",
  ) + "$")],
];

export function normalise(question) {
  return String(question ?? "")
    .toLowerCase()
    .replace(/[’‘']/g, "") // "didn't" and "didnt" alike -- patterns are compiled the same way (rx)
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, " ")
    .replace(/(^|\s)(?:[:;=][-']?[)(\]\[dpo3/\\|*]+|<3|\^_?\^|xd)(?=\s|$)/gu, " ") // :) ;-) :D <3 ^_^ xD
    .trim()
    .replace(/[\s!?.,:;~*…'"`)(]+$/u, "")
    .replace(/^[\s!?.,:;~*…'"`)(]+/u, "")
    .replace(/[!?.,;:…]+(?=\s)/gu, "")
    .replace(/\s+/g, " ");
}

/**
 * Classify `question` as junk, or null if it should go through normal retrieval.
 * @returns {"greeting"|"thanks"|"goodbye"|"test"|"gibberish"|"human"|"identity"|"unhelpful"|"rude"|null}
 */
export function classifyJunk(question) {
  const t = normalise(question);
  if (!t) return "gibberish"; // only punctuation/emoji, e.g. "???" or "👍"
  for (const [kind, re] of PATTERNS) if (re.test(t)) return kind;
  if (!/\p{L}/u.test(t)) return "gibberish"; // no letters in any script: "123", "#$%", "1 2 3" (single letters like "R" pass)
  const squashed = t.replace(/\s/g, "");
  if (/^(.)\1{3,}$/u.test(squashed)) return "gibberish"; // one char repeated 4+ times: "aaaaaa" (not "cc")
  if (/^(.{2,4})\1{2,}$/u.test(squashed)) return "gibberish"; // a short chunk repeated 3+ times: "asdasdasd", "jkljkljkl"
  // A run along the middle or bottom keyboard row: "sdfghjkl", "lkjhgfds", "zxcvbnm". Not the
  // top row -- it spells real words ("pipette", "torque", "typewriter"); top-row mash like
  // "qwerty..." is in the explicit list above. Middle row needs 8+ ("flask", "alfalfa").
  if (/^(?:[asdfghjkl]{8,}|[zxcvbnm]{6,})$/.test(squashed)) return "gibberish";
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
  `With that I can try again, or you can contact the support team: see ${WHAT_TO_INCLUDE}.`;

/* ------------------------------ replies ------------------------------ */

// Example questions shown in canned replies, two at a time at random. Each
// one was checked to retrieve the right page with a high rerank score
// (2026-11-10) -- re-check before adding more: an example the bot then
// refuses ("What storage quotas do I have?" scored 0.28) is worse than none.
export const EXAMPLE_QUESTIONS = [
  "How do I submit a GPU job?",
  "How do I submit a job array?",
  "How do I transfer files with Globus?",
  "How do I recover a file I deleted?",
  "How do I start JupyterLab in OnDemand?",
  "When are files in nobackup deleted?",
  "How do I check how efficient my job was?",
  "How do I check my storage quota?",
  "How do I see which software modules are available?",
  "What is Freezer?",
  "How do I renew my compute allocation?",
  "How do I apply for a new project?",
  "How do I run RStudio on OnDemand?",
  "How do I use a Python virtual environment?",
];

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

/** `For example: "A" or "B"` with two different random questions. */
export function examples(rand = Math.random) {
  const i = Math.floor(rand() * EXAMPLE_QUESTIONS.length) % EXAMPLE_QUESTIONS.length;
  let j = Math.floor(rand() * (EXAMPLE_QUESTIONS.length - 1)) % (EXAMPLE_QUESTIONS.length - 1);
  if (j >= i) j++; // distinct from i
  return `For example: "${EXAMPLE_QUESTIONS[i]}" or "${EXAMPLE_QUESTIONS[j]}"`;
}

// Each entry is a function of `ex` (the examples line) so every variant can
// place it where it reads best, or leave it out.
const REPLIES = {
  greeting: [
    (ex) => `Kia ora! I answer questions about REANNZ HPC and storage using the support docs. ${ex}`,
    (ex) => `Hi! Ask me anything about REANNZ HPC and I'll answer from the support docs. ${ex}`,
    (ex) => `Kia ora, what can I help you with? I know the REANNZ HPC and storage support docs. ${ex}`,
    (ex) => `Hello! I can help with REANNZ HPC and storage questions. ${ex}`,
  ],
  thanks: [
    () => "You're welcome! Ask another question about REANNZ HPC any time.",
    () => "No worries! Let me know if anything else comes up.",
    () => "Glad to help. Ask away if you have another question.",
    () => "Ka pai! I'm here if you need anything else.",
  ],
  goodbye: [
    () => "Ka kite anō! Come back any time you have a question.",
    () => "Bye for now! I'm here whenever you need help with REANNZ HPC.",
    () => `See you later! If something comes up that I can't answer, you can always email ${SUPPORT}.`,
    () => `Wait! Don't go.`,
  ],
  test: [
    (ex) => `I'm working. Ask me a question about REANNZ HPC and I'll answer from the support docs. ${ex}`,
    (ex) => `Yep, I'm here and listening. ${ex}`,
    (ex) => `Loud and clear! Try a real question. ${ex}`,
    (ex) => `Test received, everything's working. ${ex}`,
  ],
  gibberish: [
    (ex) => `I didn't catch a question there. I answer questions about REANNZ HPC support docs. ${ex}`,
    (ex) => `Sorry, I'm not sure what you mean. ${ex}`,
    () => `Indeed.`,
    () => `ok.`,
    (ex) => `I'm not sure how to help with that. Try asking about REANNZ HPC. ${ex}`,
  ],
  human: [
    () => `You can reach the support team at ${SUPPORT}. See ${WHAT_TO_INCLUDE} for what to put in your request so they can help sooner.`,
    () => `The support team is at ${SUPPORT}. They can help sooner if your email has the details listed in ${WHAT_TO_INCLUDE}.`,
    () => `Email ${SUPPORT} to reach a person. ${WHAT_TO_INCLUDE} lists what to include so they can help quickly.`,
  ],
  identity: [
    (ex) => `I'm an AI assistant that answers questions about REANNZ HPC and storage from the support docs at [docs.nesi.org.nz](https://docs.nesi.org.nz), with links to the pages I used. I can't see your account, jobs or files, and I can make mistakes, so for anything account-specific email ${SUPPORT}. ${ex}`,
    (ex) => `I'm an AI assistant for the REANNZ HPC support docs: ask a question and I'll answer from [docs.nesi.org.nz](https://docs.nesi.org.nz) with links to the relevant pages. I can't see your account or jobs, so for those email ${SUPPORT}. ${ex}`,
    (ex) => `I answer REANNZ HPC and storage questions using the support docs, and link the pages I used. I'm an AI, so I can get things wrong, and I can't see your account, jobs or files. ${ex}`,
  ],
  unhelpful: [
    () => `Sorry about that. What's the exact command you ran and the error message you're seeing? With that I can try again, or you can email ${SUPPORT} (see ${WHAT_TO_INCLUDE}).`,
    () => `Sorry that didn't help. Could you tell me more: what you're trying to do, the command you ran, and any error message? Or contact the support team at ${SUPPORT}.`,
    () => `Sorry, let's try again. Rephrasing with the tool name or the exact error message usually helps. The support team at ${SUPPORT} can also take a look.`,
  ],
  flirty: [
    (ex) => `That's sweet, but my heart belongs to Slurm.`,
    (ex) => `I'm flattered, but I'm strictly a docs assistant.`,
    (ex) => `I'm an AI, so I'll have to decline.`,
    (ex) => `Let's keep things professional.`,
  ],
  rude: [
    () => `That's nice. If you tell me more about what you're dealing with, I'll try again, or raise your concerns with the support team at ${SUPPORT}.`,
    () => `ok. If you tell me the command, tool or error message you're dealing with, I'll try again, or you can email the support team at ${SUPPORT}.`,
    () => `Fair enough. Tell me what you're trying to do and I'll have another go, or email ${SUPPORT} to reach a person.`,
  ],
};

/** Canned reply for a junk class -- no retrieval, no LLM. `rand` is injectable for tests. */
export function junkReply(kind, rand = Math.random) {
  const variants = REPLIES[kind] ?? REPLIES.gibberish;
  return pick(variants, rand)(examples(rand));
}

/** Every variant for a kind, with fixed examples -- for tests. */
export function allJunkReplies(kind) {
  return (REPLIES[kind] ?? []).map((f) => f(examples(() => 0)));
}
