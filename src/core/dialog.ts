// One keyboard owner across teleported dialogs. Restore the original page
// inertness, scroll state and focus when the last dialog closes.
type Dialog = { element: HTMLElement; overlay: HTMLElement; close: () => void; previous: HTMLElement | null }
const stack: Dialog[] = []
const inertBefore = new Map<HTMLElement, boolean>()
let overflowBefore = ''
const focusable = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
  .filter((e) => !e.matches(':disabled') && e.tabIndex >= 0 && e.getClientRects().length > 0 && !e.closest('[inert]'))
function focus(dialog: Dialog) { (focusable(dialog.element)[0] ?? dialog.element).focus() }
function sync() {
  const top = stack.at(-1)
  for (const child of [...document.body.children]) {
    if (!(child instanceof HTMLElement)) continue
    if (!inertBefore.has(child)) inertBefore.set(child, child.inert)
    child.inert = top ? child !== top.overlay : inertBefore.get(child)!
  }
  if (!top) {
    for (const [element, inert] of inertBefore) element.inert = inert
    inertBefore.clear()
    document.body.style.overflow = overflowBefore
  }
}
function keydown(event: KeyboardEvent) {
  const top = stack.at(-1)
  if (!top) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); top.close(); return }
  if (event.key !== 'Tab') return
  const items = focusable(top.element), first = items[0], last = items.at(-1)
  if (!first) { event.preventDefault(); top.element.focus(); return }
  if (!top.element.contains(document.activeElement) || event.shiftKey && document.activeElement === first) { event.preventDefault(); (event.shiftKey ? last! : first).focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function focusin(event: FocusEvent) {
  const top = stack.at(-1)
  if (top && !top.element.contains(event.target as Node)) focus(top)
}
export function ownDialog(element: HTMLElement, close: () => void): () => void {
  const overlay = element.parentElement!
  const entry: Dialog = { element, overlay, close, previous: document.activeElement instanceof HTMLElement ? document.activeElement : null }
  if (!stack.length) {
    overflowBefore = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin, true)
  }
  stack.push(entry)
  sync(); focus(entry)
  return () => {
    const index = stack.indexOf(entry)
    if (index < 0) return
    const wasTop = index === stack.length - 1
    stack.splice(index, 1); sync()
    if (!stack.length) {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin, true)
    }
    if (wasTop) {
      if (entry.previous?.isConnected && !entry.previous.closest('[inert]')) entry.previous.focus()
      else if (stack.length) focus(stack.at(-1)!)
    }
  }
}
