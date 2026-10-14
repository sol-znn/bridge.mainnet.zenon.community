/** A local guard refused the request before a wallet was invoked. */
export class NotSubmittedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotSubmittedError'
  }
}

// What a failure is called on screen: a few plain words, never a library's
// dump. viem wraps a wallet's answer in layers and prints the request, the
// arguments and its own version; a toast shows only what the user can act on.

export interface UserMessage {
  text: string
  /** The user said no. Not an error, and shown quietly. */
  declined: boolean
}

interface Layer {
  code?: unknown
  name?: unknown
  message?: unknown
  shortMessage?: unknown
  details?: unknown
  reason?: unknown
  declined?: unknown
  cause?: unknown
}

function layers(err: unknown): Layer[] {
  const out: Layer[] = []
  for (let e = err as Layer | undefined, i = 0; e && typeof e === 'object' && i < 8; e = e.cause as Layer | undefined, i++) out.push(e)
  return out
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const MAX = 80

function tidy(text: string): string {
  let t = text.split('\n')[0].trim().replace(/\s+/g, ' ')
  if (t.length > MAX) t = `${t.slice(0, MAX - 1).trimEnd()}…`
  return t ? t[0].toUpperCase() + t.slice(1) : 'Something went wrong'
}

export function userMessage(err: unknown): UserMessage {
  const chain = layers(err)
  const all = chain.map((l) => `${str(l.name)} ${str(l.shortMessage)} ${str(l.details)} ${str(l.message)}`).join(' ') || String(err)
  const codes = chain.map((l) => l.code).filter((c): c is number => typeof c === 'number')
  const has = (c: number) => codes.includes(c)
  const say = (text: string, declined = false): UserMessage => ({ text, declined })

  if (has(4001) || chain.some((l) => l.declined === true) || /user (rejected|denied|cancel)|rejected the request|request rejected|declined in/i.test(all)) {
    return say('Declined in wallet', true)
  }
  // Syrius holds a site off for 30 s after a declined or closed approval.
  if (has(-32005)) return say('Syrius is busy. Try again in 30 seconds.')
  if (has(-32002) || /already pending/i.test(all)) return say('Open your wallet to continue')
  if (has(4902) || /unrecognized chain|chain .*not (been )?added/i.test(all)) return say('Add this network in your wallet')
  if (has(4100)) return say('Reconnect your wallet')
  if (has(4900) || has(4901)) return say('Wallet is disconnected')
  if (/insufficient funds|exceeds the balance of the account/i.test(all)) return say('Not enough funds for gas')
  if (/nonce too low|replacement transaction underpriced|already known/i.test(all)) return say('A transaction is already pending')
  if (/timed? ?out|took too long/i.test(all)) return say('Timed out. Check the original operation before retrying.')
  if (/failed to fetch|http request failed|network ?error|load failed/i.test(all)) return say('Network error. Check the original operation before retrying.')

  // A contract's own reason is the most useful thing a revert has.
  const reason = chain.map((l) => str(l.reason)).find(Boolean)
  if (reason) return say(tidy(reason))
  const quoted = /reverted with the following reason:\s*(.+)/i.exec(chain.map((l) => str(l.message)).join('\n'))?.[1]
  if (quoted) return say(tidy(quoted))
  if (/revert/i.test(all)) return say('Transaction would fail')

  const first = chain[0]
  return say(tidy(str(first?.shortMessage) || str(first?.message) || str(first?.details) || (typeof err === 'string' ? err : '')))
}
