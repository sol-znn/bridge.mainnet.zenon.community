<script setup lang="ts">
import { computed, ref } from 'vue'
import { operations, type Operation } from '../state/operations.ts'
import { api, node } from '../state/zenon.ts'
import { readClient } from '../evm/client.ts'
import { walletForReads } from '../state/evm.ts'
import { nodeContext } from '../state/bridge.ts'
import { refreshActivity } from '../state/activity.ts'
import { toastError } from '../state/toasts.ts'

const unresolved = computed(() => operations.entries.filter((r) => ['awaiting-wallet', 'unknown', 'submitted', 'mismatch'].includes(r.state)))
const hashes = ref<Record<string, string>>({})
const busy = ref<Record<string, boolean>>({})
const messages = ref<Record<string, string>>({})
async function reconcile(operation: Operation) {
  const context = nodeContext(), a = api.value
  const current = () => context === nodeContext() && a === api.value
  busy.value[operation.id] = true
  try {
    const { reconcileEvm, reconcileZenon } = await import('../state/reconcile.ts')
    const hash = operation.hash ?? hashes.value[operation.id]?.trim()
    if (operation.state === 'mismatch') throw new Error('The wallet reported different transaction fields. Preserve the original evidence for wallet support; this operation cannot be automatically cleared.')
    if (operation.source === 'zenon') {
      if (operation.chainId !== node.chainId || node.conn !== 'open') throw new Error('Select the original Zenon network before reconciliation')
      const resolved = await reconcileZenon(a, operation, hash, current)
      messages.value[operation.id] = resolved ? 'Original transaction confirmed' : 'Original transaction is not confirmed yet. Keep its exact identity and check again.'
    } else {
      const resolved = await reconcileEvm(readClient(operation.chainId, walletForReads()), operation, hash, current)
      messages.value[operation.id] = resolved ? 'Original receipt verified' : 'Original transaction is not confirmed yet. Keep its exact identity and check again.'
    }
    await refreshActivity()
  } catch (error) { toastError(error) }
  finally { busy.value[operation.id] = false }
}
</script>

<template>
  <section v-if="operations.error || unresolved.length" class="panel p-4" aria-label="Original operation recovery" data-testid="operation-recovery">
    <h2 class="font-semibold">Original operations</h2>
    <p class="mt-1 text-sm text-soft">An unresolved submission pauses further sends from its account and chain. Reconcile the original transaction; do not submit a replacement.</p>
    <p v-if="operations.error" class="mt-2 text-sm text-danger">{{ operations.error }}</p>
    <div v-for="operation in unresolved" :key="operation.id" class="mt-3 grid min-w-0 gap-2 border-t border-line pt-3">
      <div class="flex flex-wrap gap-2 text-sm"><span>{{ operation.kind }}</span><span>{{ operation.source }} chain {{ operation.chainId }}</span><span>{{ operation.state }}</span></div>
      <code v-if="operation.hash" class="break-all text-xs">{{ operation.hash }}</code>
      <label v-else class="grid gap-1 text-sm"><span>Exact transaction hash from the original wallet operation</span><input v-model="hashes[operation.id]" class="field mono text-xs" autocomplete="off" spellcheck="false" :disabled="operation.state === 'awaiting-wallet' || busy[operation.id]" /></label>
      <button class="btn btn-sm justify-self-start" :disabled="operation.state === 'awaiting-wallet' || operation.state === 'mismatch' || busy[operation.id]" @click="reconcile(operation)">{{ busy[operation.id] ? 'Checking original transaction' : 'Reconcile original transaction' }}</button>
      <p v-if="operation.state === 'mismatch'" class="text-sm text-danger">The response differs from the original intent. Keep the evidence for wallet support.</p>
      <p v-if="messages[operation.id]" class="text-sm text-soft" role="status">{{ messages[operation.id] }}</p>
    </div>
  </section>
</template>
