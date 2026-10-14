// Amounts are bigint base units everywhere; these are the only conversions to
// and from text. No floating point touches a balance.

export function formatUnits(value: bigint, decimals: number, maxFraction = 6): string {
  const neg = value < 0n
  let v = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  v %= base
  let frac = decimals ? v.toString().padStart(decimals, '0') : ''
  if (frac.length > maxFraction) frac = frac.slice(0, maxFraction)
  frac = frac.replace(/0+$/, '')
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${w}${frac ? '.' + frac : ''}`
}

/** Plain digits, no grouping: for an input field. */
export function unitsToInput(value: bigint, decimals: number): string {
  return formatUnits(value, decimals, decimals).replace(/,/g, '')
}

/** null when the text is not an amount, or has more decimals than the token. */
export function parseUnits(text: string, decimals: number): bigint | null {
  // Inputs use a decimal dot and no grouping separators. Never guess whether
  // a comma means a decimal or a thousands separator in the user's locale.
  const t = text.trim()
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || t.length > 256) return null
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return null
  const [w, f = ''] = t.split('.')
  if (f.length > decimals) return null
  const value = BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return value < (1n << 256n) ? value : null
}

export function shorten(id: string, head = 6, tail = 4): string {
  if (!id || id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

/** "45s", "12m", "1h 20m", "3d 4h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** "mm:ss" or "h:mm:ss", for a countdown that ticks. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const d = now - unixSeconds
  if (d < 5) return 'now'
  return `${duration(d)} ago`
}

export function percent(numerator: number, denominator: number, digits = 2): string {
  if (!denominator) return '0%'
  return `${((numerator / denominator) * 100).toFixed(digits).replace(/\.?0+$/, '')}%`
}

/** A dollar estimate: cents above a dollar, four significant figures below. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${Number(value.toPrecision(4))}`
}
