// Exact-height consensus checks for isolated lab diagnostics. No wallet data.
/** @param {unknown[]} samples @param {number} height */
export function agreesAtHeight(samples, height) {
  if (samples.length !== 5 || !Number.isSafeInteger(height) || height < 1) return false
  let hash
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') return false
    const m = sample
    if (m.chainIdentifier !== 322 || m.height !== height || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(m.hash)) return false
    if (hash && hash.toLowerCase() !== m.hash.toLowerCase()) return false
    hash = m.hash
  }
  return true
}

/** Production alone does not make a freshly started lab ready for writes. */
export function readyAtFrontier(anchor, nodes) {
  if (!anchor || anchor.chainIdentifier !== 322 || !Number.isSafeInteger(anchor.height) || anchor.height < 20) return false
  if (nodes.length !== 5 || nodes.some((node) => !node || node.error || node.chainId !== 322 || !Number.isSafeInteger(node.height) || node.height < Math.max(20, anchor.height - 3))) return false
  return agreesAtHeight(nodes.map((node) => node.momentum), anchor.height - 3)
}
