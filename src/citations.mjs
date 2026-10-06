/**
 * Normalise model citations to the `[n]` form the UI and MCP sources list use.
 *
 * Some models (nemotron) ignore the prompt's `[n]` rule and emit OpenAI
 * browsing-style markers: `【1†L13-L16】`, `【4†source】`, `【2】`. The UI only
 * links `[n]`, so these showed as raw text. Rewritten here, server-side, so
 * chat, MCP and /api/chat clients all get the same form.
 */

const MARKER = /【\s*(\d+)\s*(?:†[^】]*)?】/g;
// Longest marker we'll hold back waiting for `】`. Real ones are ~15 chars;
// past this, `【` is treated as plain text so nothing gets swallowed.
const MAX_MARKER = 40;

export function normalizeCitations(text) {
  return text.replace(MARKER, "[$1]");
}

/** Full-answer form (MCP): normalise and drop leading blank lines. */
export function cleanAnswer(text) {
  return normalizeCitations(text).replace(/^\s+/, "");
}

/**
 * Streaming form. A marker can split across chunks (`【1†L1` + `-L2】`), so
 * text from an unclosed `【` is held until `】` arrives or MAX_MARKER passes.
 * Also drops leading whitespace before the first visible text.
 */
export function createCitationStreamFilter(emit) {
  let buf = "";
  let started = false;

  async function out(text) {
    if (!started) {
      text = text.replace(/^\s+/, "");
      if (!text) return;
      started = true;
    }
    await emit(text);
  }

  async function push(chunk) {
    buf += chunk;
    const open = buf.lastIndexOf("【");
    if (open !== -1 && !buf.includes("】", open) && buf.length - open < MAX_MARKER) {
      if (open > 0) await out(normalizeCitations(buf.slice(0, open)));
      buf = buf.slice(open);
      return;
    }
    const text = normalizeCitations(buf);
    buf = "";
    await out(text);
  }

  async function flush() {
    if (buf) await out(normalizeCitations(buf));
    buf = "";
  }

  return { push, flush };
}
