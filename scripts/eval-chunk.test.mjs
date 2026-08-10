// Tests for chunker.mjs's two id/url functions. Both are load-bearing:
// chunkId must stay deterministic (re-ingest overwrites vectors in place by
// id — see CLAUDE.md), and pathToUrl is also imported directly by
// eval-search.mjs/eval-ask.mjs to match expected pages against retrieved
// ones, so a regression here would silently corrupt eval scoring too.

import { chunkId, pathToUrl } from "./chunker.mjs";

let fail = 0;
const check = (label, got, want) => {
  if (got !== want) {
    console.log(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    fail++;
  }
};

/* --------------------------------- chunkId --------------------------------- */

check(
  "short path keeps the readable path#index form",
  chunkId("Batch_Computing/Slurm/Job_prioritisation.md", 0),
  "Batch_Computing/Slurm/Job_prioritisation#0"
);

check("index counter varies, path stays put", chunkId("Getting_Started/index.md", 3), "Getting_Started/index#3");

{
  const longPath =
    "A_very_long_directory_name_that_exceeds_the_vectorize_id_byte_limit_easily_by_a_lot/" +
    "Even_Longer_Subdirectory_Name_Goes_Right_Here/final_page_name.md";
  const id = chunkId(longPath, 3);

  if (Buffer.byteLength(id) > 64) {
    console.log(`FAIL long path id exceeds 64 bytes: ${Buffer.byteLength(id)} (${id})`);
    fail++;
  }
  check("long path id is deterministic across calls", chunkId(longPath, 3), id);
  if (chunkId(longPath, 4) === id) {
    console.log(`FAIL long path ids for different chunk indices must differ: ${id}`);
    fail++;
  }
  if (!/^[0-9a-f]{12}-.+#3$/.test(id)) {
    console.log(`FAIL long path id doesn't match hash-tail#index shape: ${id}`);
    fail++;
  }
}

/* -------------------------------- pathToUrl -------------------------------- */

check(
  "plain page path",
  pathToUrl("Batch_Computing/Slurm/Job_prioritisation.md"),
  "https://docs.nesi.org.nz/Batch_Computing/Slurm/Job_prioritisation/"
);
check(
  "nested index.md drops just the index segment",
  pathToUrl("Software/Available_Applications/index.md"),
  "https://docs.nesi.org.nz/Software/Available_Applications/"
);
check("top-level index.md resolves to the site root", pathToUrl("index.md"), "https://docs.nesi.org.nz/");
check(
  "backslashes are normalised to forward slashes",
  pathToUrl("Batch_Computing\\Slurm\\Job.md"),
  "https://docs.nesi.org.nz/Batch_Computing/Slurm/Job/"
);
check(
  "custom siteUrl is respected",
  pathToUrl("foo.md", "https://staging.example.com/"),
  "https://staging.example.com/foo/"
);

console.log(fail === 0 ? "eval-chunk OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
