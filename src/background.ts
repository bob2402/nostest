import { CHANNEL, UI_CHANNEL, errorMessage, type AdminCommand, type Reply, type Snapshot } from './protocol';
import { Store } from './store';
import { SignerService } from './service';

const STORAGE_KEY = 'nostestState';
// Prevent content scripts from reading local storage, including raw private keys.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const service = new SignerService(new Store({
  read: async () => {
    await ready;
    return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  },
  write: async (state) => { await chrome.storage.local.set({ [STORAGE_KEY]: state }); },
}));

function isAdmin(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  return url.origin === new URL(chrome.runtime.getURL('/')).origin &&
    url.href.split(/[?#]/)[0] === chrome.runtime.getURL('popup.html');
}
function pageOrigin(sender: chrome.runtime.MessageSender): string {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) throw new Error('Untrusted request sender');
  const url = new URL(sender.url);
  if (!['http:', 'https:'].includes(url.protocol) || sender.origin === 'null') {
    throw new Error('Unsupported page origin');
  }
  if (sender.origin && sender.origin !== url.origin) throw new Error('Page origin mismatch');
  return url.origin;
}
async function updateBadge(state: Snapshot) {
  await chrome.action.setBadgeText({ text: state.enabled ? 'AUTO' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: state.enabled ? '#222222' : '#666666' });
}
async function notifyAccount(state: Snapshot) {
  const pubkey = state.accounts.find((item) => item.id === state.activeId)!.pubkey;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { channel: CHANNEL, kind: 'accountChanged', pubkey });
    } catch {
      // Restricted pages and tabs without the content script have no receiver.
    }
  }));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== CHANNEL && message?.channel !== UI_CHANNEL) return;
  const handle = async (): Promise<Reply> => {
    await ready;
    if (message.channel === UI_CHANNEL) {
      if (!isAdmin(sender)) throw new Error('Account management is restricted to the extension UI');
      if (!message.command || typeof message.command !== 'object') throw new Error('Invalid command');
      const command = message.command as AdminCommand;
      const state = await service.admin(command);
      // A UI update failure must not turn a committed account mutation into a failed command.
      await updateBadge(state).catch(console.error);
      if (command.action === 'switch' || command.action === 'delete') {
        await notifyAccount(state).catch(console.error);
      }
      return { ok: true, result: state };
    }
    if (message.kind !== 'request') throw new Error('Invalid request envelope');
    // Never use a website-supplied origin or allow website account-management commands.
    return service.request(message.method, message.params, pageOrigin(sender));
  };
  void handle().then(sendResponse, (error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
void service.admin({ action: 'getState' }).then(updateBadge).catch(console.error);
