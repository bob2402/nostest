import { finalizeEvent, type EventTemplate } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { fromHex, type Account } from './store';
import type { Method, Params } from './protocol';

const MAX_TEXT_BYTES = 1024 * 1024;
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_TEXT_BYTES) {
    throw new Error(`${label} must be a string no larger than 1 MiB`);
  }
  return value;
}
function peerKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Peer public key must be 64 hexadecimal characters');
  }
  return value.toLowerCase();
}
function eventTemplate(value: unknown): EventTemplate {
  if (!value || typeof value !== 'object') throw new Error('Invalid event');
  const event = value as Record<string, unknown>;
  if (!Number.isSafeInteger(event.created_at) || (event.created_at as number) < 0 ||
      !Number.isInteger(event.kind) || (event.kind as number) < 0 || (event.kind as number) > 65535 ||
      !Array.isArray(event.tags) || event.tags.length > 10000 ||
      !event.tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))) {
    throw new Error('Invalid event timestamp, kind or tags');
  }
  const clean: EventTemplate = {
    created_at: event.created_at as number,
    kind: event.kind as number,
    tags: event.tags.map((tag) => [...tag]),
    content: text(event.content, 'Event content'),
  };
  text(JSON.stringify(clean), 'Event');
  // Ignore caller-supplied pubkey, id and signature. Always sign as the active account.
  return clean;
}

export async function perform(method: Method, params: Params, account: Account): Promise<unknown> {
  if (method === 'getPublicKey' || method === 'peekPublicKey') return account.pubkey;
  // Legacy NIP-07 compatibility: the extension does not choose or contact relays.
  if (method === 'getRelays') return {};
  const secret = fromHex(account.secret);
  try {
    if (method === 'signEvent') return finalizeEvent(eventTemplate(params.event), secret);
    const peer = peerKey(params.peer);
    if (method === 'nip04.encrypt') return await nip04.encrypt(secret, peer, text(params.plaintext, 'Plaintext'));
    if (method === 'nip04.decrypt') return await nip04.decrypt(secret, peer, text(params.ciphertext, 'Ciphertext'));
    const key = nip44.v2.utils.getConversationKey(secret, peer);
    try {
      if (method === 'nip44.encrypt') return nip44.v2.encrypt(text(params.plaintext, 'Plaintext'), key);
      if (method === 'nip44.decrypt') return nip44.v2.decrypt(text(params.ciphertext, 'Ciphertext'), key);
      throw new Error('Unsupported method');
    } finally {
      key.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}
