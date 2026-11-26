/**
 * Splits a streamed answer into separate chat bubbles by emitting a `break`
 * between parts, at fixed structural points -- not wherever the model
 * decides (the chat model is unreliable at following formatting rules):
 *
 *   1. the short answer
 *   2. a fenced code block (e.g. a Slurm script)        <- break before & after
 *   3. the trailing "More: [Page › Section](url)" line  <- break before
 *
 * A separate SSE event rather than a marker in the text, so clients that
 * don't know about it (an older deployed docs widget) just ignore the event
 * and render one bubble as before. MCP/non-streaming paths don't use this.
 *
 * Sits after createSbatchStreamFilter(), which emits each code block as one
 * whole piece starting with ```, so code blocks are easy to spot here. Prose
 * still streams token by token; only a few characters at the start of a line
 * that might be "More:" are held back until it's clear either way.
 * Whitespace between parts is dropped, so no bubble starts or ends blank.
 */

// What a "More:" line may start with (lowercased, after leading spaces/tabs).
const MORE_STARTS = ["more:", "**more:**", "**more**:"];

export function createBreakStreamFilter(emitText, emitBreak) {
  let visible = false; // current bubble has visible text
  let pending = false; // a break is due before the next visible text
  let atLineStart = true;
  let hold = "";

  function write(text) {
    if (pending) {
      const t = text.replace(/^\s+/, "");
      if (!t) return; // whitespace between parts: drop
      pending = false;
      if (visible) {
        emitBreak();
        visible = false;
      }
      text = t;
    } else if (!visible) {
      text = text.replace(/^\s+/, "");
      if (!text) return;
    }
    emitText(text);
    visible = true;
  }

  function pushProse(piece) {
    let buf = hold + piece;
    hold = "";
    while (buf) {
      if (atLineStart) {
        const rest = buf.replace(/^[ \t]*/, "").toLowerCase();
        if (!rest) { hold = buf; return; } // only indentation so far
        if (MORE_STARTS.some((m) => rest.startsWith(m))) {
          pending = true;
        } else if (MORE_STARTS.some((m) => m.startsWith(rest))) {
          hold = buf; // could still become "More:" -- wait for more text
          return;
        }
        atLineStart = false;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) { write(buf); return; }
      write(buf.slice(0, nl + 1));
      buf = buf.slice(nl + 1);
      atLineStart = true;
    }
  }

  function push(piece) {
    if (!piece) return;
    if (piece.startsWith("```")) {
      if (hold) { const h = hold; hold = ""; atLineStart = false; write(h); }
      pending = true;
      write(piece);
      pending = true;
      atLineStart = false;
      return;
    }
    pushProse(piece);
  }

  function flush() {
    if (hold) write(hold);
    hold = "";
  }

  return { push, flush };
}
