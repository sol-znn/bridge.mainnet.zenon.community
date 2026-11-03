import type { ChildProcess } from 'node:child_process'
export interface MarionetteClient {
  send(name: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}
export function readMarionettePort(profile: string): number | null
export function launchFirefox(options: { profile: string; port?: number; prefs?: Record<string, unknown> }): Promise<{ proc: ChildProcess; client: MarionetteClient }>
export function connectMarionette(port: number): Promise<MarionetteClient>
