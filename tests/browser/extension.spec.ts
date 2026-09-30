import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSecretKey, getPublicKey, verifyEvent, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';

declare global {
  interface Window {
    nostr: {
      getPublicKey(): Promise<string>;
      getRelays(): Promise<Record<string, unknown>>;
      signEvent(event: EventTemplate): Promise<NostrEvent>;
      nip04: { encrypt(peer: string, text: string): Promise<string>; decrypt(peer: string, text: string): Promise<string> };
      nip44: { encrypt(peer: string, text: string): Promise<string>; decrypt(peer: string, text: string): Promise<string> };
      on(event: string, callback: (pubkey: string) => void): void;
    };
    accountChanges: string[];
    providerAtLoad: boolean;
  }
}

let server: Server;
let base: string;
test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; frame-src http://localhost:*; object-src 'none'");
    if (request.url === '/boot.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('window.providerAtLoad = !!window.nostr;');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    const address = server.address() as { port: number };
    response.end(`<!doctype html><html lang="en"><head><title>NosTest integration fixture</title><script src="/boot.js"></script></head><body><h1>Test client</h1>${request.url === '/' ? `<iframe src="http://localhost:${address.port}/frame" title="Cross-origin client"></iframe>` : ''}</body></html>`);
  });
  await new Promise<void>((done) => server.listen(0, done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); });

