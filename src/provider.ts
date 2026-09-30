import { CHANNEL, type Method, type Params } from './protocol';

type Listener = (pubkey: string) => void;
function install() {
  const target = window as { nostr?: unknown };
  if (target.nostr) return;
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new Set<Listener>();
  function call(method: Method, params: Params = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // getRandomValues also works on plain HTTP development pages.
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('NosTest request timed out. Check the extension and reload this page'));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      try {
        window.postMessage({ channel: CHANNEL, kind: 'request', id, method, params }, location.origin);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL) return;
    if (message.kind === 'accountChanged' && typeof message.pubkey === 'string') {
      for (const listener of listeners) {
        try { listener(message.pubkey); } catch (error) { console.error('NosTest accountChanged listener failed', error); }
      }
      window.dispatchEvent(new CustomEvent('nostr:accountChanged', { detail: { pubkey: message.pubkey } }));
      return;
    }
    if (message.kind !== 'response' || typeof message.ok !== 'boolean') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(`NosTest: ${message.error || 'Request failed'}`));
  });
  window.addEventListener('pagehide', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('NosTest request cancelled because the page is leaving'));
    }
    pending.clear();
  });
  target.nostr = {
    getPublicKey: () => call('getPublicKey'),
    peekPublicKey: () => call('peekPublicKey'),
    getRelays: () => call('getRelays'),
    signEvent: (event: unknown) => call('signEvent', { event }),
    nip04: {
      encrypt: (peer: string, plaintext: string) => call('nip04.encrypt', { peer, plaintext }),
      decrypt: (peer: string, ciphertext: string) => call('nip04.decrypt', { peer, ciphertext }),
    },
    nip44: {
      encrypt: (peer: string, plaintext: string) => call('nip44.encrypt', { peer, plaintext }),
      decrypt: (peer: string, ciphertext: string) => call('nip44.decrypt', { peer, ciphertext }),
    },
    // Optional NosTest extension; not part of the NIP-07 standard.
    on: (event: string, listener: Listener) => {
      if (event === 'accountChanged' && typeof listener === 'function') listeners.add(listener);
    },
    off: (event: string, listener: Listener) => {
      if (event === 'accountChanged') listeners.delete(listener);
    },
  };
  window.dispatchEvent(new Event('nostr:ready'));
}
install();
