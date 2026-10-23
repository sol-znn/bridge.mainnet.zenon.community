<script setup lang="ts">
// Status is an icon plus a word, never colour alone (RULES.md section 3).
import { computed } from 'vue'
import { CheckCircle2, Clock, Loader2, CircleDot, XCircle, MinusCircle } from '@lucide/vue'
import type { Tone } from '../core/status.ts'

const props = defineProps<{ tone: Tone; label: string; spin?: boolean }>()
const ICONS = { ok: CheckCircle2, wait: Clock, warn: CircleDot, danger: XCircle, dim: MinusCircle }
const icon = computed(() => (props.spin ? Loader2 : ICONS[props.tone]))
</script>

<template>
  <span class="chip" :class="'chip-' + tone">
    <component :is="icon" :size="13" :class="{ spin }" />
    {{ label }}
  </span>
</template>
