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
