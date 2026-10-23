<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, Info, XCircle, Gift, X } from '@lucide/vue'
const props = defineProps<{ tone: 'warn' | 'danger' | 'wait' | 'new'; dismissable?: boolean }>()
const emit = defineEmits<{ dismiss: [] }>()
const ICONS = { warn: AlertTriangle, danger: XCircle, wait: Info, new: Gift }
const icon = computed(() => ICONS[props.tone])
</script>

<template>
  <div class="banner slide-down" :class="'banner-' + tone" role="status">
    <component :is="icon" :size="18" class="mt-0.5 shrink-0" />
    <div class="min-w-0 flex-1 text-sm leading-relaxed"><slot /></div>
    <slot name="action" />
    <button v-if="dismissable" class="btn btn-ghost btn-sm -my-1 !px-2" aria-label="Dismiss" @click="emit('dismiss')"><X :size="16" /></button>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border-radius: calc(var(--radius) * 1.5);
  border: 1px solid;
}
.banner-warn {
  color: var(--warn);
  background: var(--warn-bg);
  border-color: color-mix(in srgb, var(--warn) 30%, transparent);
}
.banner-danger {
  color: var(--danger);
  background: var(--danger-bg);
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
}
.banner-wait {
  color: var(--wait);
  background: var(--wait-bg);
  border-color: color-mix(in srgb, var(--wait) 25%, transparent);
}
.banner-new {
  color: var(--new-ink);
  background: var(--new-bg);
  border-color: color-mix(in srgb, var(--new) 30%, transparent);
}
.banner :deep(strong) {
  color: var(--fg);
  font-weight: 600;
}
</style>
