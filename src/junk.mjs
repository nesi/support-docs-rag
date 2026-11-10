// Cheap pre-retrieval gate for "test"/"hi"/keyboard-mash questions, kept
// separate from worker.js so it's unit-testable without a running Worker.
// Junk would otherwise cost an embed + Vectorize query + rerank + status
// fetch only to hit the "not in the docs" fallback (or, worse, weakly match
// some chunk and get a grounded answer about something random).
//
// Deliberately conservative: every pattern is anchored to the WHOLE question,
// so "test" is junk but "test job on milan" is not, and there is no
// "short means junk" rule -- "R", "git", "ssh" are real questions. Callers
// should also skip the gate when liveLookup() finds a known app/term name.

const PATTERNS = [
  ["greeting", /^(hi|hello|hey|heya|hiya|yo|howdy|kia ora|good (morning|afternoon|evening|day)|g'?day)( there| bot| claude)?$/],
  ["thanks", /^(thanks|thank you|thankyou|thx|ty|cheers|ta|ok|okay|k|cool|great|nice|awesome|got it|perfect)( (so much|heaps|mate|a lot))?$/],
  ["test", /^(test(ing)?|this is a test|just testing|test(ing)? ?\d*|ping|hello world|foo|bar|foobar|lorem ipsum.*)$/],
  ["gibberish", /^(asdf\w*|qwer\w*|zxcv\w*|jkl;?\w*|sdf\w*|hjk\w*|aoeu\w*|xyz)$/],
];

/**
 * Classify `question` as junk, or null if it should go through normal retrieval.
 * @returns {"greeting"|"thanks"|"test"|"gibberish"|null}
 */
export function classifyJunk(question) {
  // Normalise: lowercase, trim, drop trailing punctuation/emoji-ish noise, collapse spaces.
  const t = String(question ?? "")
    .toLowerCase()
    .trim()
    .replace(/[\s!?.,:;~*…'"`)(]+$/u, "")
    .replace(/^[\s!?.,:;~*…'"`)(]+/u, "")
    .replace(/\s+/g, " ");

  if (!t) return "gibberish"; // only punctuation, e.g. "???" or "..."
  for (const [kind, re] of PATTERNS) if (re.test(t)) return kind;
  if (!/\p{L}/u.test(t)) return "gibberish"; // no letters in any script: "123", "#$%", "1 2 3" (single letters like "R" pass)
  if (/^(.)\1{3,}$/u.test(t.replace(/\s/g, ""))) return "gibberish"; // one char repeated 4+ times: "aaaaaa" (not "cc")
  return null;
}

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
    default:
      return `I didn't catch a question there. I answer questions about REANNZ HPC and storage using the support docs. ${EXAMPLES}`;
  }
}
