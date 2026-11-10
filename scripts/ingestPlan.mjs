/**
 * Incremental ingest planning. Pure: no network, no fs.
 *
 * Each chunk carries `metadata.hash`, a digest of exactly what gets embedded
 * and stored (embed model + capped embedText + metadata). Diffing current
 * chunks against the hashes already in Vectorize gives:
 *   - upsert: new ids, or ids whose hash changed
 *   - delete: ids in the index that no chunk produces anymore (removed pages,
 *             or the tail `path#k` ids left when a page shrinks)
 *
 * Why hashes, not timestamps: CI clones with --depth 1, so file mtimes are
 * checkout time and there's no history for commit dates. Timestamps also
 * can't see deletions. Hashes need no stored state beyond the index itself.
 */

import { createHash } from "node:crypto";

// Refuse to delete more than this share of the index in one run. A broken
// checkout (wrong path, empty docs dir) must not wipe the index.
export const MAX_DELETE_FRACTION = 0.5;

export function chunkHash(chunk, embedModel) {
  const { hash: _ignored, ...metadata } = chunk.metadata;
  return createHash("sha256")
    .update(JSON.stringify({ model: embedModel, embedText: chunk.embedText, metadata }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * @param chunks   current chunks, each with metadata.hash already set
 * @param existing Map of id -> stored hash (undefined if the vector has none)
 * @param opts     { full, allowMassDelete }
 * @returns { upsert: chunk[], delete: id[], unchanged: number }
 */
export function planIngest(chunks, existing, { full = false, allowMassDelete = false } = {}) {
  const currentIds = new Set(chunks.map((c) => c.id));
  const upsert = full ? chunks : chunks.filter((c) => existing.get(c.id) !== c.metadata.hash);
  const del = [...existing.keys()].filter((id) => !currentIds.has(id));

  if (!allowMassDelete && existing.size > 0) {
    if (chunks.length === 0) {
      throw new Error("No chunks produced; refusing to delete the whole index. Check the docs path.");
    }
    if (del.length / existing.size > MAX_DELETE_FRACTION) {
      throw new Error(
        `Would delete ${del.length}/${existing.size} vectors (> ${MAX_DELETE_FRACTION * 100}%). ` +
        "Check the docs path, or pass --allow-mass-delete.",
      );
    }
  }

  return { upsert, delete: del, unchanged: chunks.length - upsert.length };
}
