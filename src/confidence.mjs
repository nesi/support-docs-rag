export function isConfidentResponse(sources, threshold = 0.2) {
  return Boolean(sources?.length && typeof sources[0]?.rerankScore === "number" && sources[0].rerankScore >= threshold);
}
