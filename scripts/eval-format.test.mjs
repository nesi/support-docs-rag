// Tests for the two answer-formatting passes applied to model output:
// Slurm script reflow (src/slurmFormat.mjs) and markdown -> HTML (public/render.mjs).
// Both are pure string transforms — no network, no Worker needed.

import { realignSbatchBlocks, createSbatchStreamFilter } from "../src/slurmFormat.mjs";
import { renderMarkdown } from "../public/render.mjs";

let fail = 0;
const check = (label, got, want) => {
  if (got !== want) {
    console.log(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    fail++;
  }
};

/* --------------------------- realignSbatchBlocks --------------------------- */

{
  const body = [
    "#!/bin/bash",
    "#SBATCH -J myjob",
    "#SBATCH --time=01:00:00",
    "#SBATCH -n 4",
    "",
    "module load python/3.11",
    "srun echo hello",
  ].join("\n");
  const text = "intro\n\n```bash\n" + body + "\n```\n\nend";
  const want =
    "intro\n\n```bash\n#!/bin/bash\n\n#SBATCH --job-name    myjob\n#SBATCH --time        01:00:00\n" +
    "#SBATCH --ntasks      4\n\nmodule purge\nmodule load python/3.11\nsrun echo hello\n```\n\nend";
  check("expands short flags, aligns values, inserts module purge", realignSbatchBlocks(text), want);
}

{
  // A value running straight into the next directive with no newline must be split back apart.
  const text = "```bash\n#!/bin/bash\n#SBATCH --mem=4G    #SBATCH --time=01:00:00\n```";
  const want = "```bash\n#!/bin/bash\n\n#SBATCH --mem     4G    \n#SBATCH --time    01:00:00\n```";
  check("splits directives run together on one line", realignSbatchBlocks(text), want);
}

{
  const text = "Here's a plain example:\n\n```bash\necho hello\nls -la\n```\n";
  check("leaves non-Slurm code blocks untouched", realignSbatchBlocks(text), text);
}

{
  const text = "no code blocks here at all, just prose about #SBATCH in passing.";
  check("leaves prose with no fenced block untouched", realignSbatchBlocks(text), text);
}

/* ------------------------- createSbatchStreamFilter ------------------------- */

async function runStream(text, chunkSize) {
  const emitted = [];
  const filter = createSbatchStreamFilter((chunk) => emitted.push(chunk));
  for (let i = 0; i < text.length; i += chunkSize) await filter.push(text.slice(i, i + chunkSize));
  filter.flush();
  return emitted.join("");
}

{
  // The whole point of streaming the filter is that it must reconstruct the exact
  // same output as the non-streaming realignSbatchBlocks, no matter how the
  // source text is chopped into chunks — including splits that land mid-```.
  const text =
    "Sure, here's a job script:\n\n```bash\n#!/bin/bash\n#SBATCH -J myjob\n#SBATCH --time=01:00:00\n" +
    "module load python/3.11\nsrun echo hi\n```\n\nLet me know if that works.";
  const baseline = realignSbatchBlocks(text);
  for (const chunkSize of [1, 2, 3, 5, 7, text.length]) {
    const got = await runStream(text, chunkSize);
    check(`stream(chunkSize=${chunkSize}) matches non-streaming baseline`, got, baseline);
  }
}

{
  // No closing fence ever arrives (e.g. truncated generation) -- flush() must
  // emit the raw buffered text rather than drop it, and realignSbatchBlocks
  // agrees the untouched text is the correct baseline (its regex needs a
  // closing ``` too, so it's also a no-op here).
  const text = "before\n```bash\n#SBATCH -J job\nmodule load python/3.11\n";
  check("realignSbatchBlocks no-ops on an unterminated block", realignSbatchBlocks(text), text);
  const got = await runStream(text, 4);
  check("stream flush() emits an unterminated block raw", got, text);
}

/* -------------------------------- renderMarkdown -------------------------------- */

check("escapes raw HTML", renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
check("renders a fenced code block", renderMarkdown("```js\nconst x = 1;\n```"), "<p><pre><code>const x = 1;\n</code></pre></p>");
check("renders inline code", renderMarkdown("Some `inline` code"), "<p>Some <code>inline</code> code</p>");
check("renders bold", renderMarkdown("**bold** text"), "<p><strong>bold</strong> text</p>");
check(
  "renders a link",
  renderMarkdown("[link](https://example.com)"),
  '<p><a href="https://example.com" target="_blank" rel="noopener">link</a></p>'
);
check(
  "renders a known citation and leaves an unknown one as literal text",
  renderMarkdown("See [1] and [2]", [{ url: "https://x.test/a", title: "Foo" }]),
  '<p>See <sup class="cite" onclick="window.open(\'https://x.test/a\',\'_blank\')" title="Foo">[1]</sup> and [2]</p>'
);
check("renders a list", renderMarkdown("- one\n- two"), "<ul><li>one</li>\n<li>two</li></ul>");
check(
  "wraps paragraphs and turns single newlines into <br>",
  renderMarkdown("para one\nline two\n\npara two"),
  "<p>para one<br>line two</p><p>para two</p>"
);

console.log(fail === 0 ? "eval-format OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
