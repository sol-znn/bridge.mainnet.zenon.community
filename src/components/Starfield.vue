<script setup lang="ts">
// The page background: a field of small stars drifting slowly outward from
// the centre, as if the page were travelling into it. Stars are Zenon green
// and quasar blue at varying brightness.
//
// Each star has a place in a cone ahead of the viewer and a depth. Depth
// shrinks a little every frame, so the star's projection moves away from the
// centre and grows; one that leaves the screen starts again far away. The
// speed is low on purpose: a star takes about two minutes to cross.
//
// The pointer is a lamp. Around it the drifting stars brighten, and a second,
// denser layer of distant stars that is otherwise invisible shows through.
// Nothing is drawn around a star; it only gets brighter.
//
// Every star carries one brightness value, drawn once: most are faint, a few
// are very bright. It sets how bright the star is on its own and how far the
// lamp can raise it, and it stays with the star when the star starts again,
// so the field keeps the same highs and lows. The generator is seeded, so it
// is also the same field on every visit.
//
// Reduced motion keeps a static frame. Chain activity remains available as text.
import { onBeforeUnmount, onMounted, ref } from 'vue'

const canvas = ref<HTMLCanvasElement | null>(null)

interface Star {
  x: number
  y: number
  z: number
  hue: number
  light: number
  size: number
  twinkle: number
  /** 0 to 1, fixed for the star's life: its brightness. Skewed, so few are bright. */
  power: number
}

/** A distant star: fixed on the screen but for a very slow outward creep, and
    seen only near the pointer. */
interface Far {
  /** Direction from the centre and distance along it, in pixels. */
  a: number
  d: number
  hue: number
  size: number
  power: number
  twinkle: number
}

// Green around the ZNN mark's hue, blue around quasar's.
const GREEN = 142
const BLUE = 216
const DEPTH = 1
const NEAR = 0.08
/** Depth lost per second: a full crossing takes DEPTH / SPEED seconds. */
const SPEED = 0.0085
/** Stars within this many pixels of the pointer are lit. */
const REACH = 230
/** Outward creep of the distant layer, as a fraction of its distance per second. */
const FAR_CREEP = 0.004

let raf = 0
let stars: Star[] = []
let far: Far[] = []
let w = 0
let h = 0
let dpr = 1
let last = 0
let motion: MediaQueryList | null = null
// The pointer, and how lit its surroundings are (eases to 0 when it leaves).
let mx = -1e4
let my = -1e4
let lit = 0
let litTarget = 0

function onMove(e: PointerEvent) {
  mx = e.clientX
  my = e.clientY
  litTarget = 1
}
function onLeave() {
  litTarget = 0
}

// mulberry32: small, fast, and the same sequence for the same seed.
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = seeded(0x5a4e4e)

function spawn(z: number): Star {
  const green = rand() < 0.55
  return {
    x: (rand() * 2 - 1) * 1.4,
    y: (rand() * 2 - 1) * 1.4,
    z,
    hue: (green ? GREEN : BLUE) + (rand() * 16 - 8),
    light: 55 + rand() * 30,
    size: 0.5 + rand() * 0.9,
    twinkle: rand() * Math.PI * 2,
    power: rand() ** 2,
  }
}

function spawnFar(reach: number): Far {
  return {
    a: rand() * Math.PI * 2,
    // The square root spreads them evenly over the disc.
    d: Math.sqrt(rand()) * reach,
    hue: (rand() < 0.5 ? GREEN : BLUE) + (rand() * 20 - 10),
    size: 0.35 + rand() * 0.75,
    power: rand() ** 3,
    twinkle: rand() * Math.PI * 2,
  }
}

function resize() {
  const c = canvas.value
  if (!c) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  w = window.innerWidth
  h = window.innerHeight
  c.width = Math.round(w * dpr)
  c.height = Math.round(h * dpr)
  // About one star per 5,500 px², within bounds a phone and a 4K screen both draw easily.
  const want = Math.max(120, Math.min(420, Math.round((w * h) / 5500)))
  while (stars.length < want) stars.push(spawn(NEAR + rand() * (DEPTH - NEAR)))
  stars.length = want
  // The distant layer is several times denser: it is only ever seen in the
  // small disc around the pointer.
  const wantFar = Math.max(500, Math.min(2600, Math.round((w * h) / 700)))
  const reach = Math.hypot(w, h) / 2
  far = Array.from({ length: wantFar }, () => spawnFar(reach))
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
}

