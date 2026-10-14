import type { Page } from '../znn/api.ts'

/** Bounded independent reads; a failed read never becomes an empty result. */
export async function mapLimit<T, R>(items: readonly T[], read: (item: T) => Promise<R>, concurrency = 4): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid read concurrency')
  const results: R[] = new Array(items.length)
  let next = 0, failed = false
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await read(items[index]!) } catch (error) { failed = true; throw error }
    }
  }))
  return results
}

/** Complete bounded history or an explicit error; never present a partial page as complete. */
export async function allPages<T>(read: (index: number, size: number) => Promise<Page<T>>, current: () => boolean = () => true, size = 100): Promise<T[]> {
  const list: T[] = []
  let expected: number | undefined
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('Invalid history page size')
  for (let index = 0; index < 100; index++) {
    if (!current()) throw new Error('Read context changed')
    const page = await read(index, size)
    if (!current()) throw new Error('Read context changed')
    if (!Number.isSafeInteger(page.count) || page.count < 0 || !Array.isArray(page.list) || page.list.length > size || page.count < page.list.length) throw new Error('Malformed history page')
    if (expected !== undefined && page.count !== expected) throw new Error('History changed while paging. Refresh to obtain a complete snapshot.')
    expected = page.count
    list.push(...page.list)
    if (list.length === expected) return list
    if (list.length > expected || page.list.length < size) throw new Error('History pagination is incomplete')
  }
  throw new Error('History exceeds the supported read limit; use the exact operation identity to recover pending transfers')
}
