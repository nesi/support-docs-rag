// Path validation for read_nesi_doc, kept separate from worker.js so it's
// unit-testable without a running Worker. Guards a fetch to raw GitHub
// content — must reject traversal and anything outside docs/*.md.
export function isValidDocPath(path) {
  return /^[\w\-/.]+\.md$/.test(path) && !path.includes("..");
}