function frame(now: number) {
  raf = motion?.matches ? 0 : requestAnimationFrame(frame)
  const c = canvas.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  // A tab left in the background comes back with one long gap; treat it as a frame.
  const dt = motion?.matches ? 0 : Math.min(0.05, (now - last) / 1000 || 0)
  if (motion?.matches) now = 0
  last = now
  const set = document.documentElement.getAttribute('data-theme')
  const light = set === 'light' || (!set && matchMedia('(prefers-color-scheme: light)').matches)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2
  const cy = h * 0.42
  const scale = Math.max(w, h) * 0.5
  lit += (litTarget - lit) * Math.min(1, dt * 6)
  const reach = Math.hypot(w, h) / 2 + 20
  for (let i = 0; i < far.length; i++) {
    const f = far[i]
    f.d += f.d * FAR_CREEP * dt
    // A new place, the same star: its colour, size and brightness stay.
    if (f.d > reach) {
      f.a = rand() * Math.PI * 2
      f.d = rand() * 30
    }
    if (lit < 0.01) continue
    const px = cx + Math.cos(f.a) * f.d
    const py = cy + Math.sin(f.a) * f.d
    const dist = Math.hypot(px - mx, py - my)
    if (dist >= REACH) continue
    const glow = (1 - dist / REACH) ** 2 * lit
    const flicker = 0.8 + 0.2 * Math.sin(now / 700 + f.twinkle)
    const alpha = glow * (0.12 + 0.88 * f.power) * flicker * (light ? 0.7 : 1)
    dot(ctx, px, py, f.size, `hsl(${f.hue} ${light ? 75 : 90}% ${light ? 32 : 62 + f.power * 26}% / ${alpha.toFixed(3)})`)
  }
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]
    s.z -= SPEED * dt
    const px = cx + (s.x / s.z) * scale * NEAR * 4
    const py = cy + (s.y / s.z) * scale * NEAR * 4
    if (s.z <= NEAR || px < -20 || px > w + 20 || py < -20 || py > h + 20) {
      s.x = (rand() * 2 - 1) * 1.4
      s.y = (rand() * 2 - 1) * 1.4
      s.z = DEPTH
      continue
    }
    // Far stars are faint and small; they brighten as they come.
    const near = 1 - (s.z - NEAR) / (DEPTH - NEAR)
    const fadeIn = Math.min(1, (DEPTH - s.z) / 0.08)
    const flicker = 0.85 + 0.15 * Math.sin(now / 900 + s.twinkle)
    const dist = Math.hypot(px - mx, py - my)
    const glow = dist < REACH ? (1 - dist / REACH) ** 2 * lit : 0
    const bright = 0.14 + 0.86 * s.power
    const boost = glow * bright
    const alpha = Math.min(1, bright * (0.4 + near * 0.6) * fadeIn * flicker * (light ? 0.6 : 1) + boost)
    const r = s.size * (0.6 + near * 1.5)
    const lightness = (light ? s.light - 30 : s.light) + boost * (light ? -12 : 22)
    dot(ctx, px, py, r, `hsl(${s.hue} ${light ? 70 : 85}% ${lightness}% / ${alpha.toFixed(3)})`)
  }
}

function restartMotion() {
  cancelAnimationFrame(raf)
  last = 0
  frame(performance.now())
}

onMounted(() => {
  motion = matchMedia('(prefers-reduced-motion: reduce)')
  motion.addEventListener('change', restartMotion)
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', onMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  motion?.removeEventListener('change', restartMotion)
  window.removeEventListener('resize', resize)
  window.removeEventListener('pointermove', onMove)
  document.documentElement.removeEventListener('pointerleave', onLeave)
})
</script>

<template>
  <canvas ref="canvas" class="starfield" aria-hidden="true" />
</template>

<style scoped>
.starfield {
  position: fixed;
  inset: 0;
  z-index: -1;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
}
</style>
