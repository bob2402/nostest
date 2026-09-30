# NosTest

A Chromium Manifest V3 Nostr signer inspired by [nos2x](https://github.com/fiatjaf/nos2x). NosTest automatically approves supported [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) requests and manages multiple disposable test accounts.

**For testing only. Every HTTP/HTTPS website and embedded frame can request signatures and decrypt messages with the active account, without confirmation. Do not use these accounts for real identities, funds, private conversations or production authentication.**

**Upstream reference:** nos2x **2.5.2** (manifest version), commit [`014493f9602d0a3826ef3eab2bdd4901ee315cce`](https://github.com/fiatjaf/nos2x/commit/014493f9602d0a3826ef3eab2bdd4901ee315cce). See [the pinned baseline and upstream review guide](docs/upstream-nos2x.md) for source links, intentional differences and how to track future features and bug fixes.

## Load in Chrome or Edge

Requires Chrome/Chromium 111+ or a compatible Edge version. Firefox and Safari are not supported.

```sh
npm ci
npm run build
```

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this project's **`dist/`** directory, not the project root or `src/`.
4. Pin NosTest from the browser's extensions menu.
5. Disable other NIP-07 extensions such as nos2x to avoid competing `window.nostr` providers.
6. Reload any already-open Nostr websites. NosTest injects its provider on HTTP and HTTPS pages, not browser-internal pages, extension-store pages or `file://` URLs.

The account manager opens on first installation. It automatically creates three accounts and enables auto-approval. The toolbar badge reads `AUTO`; when paused, it reads `OFF`.

After changing source code, run `npm run build`, click the extension's **Reload** button on the extensions page, then reload client websites. Reloading preserves accounts; uninstalling does not. Keep using the same `dist/` path when loading the extension.

## Account management

- **Active account:** select an account or click **Next account**. The selection is global across tabs and frames; keys do not rotate automatically per request.
- **Generate accounts:** expand to create 1–20 accounts per batch, up to 100 total. Generation does not change the active account.
- **Import an nsec account:** expand, paste an `nsec1…` private key, optionally name it, acknowledge the risks and click **Import account**. Invalid keys and duplicates are rejected. The input is cleared after every submitted attempt. Import does not switch accounts or change auto-approval; select the imported account explicitly to use it. Only nsec keys are accepted, not npub, hexadecimal keys or encrypted ncryptsec keys. Avoid importing your main identity.
- **Manage this account → Rename / Delete:** manage the selected account. Deleting the active account selects the first remaining account. At least one account must remain.
- **Copy npub / Copy hex:** copy the active public key, never its private key.
- **Auto-approve requests:** turn off to immediately reject newly processed requests. This is a pause switch, not a manual approval mode.
- **Recent requests:** expand to view the last 50 operations. Click **Refresh** to update or **Clear** to remove the metadata log.

Account changes apply to requests processed after the switch. A request already being processed finishes with its original account. Clients that cache their logged-in identity may need to log out and back in or reload after switching.

Keys persist across browser and service-worker restarts. They are stored **unencrypted** in local extension storage, never synced to the cloud. There is no key export or recovery. Keep an independent backup of imported keys. Account deletion and extension uninstallation remove the local keys; generated keys cannot be recovered, and imported accounts can only be restored from your own backup.

## Website API

```js
const pubkey = await window.nostr.getPublicKey();

const signed = await window.nostr.signEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: 'Hello from a disposable NosTest account',
});

const encrypted = await window.nostr.nip44.encrypt(pubkey, 'Test message');
const plaintext = await window.nostr.nip44.decrypt(pubkey, encrypted);
```

Supported methods:

- `getPublicKey()`
- `signEvent(event)`
- `nip04.encrypt(peer, plaintext)` / `nip04.decrypt(peer, ciphertext)` — legacy, deprecated by Nostr
- `nip44.encrypt(peer, plaintext)` / `nip44.decrypt(peer, ciphertext)` — NIP-44 v2
- `getRelays()` — legacy compatibility, returns `{}`
- `peekPublicKey()` — compatibility helper, behaves like `getPublicKey()`

NosTest signs locally; it does not publish events or connect to relays. Signatures always use the active account, replacing any caller-supplied `pubkey`, `id` or `sig`. Invalid events, malformed ciphertext, unsupported operations and oversized inputs are rejected even when auto-approval is enabled. NIP-44 also applies its protocol-specific length constraints.

Public keys are not cached by the provider. NosTest additionally exposes optional, non-standard account-change notifications:

```js
const onAccountChanged = (pubkey) => console.log('Active public key:', pubkey);
window.nostr.on('accountChanged', onAccountChanged);
window.nostr.off('accountChanged', onAccountChanged);

window.addEventListener('nostr:accountChanged', (event) => {
  console.log(event.detail.pubkey);
});
```

`nostr:ready` is emitted when the provider is installed. Always check `window.nostr` first because the event may have fired before a client's listener was registered.

## Architecture and security boundaries

```text
Website window.nostr (MAIN world)
    → window.postMessage
Isolated content-script bridge
    → chrome.runtime.sendMessage
Background service worker
    → validated operation + active account + local key storage
```

- Only the background performs cryptographic operations, using `nostr-tools`. Imported nsec keys travel only from the extension UI to the background, never through the website bridge. Decoder errors are sanitized so they cannot expose pasted keys.
- Storage is restricted to trusted extension contexts with `storage.local.setAccessLevel`; content scripts cannot read raw keys.
- Website messages are restricted to supported NIP-07 methods. Account management is authenticated using the browser-provided sender ID and exact extension UI URL.
- Request origins come from browser-provided sender metadata, not website-supplied fields.
- A serialized store protects initialization, account changes, signing and log updates from concurrent writes. Failed commands do not poison the queue.
- Logs contain timestamps, origins, method names, account IDs, public keys and success status, not event content, plaintext, ciphertext or private keys.
- Each page bridge accepts up to 100 concurrent requests. Provider calls time out after 30 seconds; a timeout does not cancel work already accepted by the background.
- Only the `storage` API permission is requested. Declarative content scripts run on all HTTP/HTTPS sites. No remote code, analytics, relay traffic or external messaging API is included.
- Opaque/sandboxed origins are unsupported. The page bridge is **not** an authentication boundary within a website: scripts on the same page can observe or imitate its messages. All page scripts are deliberately treated as trusted clients.

These boundaries prevent accidental key exposure through the page API; they do **not** make auto-approving arbitrary websites safe. Malicious websites can still impersonate the active Nostr identity, sign authentication challenges, and decrypt messages they possess. Pausing cannot undo a signature already returned. Local malware or anyone with access to the browser profile may recover stored keys.

## Development and tests

Use Node.js 22.12+ (Node.js 24 recommended).

```sh
npm ci
npm run check                 # Type checking, unit tests, production build
npx playwright install chromium
npm run test:e2e              # Real headless Chromium with the unpacked extension
```

Tests use temporary browser profiles and never access your regular Chrome profile. Browser coverage includes early injection under a strict page CSP, cross-origin frames, concurrent requests, signature verification, NIP-04/NIP-44 interoperability, account-change notifications, pause/resume, generation, nsec import and duplicate rejection, renaming, deletion, browser-restart persistence, and rejection of content-script storage reads and forged admin commands.

Project layout:

```text
src/provider.ts       Website-facing NIP-07 API
src/content.ts        Isolated page/background bridge
src/background.ts     Browser integration and sender authentication
src/service.ts        Account commands and automatic request handling
src/store.ts          Serialized persistence and account generation
src/signer.ts         Event validation and cryptographic operations
src/popup.ts          Account manager behavior
public/               Manifest, HTML and CSS
scripts/build.mjs     Local esbuild bundling
tests/                Unit and browser integration tests
```

## Reference

The API surface and extension architecture were informed by nos2x (public domain), using the [documented reference baseline](docs/upstream-nos2x.md). This is a separate TypeScript implementation, not an official nos2x release or a merge-compatible fork. No nos2x artwork is used. Nostr cryptography is provided by `nostr-tools` and its dependencies.