async function launch(profile: string) {
  const extension = resolve('dist');
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
}
async function openUI(context: BrowserContext): Promise<Page> {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${id}/popup.html`);
  await expect(ui.locator('#controls')).toBeEnabled();
  return ui;
}

test('real browser: injection, signing, switching, encryption, pause, management and restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nostest-e2e-'));
  let context = await launch(profile);
  try {
    let ui = await openUI(context);
    const page = await context.newPage();
    await page.goto(base);
    expect(await page.evaluate(() => window.providerAtLoad)).toBe(true);
    await expect(ui.locator('#accounts option')).toHaveCount(3);
    const first = await page.evaluate(() => window.nostr.getPublicKey());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    const signed = await page.evaluate(() => window.nostr.signEvent({ kind: 1, created_at: 1700000000, tags: [], content: 'Browser test' }));
    expect(signed.pubkey).toBe(first);
    expect(verifyEvent(signed)).toBe(true);
    const frame = page.frames().find((item) => item.url().includes('/frame'))!;
    expect(await frame.evaluate(() => window.nostr.getPublicKey())).toBe(first);
    expect(await page.evaluate(() => window.nostr.getRelays())).toEqual({});
    const concurrent = await page.evaluate(() => Promise.all(Array.from({ length: 15 }, () => window.nostr.getPublicKey())));
    expect(new Set(concurrent)).toEqual(new Set([first]));

    await page.evaluate(() => {
      window.accountChanges = [];
      window.nostr.on('accountChanged', (pubkey) => window.accountChanges.push(pubkey));
    });
    const options = await ui.locator('#accounts option').evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
    await ui.locator('#accounts').selectOption(options[1]);
    await expect(ui.locator('#status')).toHaveText('Active account switched.');
    const second = await page.evaluate(() => window.nostr.getPublicKey());
    expect(second).not.toBe(first);
    await expect.poll(() => page.evaluate(() => window.accountChanges)).toContain(second);
    expect(await frame.evaluate(() => window.nostr.getPublicKey())).toBe(second);

    const encrypted = await page.evaluate(async (peer) => ({
      nip04: await window.nostr.nip04.encrypt(peer, 'Encrypted browser test'),
      nip44: await window.nostr.nip44.encrypt(peer, 'Encrypted browser test'),
    }), first);
    await ui.locator('#accounts').selectOption(options[0]);
    await expect(ui.locator('#accounts')).toBeEnabled();
    for (const protocol of ['nip04', 'nip44'] as const) {
      expect(await page.evaluate(({ protocol, peer, ciphertext }) => window.nostr[protocol].decrypt(peer, ciphertext),
        { protocol, peer: second, ciphertext: encrypted[protocol] })).toBe('Encrypted browser test');
    }
    await ui.locator('#enabled').uncheck();
    await expect(ui.locator('#mode')).toHaveText('Paused');
    expect(await page.evaluate(() => window.nostr.getPublicKey().catch((error: Error) => error.message))).toContain('paused');
    await ui.locator('#enabled').check();
    await expect(ui.locator('#mode')).toHaveText('On');

    await ui.locator('#generate-panel > summary').click();
    await ui.locator('#count').fill('2');
    await ui.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(ui.locator('#accounts option')).toHaveCount(5);
    await ui.getByText('Manage this account', { exact: true }).click();
    await ui.locator('#name').fill('Alice Test');
    await ui.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(ui.locator('#accounts option:checked')).toContainText('Alice Test');
    await ui.locator('#logs-panel > summary').click();
    await ui.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(ui.locator('#logs')).toContainText('nip44.decrypt');
    await expect(ui.locator('#logs')).toContainText('http://localhost:');
    await expect(ui.locator('#logs')).not.toContainText('Encrypted browser test');
    await ui.screenshot({ path: 'test-results/popup.png', fullPage: true });

    await context.close();
    context = await launch(profile);
    ui = await openUI(context);
    await expect(ui.locator('#accounts option')).toHaveCount(5);
    await expect(ui.locator('#accounts option:checked')).toContainText('Alice Test');
    const restarted = await context.newPage();
    await restarted.goto(base);
    expect(await restarted.evaluate(() => window.nostr.getPublicKey())).toBe(first);
    await ui.getByText('Manage this account', { exact: true }).click();
    ui.once('dialog', (dialog) => void dialog.accept());
    await ui.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(ui.locator('#accounts option')).toHaveCount(4);
    expect(await restarted.evaluate(() => window.nostr.getPublicKey())).toBe(second);
    await ui.locator('#logs-panel > summary').click();
    await ui.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(ui.locator('#logs')).toHaveText('No requests yet.');
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('nsec import: risk acknowledgement, validation, duplicate rejection, explicit switching and persistence', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nostest-import-'));
  let context = await launch(profile);
  try {
    let ui = await openUI(context);
    await ui.setViewportSize({ width: 440, height: 600 });
    // The popup stays white even when the browser prefers a dark theme.
    await ui.emulateMedia({ colorScheme: 'dark' });
    await expect(ui.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(ui.locator('html')).toHaveCSS('color-scheme', 'light');
    await expect(ui.locator('#import-nsec')).not.toBeVisible();
    await expect(ui.locator('#name')).not.toBeVisible();
    await expect(ui.locator('#logs')).not.toBeVisible();
    await ui.screenshot({ path: 'test-results/popup-compact.png', fullPage: true });
    const originalId = await ui.locator('#accounts').inputValue();
    await ui.locator('#import-panel > summary').click();
    await expect(ui.locator('#import-nsec')).toHaveAttribute('type', 'password');
    await ui.locator('#import-nsec').fill('nsec1invalid');
    await ui.getByRole('button', { name: 'Import account', exact: true }).click();
    // Native form validation requires explicit acknowledgement before dispatch.
    await expect(ui.locator('#import-nsec')).toHaveValue('nsec1invalid');
    await ui.locator('#import-risk').check();
    await ui.getByRole('button', { name: 'Import account', exact: true }).click();
    await expect(ui.locator('#import-status')).toContainText('Invalid nsec private key');
    await expect(ui.locator('#import-nsec')).toHaveValue('');
    await expect(ui.locator('#import-risk')).not.toBeChecked();
    await expect(ui.locator('#accounts option')).toHaveCount(3);

    const key = generateSecretKey();
    const nsec = nsecEncode(key);
    const pubkey = getPublicKey(key);
    await ui.locator('#import-name').fill('Imported Alice');
    await ui.locator('#import-nsec').fill(nsec);
    await ui.locator('#import-risk').check();
    await ui.getByRole('button', { name: 'Import account', exact: true }).click();
    await expect(ui.locator('#import-status')).toContainText('Account imported. Select it from Active account');
    await expect(ui.locator('#accounts option')).toHaveCount(4);
    await expect(ui.locator('#accounts')).toHaveValue(originalId);
    await expect(ui.locator('#import-nsec')).toHaveValue('');
    await expect(ui.locator('#import-risk')).not.toBeChecked();
    await ui.locator('#import-nsec').fill(nsec);
    await ui.locator('#import-risk').check();
    await ui.getByRole('button', { name: 'Import account', exact: true }).click();
    await expect(ui.locator('#import-status')).toContainText('already exists');
    await expect(ui.locator('#accounts option')).toHaveCount(4);
    await expect(ui.locator('#import-nsec')).toHaveValue('');
    expect(await ui.locator('body').textContent()).not.toContain(nsec);

    const importedId = await ui.locator('#accounts option').filter({ hasText: 'Imported Alice' }).getAttribute('value');
    await ui.locator('#accounts').selectOption(importedId!);
    await expect(ui.locator('#status')).toHaveText('Active account switched.');
    const page = await context.newPage();
    await page.goto(base);
    expect(await page.evaluate(() => window.nostr.getPublicKey())).toBe(pubkey);
    const signed = await page.evaluate(() => window.nostr.signEvent({ kind: 1, created_at: 1700000000, tags: [], content: 'Imported account test' }));
    expect(signed.pubkey).toBe(pubkey);
    expect(verifyEvent(signed)).toBe(true);
    await context.close();
    context = await launch(profile);
    ui = await openUI(context);
    await expect(ui.locator('#accounts option:checked')).toContainText('Imported Alice');
    const restarted = await context.newPage();
    await restarted.goto(base);
    expect(await restarted.evaluate(() => window.nostr.getPublicKey())).toBe(pubkey);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('content scripts cannot read keys or impersonate the account-management UI', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'nostest-security-'));
  const context = await launch(profile);
  try {
    const ui = await openUI(context);
    const page = await context.newPage();
    await page.goto(base);
    const cdp = await context.newCDPSession(page);
    const executionContexts: { id: number; name: string; origin: string; auxData?: { isDefault?: boolean } }[] = [];
    cdp.on('Runtime.executionContextCreated', ({ context }) => executionContexts.push(context));
    await cdp.send('Runtime.enable');
    const extensionId = new URL(ui.url()).host;
    const isolated = executionContexts.find((item) => item.origin === `chrome-extension://${extensionId}` && !item.auxData?.isDefault);
    expect(isolated, JSON.stringify(executionContexts)).toBeTruthy();
    const evaluate = async (expression: string) => {
      const response = await cdp.send('Runtime.evaluate', {
        expression, contextId: isolated!.id, awaitPromise: true, returnByValue: true,
      });
      expect(response.exceptionDetails).toBeUndefined();
      return response.result.value;
    };
    const storage = await evaluate("chrome.storage.local.get('nostestState').then(() => 'EXPOSED', () => 'DENIED')");
    expect(storage).toBe('DENIED');
    for (const command of [{ action: 'generate', count: 10 }, { action: 'import', nsec: 'nsec1not-a-key' }]) {
      const forged = await evaluate(`chrome.runtime.sendMessage({ channel: 'nostest:ui:v1', command: ${JSON.stringify(command)} })`);
      expect(forged.ok).toBe(false);
      expect(forged.error).toContain('restricted');
    }
    const unknown = await evaluate(`chrome.runtime.sendMessage({ channel: 'nostest:nip07:v1', kind: 'request', method: 'exportPrivateKey', params: {} })`);
    expect(unknown.ok).toBe(false);
    await ui.locator('#logs-panel > summary').click();
    await ui.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(ui.locator('#accounts option')).toHaveCount(3);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
