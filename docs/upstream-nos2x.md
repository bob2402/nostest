# nos2x reference baseline

NosTest is an independent TypeScript implementation informed by nos2x, not a fork that can be updated by merging upstream commits. This document pins the source reference used for the initial implementation and provides a starting point for reviewing future features and bug fixes.

## Initial reference

| Item | Value |
| --- | --- |
| Repository | [fiatjaf/nos2x](https://github.com/fiatjaf/nos2x) |
| Reference branch | `master` |
| Extension version | **2.5.2**, from `extension/manifest.json` at the pinned commit |
| Exact commit | [`014493f9602d0a3826ef3eab2bdd4901ee315cce`](https://github.com/fiatjaf/nos2x/commit/014493f9602d0a3826ef3eab2bdd4901ee315cce) |
| Commit subject | `add peekPublicKey.` |
| Commit date | 2026-03-21 (UTC) |
| Baseline verified on | 2026-09-30 (UTC) |
| Last checked reference commit | `014493f9602d0a3826ef3eab2bdd4901ee315cce` |

The version identifies the extension manifest, **not** a verified release tag or Chrome Web Store build. Use the full commit SHA for comparisons: upstream can change code without changing the manifest version. The pinned files below were rechecked when this record was created and match the source reference consulted during initial implementation. This is not a claim that every upstream feature or historical fix has been reviewed or ported.

Keep the initial reference immutable. Record later reviews separately below, including the exact target SHA rather than just `master`.

## Source map

These links are pinned to the baseline, so they will not change when upstream advances.

| Upstream reference | NosTest implementation | Review focus |
| --- | --- | --- |
| [extension/manifest.json](https://github.com/fiatjaf/nos2x/blob/014493f9602d0a3826ef3eab2bdd4901ee315cce/extension/manifest.json) | [`public/manifest.json`](../public/manifest.json) | Browser compatibility, permissions, injection timing and frames |
| [extension/nostr-provider.js](https://github.com/fiatjaf/nos2x/blob/014493f9602d0a3826ef3eab2bdd4901ee315cce/extension/nostr-provider.js) | [`src/provider.ts`](../src/provider.ts), [`src/protocol.ts`](../src/protocol.ts) | NIP-07 methods, request correlation, errors and account identity |
| [extension/content-script.js](https://github.com/fiatjaf/nos2x/blob/014493f9602d0a3826ef3eab2bdd4901ee315cce/extension/content-script.js) | [`src/content.ts`](../src/content.ts) | Page messaging, origin checks and background bridge |
| [extension/background.js](https://github.com/fiatjaf/nos2x/blob/014493f9602d0a3826ef3eab2bdd4901ee315cce/extension/background.js) | [`src/background.ts`](../src/background.ts), [`src/service.ts`](../src/service.ts), [`src/signer.ts`](../src/signer.ts), [`src/store.ts`](../src/store.ts) | Signing, encryption, storage, sender authentication and concurrency |

## Intentional differences

Consider these differences before applying an upstream change:

- **Approval policy:** NosTest automatically approves supported requests globally while enabled and rejects them while paused. It does not implement nos2x's per-site permissions or approval prompts.
- **Multiple accounts:** NosTest generates and imports accounts, persists an active account and serializes account changes with requests. An upstream fix assuming one private key may need adaptation.
- **Public key caching:** NosTest does not cache `getPublicKey()` results in the provider, preventing stale identities after an account switch.
- **`peekPublicKey()` semantics:** At the baseline, nos2x returns an empty string when a site lacks prior public-key permission. NosTest treats this method like `getPublicKey()`: it returns the active key while enabled and rejects while paused.
- **Injection:** NosTest uses declarative MAIN-world injection at `document_start`, rather than inserting a script element from the content script at `document_end`.
- **Key and message handling:** NosTest restricts storage to trusted extension contexts, authenticates management commands separately, derives origins from browser sender metadata and keeps payloads out of request logs. Preserve these boundaries when adapting fixes.
- **Omitted features:** NosTest does not include nos2x's `nostr:` link rewriting, notification flow or external-extension messaging API.
- **Dependencies:** NosTest has its own `nostr-tools` version and lockfile. Review cryptographic dependency fixes independently; do not assume an upstream application commit or version covers them.

## Checking for upstream changes

Useful entry points:

- [Changes from the initial baseline to current master](https://github.com/fiatjaf/nos2x/compare/014493f9602d0a3826ef3eab2bdd4901ee315cce...master)
- [Commit history](https://github.com/fiatjaf/nos2x/commits/master/)
- [Releases](https://github.com/fiatjaf/nos2x/releases)
- [Issues](https://github.com/fiatjaf/nos2x/issues) and [pull requests](https://github.com/fiatjaf/nos2x/pulls)

For a reproducible local comparison, use a separate checkout rather than adding or merging an upstream remote into NosTest:

```sh
REFERENCE_DIR="$(mktemp -d)/nos2x"
git clone https://github.com/fiatjaf/nos2x.git "$REFERENCE_DIR"
BASE=014493f9602d0a3826ef3eab2bdd4901ee315cce
TARGET=$(git -C "$REFERENCE_DIR" rev-parse origin/master)

# Save this exact target SHA in the review record.
printf 'Reviewing %s..%s\n' "$BASE" "$TARGET"
git -C "$REFERENCE_DIR" log --oneline "$BASE..$TARGET"
git -C "$REFERENCE_DIR" diff --stat "$BASE..$TARGET"
git -C "$REFERENCE_DIR" diff "$BASE..$TARGET" -- extension package.json
```

For later reviews, `BASE` can be the last fully reviewed target SHA. Do not advance that checkpoint past unreviewed commits without recording the gaps.

1. Inspect the full commit list, including dependency changes, not just release notes or a version bump.
2. Prioritize signing/encryption correctness, key exposure, sender/origin validation, account switching, concurrency and browser compatibility.
3. Classify each relevant change as **adopted**, **not applicable**, or **deferred**, with a reason and an upstream commit/issue link.
4. Adapt applicable fixes to NosTest's architecture instead of copying entire upstream files. Add a regression test reproducing the bug or exercising the new behavior.
5. Run `npm run check` and `npm run test:e2e`. For UI or permission changes, also inspect the unpacked extension in a browser.
6. Add a review record with the date, exact upstream range, decisions, local implementation/test references and unresolved follow-ups. Update the last checked reference commit only with an explanation of the review scope.

## Review history

| Date (UTC) | Upstream reference or range | Scope and result |
| --- | --- | --- |
| 2026-09-30 | `014493f9602d0a3826ef3eab2bdd4901ee315cce` | Recorded the initial reference. Verified manifest version 2.5.2 and the four source files mapped above. No later upstream changes reviewed or ported as part of this documentation update. |
