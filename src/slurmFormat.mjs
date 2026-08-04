// Post-processing for #SBATCH script blocks in model output

import { getModuleDefault } from "./liveData.mjs";

const SBATCH_SHORT_FLAGS = {
  "-J": "--job-name", "-A": "--account", "-t": "--time", "-n": "--ntasks", "-N": "--nodes",
  "-c": "--cpus-per-task", "-p": "--partition", "-o": "--output", "-e": "--error",
  "-a": "--array", "-d": "--dependency", "-D": "--chdir", "-w": "--nodelist", "-x": "--exclude",
  "-m": "--distribution",
};

function expandShortFlag(line) {
  const m = line.match(/^(#SBATCH\s+)(-[A-Za-z])\s+(\S.*)$/);
  const long = m && SBATCH_SHORT_FLAGS[m[2]];
  return long ? `${m[1]}${long} ${m[3]}` : line;
}

function normalizeSlurmBlock(body) {
  let lines = body.split("\n").map(expandShortFlag);

  const sbatchLineRe = /^(#SBATCH\s+)(--[\w-]+)[ \t]*=?[ \t]*(\S.*)$/;
  let maxFlagLen = 0;
  const matches = lines.map((line) => {
    const m = line.match(sbatchLineRe);
    if (m) maxFlagLen = Math.max(maxFlagLen, m[2].length);
    return m;
  });
  const PAD = 4; // minimum gap after the longest flag
  lines = matches.map((m, i) => {
    if (!m) return lines[i];
    const [, prefix, flag, rest] = m;
    return `${prefix}${flag}${" ".repeat(maxFlagLen - flag.length + PAD)}${rest}`;
  });

  const isSbatch = (l) => /^#SBATCH\b/.test(l);
  const isShebang = (l) => /^#!/.test(l);
  const isModuleLoad = (l) => /^module load\b/.test(l);

  // module purge immediately before the first module load, if it's missing.
  const firstLoad = lines.findIndex(isModuleLoad);
  if (firstLoad !== -1 && !lines.slice(0, firstLoad).some((l) => /^module purge\b/.test(l))) {
    lines.splice(firstLoad, 0, "module purge");
  }

  // Exactly one blank line after the shebang, and after the #SBATCH block.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const next = lines[i + 1];
    if (next === undefined) continue;
    const needsBlank = (isShebang(lines[i]) && !isShebang(next)) || (isSbatch(lines[i]) && !isSbatch(next));
    if (needsBlank && next.trim() !== "") out.push("");
    else if (!needsBlank && lines[i].trim() === "" && next.trim() === "") continue; // collapse repeated blanks
  }
  return out.join("\n");
}

/** Realigns every fenced code block containing #SBATCH lines in `text`; leaves other blocks untouched. */
export function realignSbatchBlocks(text) {
  return text.replace(/(```[^\n]*\n)([\s\S]*?)(\n```)/g, (whole, open, body, close) => {
    if (!/^#SBATCH\b/m.test(body)) return whole; // not a Slurm script block
    return open + normalizeSlurmBlock(body) + close;
  });
}

/** Fills in the module system's default version on any bare `module load NAME` line missing one. */
export async function fillMissingModuleVersions(text) {
  const lines = text.split("\n");
  const moduleLoadRe = /^(\s*module load\s+)([\w+.-]+)(?:\/\S+)?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(moduleLoadRe);
    if (!m) continue;
    const version = await getModuleDefault(m[2]);
    if (version) lines[i] = `${m[1]}${m[2]}/${version}`;
  }
  return lines.join("\n");
}

/**
 * Wraps a streaming token emitter so #SBATCH formatting still applies without
 * losing the streamed feel for everything else: plain text is forwarded as
 * soon as it arrives, but a fenced code block (``` ... ```) is buffered in
 * full before emitting, since flag alignment needs to see the whole block to
 * compute the column width. `emit` is called with each ready-to-send chunk,
 * in order; `push` may be awaited per incoming chunk, `flush` drains
 * whatever's left (e.g. an unterminated block) when the source stream ends.
 */
export function createSbatchStreamFilter(emit) {
  let buf = "";
  let inFence = false;

  async function push(chunk) {
    buf += chunk;
    while (true) {
      if (!inFence) {
        const idx = buf.indexOf("```");
        if (idx === -1) {
          // A trailing 1-2 backtick run might be the start of a fence split
          // across chunks -- hold it back until we know either way.
          const trailingTicks = buf.match(/`*$/)[0].length;
          const safeLen = buf.length - trailingTicks;
          if (safeLen > 0) {
            emit(buf.slice(0, safeLen));
            buf = buf.slice(safeLen);
          }
          return;
        }
        if (idx > 0) {
          emit(buf.slice(0, idx));
          buf = buf.slice(idx);
        }
        inFence = true;
      } else {
        const closeIdx = buf.indexOf("```", 3);
        if (closeIdx === -1) return; // block still arriving
        const end = closeIdx + 3;
        const block = buf.slice(0, end);
        emit(realignSbatchBlocks(await fillMissingModuleVersions(block)));
        buf = buf.slice(end);
        inFence = false;
      }
    }
  }

  function flush() {
    if (buf) emit(buf); // stream ended mid-block (e.g. truncated) -- emit raw rather than drop it
    buf = "";
  }

  return { push, flush };
}
