import { CHANNEL, errorMessage, isMethod, type Reply } from './protocol';

// This bridge is not a permission boundary: every supported page is allowed by design.
// The background separately authenticates extension-only account management messages.
let inFlight = 0;
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin || location.origin === 'null') return;
  const message = event.data;
  if (message?.channel !== CHANNEL || message.kind !== 'request' ||
      typeof message.id !== 'string' || message.id.length > 100) return;
  const respond = (reply: Reply) => window.postMessage({
    channel: CHANNEL, kind: 'response', id: message.id, ...reply,
  }, location.origin);
  if (!isMethod(message.method)) {
    respond({ ok: false, error: 'Unsupported NIP-07 method' });
    return;
  }
  if (inFlight >= 100) {
    respond({ ok: false, error: 'Too many concurrent requests; retry later' });
    return;
  }
  inFlight++;
  void Promise.resolve().then(() => chrome.runtime.sendMessage({
    channel: CHANNEL, kind: 'request', method: message.method, params: message.params,
  })).then((reply: Reply | undefined) => {
    respond(reply ?? { ok: false, error: 'The extension did not respond' });
  }).catch((error: unknown) => {
    respond({ ok: false, error: `${errorMessage(error)}. Reload this page if the extension was updated` });
  }).finally(() => { inFlight--; });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.channel === CHANNEL && message.kind === 'accountChanged') {
    window.postMessage({ channel: CHANNEL, kind: 'accountChanged', pubkey: message.pubkey }, location.origin);
  }
});
