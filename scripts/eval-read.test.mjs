import { isValidDocPath } from "../src/docPath.mjs";

const cases = [
  { path: "Batch_Computing/Slurm/Job_prioritisation.md", want: true },
  { path: "Getting_Started/index.md", want: true },
  { path: "../../etc/passwd", want: false },
  { path: "Batch_Computing/../../../etc/passwd.md", want: false },
  { path: "Batch_Computing/Slurm.txt", want: false }, // wrong extension
  { path: "Batch_Computing/Slurm.md.js", want: false },
  { path: "", want: false },
  { path: "..md", want: false },
  { path: "a b.md", want: false }, // space not in [\w\-/.]
  { path: "Batch_Computing/Sl%75rm.md", want: false }, // percent-encoding not in the allowed set
];

let fail = 0;
for (const { path, want } of cases) {
  const got = isValidDocPath(path);
  if (got !== want) {
    console.log(`FAIL isValidDocPath(${JSON.stringify(path)}): got ${got} want ${want}`);
    fail++;
  }
}

console.log(fail === 0 ? "docPath OK\n" : `${fail} failures\n`);
process.exit(fail === 0 ? 0 : 1);
