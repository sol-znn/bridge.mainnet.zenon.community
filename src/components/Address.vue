<script setup lang="ts">
// An address or hash: shortened, full value on hover, copy, and an explorer
// link when there is one.
import { ref } from 'vue'
import { Copy, Check, ExternalLink } from '@lucide/vue'
import { shorten } from '../core/format.ts'

const props = withDefaults(defineProps<{ value: string; href?: string; head?: number; tail?: number; copy?: boolean }>(), {
  head: 6,
  tail: 4,
  copy: true,
})
const copied = ref(false)
async function doCopy() {
  try {
    await navigator.clipboard.writeText(props.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    /* clipboard blocked */
  }
}
</script>

<template>
  <span class="inline-flex items-center gap-1 align-middle">
    <a v-if="href" :href="href" target="_blank" rel="noopener" class="mono inline-flex items-center gap-1 hover:text-fg" :title="value">
      {{ shorten(value, head, tail) }}<ExternalLink :size="12" class="opacity-60" />
    </a>
    <span v-else class="mono" :title="value">{{ shorten(value, head, tail) }}</span>
    <button v-if="copy" type="button" class="copy-btn" :aria-label="'Copy ' + value" @click.stop="doCopy">
      <Check v-if="copied" :size="13" class="text-ok" /><Copy v-else :size="13" />
    </button>
  </span>
</template>

<style scoped>
.copy-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin: -6px -4px;
  border-radius: var(--radius);
  color: var(--dim);
  transition:
    color 150ms var(--ease),
    background 150ms var(--ease);
}
.copy-btn:hover {
  color: var(--fg);
  background: var(--raised);
}
</style>
