export const LAB_ZNN_HTTP: string
export const LAB_EVM_HTTP: string
export const EVM_READ_METHODS: readonly string[]
export function validateLabLabel(label: unknown): string
export function validateBridgeUrl(value: unknown): string
export function assertPageOrigin(actual: string, expected: string): void
export function assertWalletLab(config: { label: string; pageUrl: string }, fetchImpl?: typeof fetch): Promise<void>
export function forwardEvmRead(json: string, actualPage: string, expectedPage: string, fetchImpl?: typeof fetch): Promise<string>
export function createResultsDirectory(label: string, root?: string): string
