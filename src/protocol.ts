export const CHANNEL = 'nostest:nip07:v1';
export const UI_CHANNEL = 'nostest:ui:v1';
export const METHODS = [
  'getPublicKey', 'peekPublicKey', 'getRelays', 'signEvent',
  'nip04.encrypt', 'nip04.decrypt', 'nip44.encrypt', 'nip44.decrypt',
] as const;
export type Method = typeof METHODS[number];
export const isMethod = (value: unknown): value is Method =>
  typeof value === 'string' && (METHODS as readonly string[]).includes(value);

export type Params = Record<string, unknown>;
export type Reply = { ok: true; result: unknown } | { ok: false; error: string };
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed';

export interface PublicAccount {
  id: string;
  name: string;
  pubkey: string;
  npub: string;
  createdAt: number;
}
export interface RequestLog {
  id: string;
  time: number;
  origin: string;
  method: Method;
  accountId: string;
  pubkey: string;
  ok: boolean;
}
export interface Snapshot {
  accounts: PublicAccount[];
  activeId: string;
  enabled: boolean;
  logs: RequestLog[];
}

export type AdminCommand =
  | { action: 'getState' }
  | { action: 'generate'; count: number }
  | { action: 'import'; nsec: string; name?: string }
  | { action: 'switch'; id: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'setEnabled'; enabled: boolean }
  | { action: 'clearLogs' };
