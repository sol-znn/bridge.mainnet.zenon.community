export type ForkRpc = (method: string, params?: unknown[]) => Promise<unknown>
export function localForkUrl(value: string): string
export function forkRpc(endpoint: string, fetchImpl?: typeof fetch): ForkRpc
export function assertEthereumFork(rpc: ForkRpc, version: string): Promise<{ clientVersion: string; forkBlockNumber: number }>
