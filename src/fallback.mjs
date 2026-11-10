// The chat "nothing found" reply: used when retrieval isn't confident
// (top rerank score < MIN_RERANK_SCORE), so no LLM call is made. Picked at
// random from a few variants so repeat visitors don't get the identical
// sentence every time. Pure, so it's testable without a Worker.
//
// Status mentions stay to one short clause + link (see relevantStatusQuote()
// in worker.js): the detail lives on the status page, not in the chat.
// The MCP tool keeps its own fixed wording on purpose -- agents are better
// served by a consistent string.

const SUPPORT = "[support@nesi.org.nz](mailto:support@nesi.org.nz)";
const STATUS = "[status.nesi.org.nz](https://status.nesi.org.nz)";

const OPENERS = [
  "I couldn't find anything in the support docs that answers that.",
  "The support docs don't seem to cover that.",
  "I couldn't find an answer to that in the support docs.",
  "That doesn't look like something the support docs cover.",
];

const SUGGESTIONS = [
  `Try rephrasing with the specific service or tool name (e.g. Slurm, OnDemand, Globus), or contact ${SUPPORT}.`,
  `Rephrasing with the tool name or the exact error message might help, or you can email ${SUPPORT}.`,
  `If you add the software, command or error message involved I can try again, or you can ask the support team at ${SUPPORT}.`,
  `Try asking again with a bit more detail, like the tool name or error message, or contact ${SUPPORT}.`,
];

const RELEVANT_STATUS = [
  (q) => `There's a live status update that might explain it: "${q}". See ${STATUS} for details, or contact ${SUPPORT} if this doesn't look related.`,
  (q) => `It might be related to a current status update: "${q}". Check ${STATUS} for details, or email ${SUPPORT} if it doesn't look related.`,
  (q) => `There's a status update that could be the cause: "${q}". ${STATUS} has the details, and ${SUPPORT} can help if it's something else.`,
];

const UNRELATED_STATUS = [
  (i) => `There's also a live status update for a ${i} outage or maintenance right now, though it doesn't look related. Check ${STATUS} if you think otherwise, or contact ${SUPPORT}.`,
  (i) => `There is a ${i} outage or maintenance on ${STATUS} at the moment, but it doesn't look related. Contact ${SUPPORT} if you think it might be.`,
];

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length) % arr.length];

/**
 * @param {{quote?: string|null, status?: {indicator: string}|null}} ctx
 *   quote: short relevant status line from relevantStatusQuote(), if any;
 *   status: the reduced fetchStatus() result (null when all operational).
 * @param {() => number} rand injectable for tests
 */
export function noAnswerReply({ quote = null, status = null } = {}, rand = Math.random) {
  const opener = pick(OPENERS, rand);
  if (quote) return `${opener} ${pick(RELEVANT_STATUS, rand)(quote)}`;
  if (status) return `${opener} ${pick(UNRELATED_STATUS, rand)(status.indicator)}`;
  return `${opener} ${pick(SUGGESTIONS, rand)}`;
}

/** Every variant combination's pieces, for tests. */
export const NO_ANSWER_PARTS = { OPENERS, SUGGESTIONS, RELEVANT_STATUS, UNRELATED_STATUS };
