import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decode, npubEncode } from 'nostr-tools/nip19';
import type { PublicAccount, RequestLog, Snapshot } from './protocol';

export interface Account extends PublicAccount { secret: string }
export interface State {
  version: 1;
  accounts: Account[];
  activeId: string;
  enabled: boolean;
  nextNumber: number;
  logs: RequestLog[];
}
export interface Storage {
  read(): Promise<unknown>;
  write(state: State): Promise<void>;
}
export function fromHex(hex: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Invalid private key');
  return Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16));
}
function accountFromKey(key: Uint8Array, name: string): Account {
  const pubkey = getPublicKey(key);
  return {
    id: crypto.randomUUID(),
    name,
    pubkey,
    npub: npubEncode(pubkey),
    secret: Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    createdAt: Date.now(),
  };
}
export function newAccount(number: number): Account {
  const key = generateSecretKey();
  try {
    return accountFromKey(key, `Test Account ${String(number).padStart(2, '0')}`);
  } finally {
    key.fill(0);
  }
}
export function importAccount(nsec: unknown, name: string): Account {
  let key: Uint8Array | undefined;
  try {
    if (typeof nsec !== 'string' || !/^nsec1[a-z0-9]{58}$/i.test(nsec.trim())) {
      throw new Error('Invalid format');
    }
    const decoded = decode(nsec.trim());
    if (decoded.type !== 'nsec') throw new Error('Invalid key type');
    key = decoded.data;
    if (key.length !== 32) throw new Error('Invalid key length');
    // Public key derivation also rejects zero and out-of-range secret scalars.
    return accountFromKey(key, name);
  } catch {
    // Decoder errors can contain the input. Never return them to the UI or logs.
    throw new Error('Invalid nsec private key. Check the format and checksum');
  } finally {
    key?.fill(0);
  }
}
export function publicState(state: State): Snapshot {
  return {
    accounts: state.accounts.map(({ id, name, pubkey, npub, createdAt }) =>
      ({ id, name, pubkey, npub, createdAt })),
    activeId: state.activeId,
    enabled: state.enabled,
    logs: structuredClone(state.logs),
  };
}

// A single background writer serializes initialization, requests and account mutations.
// Rejections must not poison the queue. Failed transactions are never persisted.
export class Store {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private storage: Storage) {}

  transact<T>(operation: (state: State) => Promise<T> | T): Promise<T> {
    const next = this.tail.then(async () => {
      const stored = await this.storage.read();
      let state: State;
      if (stored === undefined) {
        const accounts = [1, 2, 3].map(newAccount);
        state = { version: 1, accounts, activeId: accounts[0].id, enabled: true, nextNumber: 4, logs: [] };
        // Persist initial keys even if the first incoming operation fails.
        await this.storage.write(state);
      } else {
        state = structuredClone(stored) as State;
        if (state?.version !== 1 || !Array.isArray(state.accounts) || !state.accounts.length ||
            !state.accounts.some((account) => account.id === state.activeId) ||
            typeof state.enabled !== 'boolean' || !Array.isArray(state.logs) ||
            !Number.isSafeInteger(state.nextNumber)) {
          throw new Error('Stored account data is corrupt or incompatible; private keys have not been reset');
        }
      }
      const result = await operation(state);
      await this.storage.write(state);
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
