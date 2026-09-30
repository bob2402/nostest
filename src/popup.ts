import { UI_CHANNEL, errorMessage, type AdminCommand, type Reply, type Snapshot } from './protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const controls = $<HTMLFieldSetElement>('controls');
const accounts = $<HTMLSelectElement>('accounts');
const enabled = $<HTMLInputElement>('enabled');
const name = $<HTMLInputElement>('name');
let state: Snapshot;
let busy = false;

function status(message: string, error = false, target = 'status') {
  $(target).textContent = message;
  $(target).classList.toggle('error', error);
}
function render() {
  accounts.replaceChildren(...state.accounts.map((account) => {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = `${account.name} · ${account.pubkey.slice(0, 8)}`;
    return option;
  }));
  accounts.value = state.activeId;
  const active = state.accounts.find((account) => account.id === state.activeId)!;
  name.value = active.name;
  $('pubkey').textContent = active.npub;
  $('pubkey').title = active.pubkey;
  $('account-count').textContent = `${state.accounts.length} / 100`;
  enabled.checked = state.enabled;
  $('mode').textContent = state.enabled ? 'On' : 'Paused';
  $<HTMLButtonElement>('delete').disabled = state.accounts.length === 1;
  $<HTMLButtonElement>('next').disabled = state.accounts.length === 1;
  const logs = $('logs');
  logs.replaceChildren();
  if (!state.logs.length) {
    const item = document.createElement('li');
    item.textContent = 'No requests yet.';
    item.className = 'muted';
    logs.append(item);
  }
  for (const log of state.logs) {
    const item = document.createElement('li');
    const origin = document.createElement('div');
    origin.className = 'origin';
    origin.textContent = log.origin;
    const detail = document.createElement('div');
    detail.className = log.ok ? 'detail' : 'detail failed';
    detail.textContent = `${log.ok ? 'OK' : 'Failed'} · ${log.method} · ${log.pubkey.slice(0, 8)} · ${new Date(log.time).toLocaleTimeString('en-US')}`;
    detail.title = log.pubkey;
    item.append(origin, detail);
    logs.append(item);
  }
}
async function run(command: AdminCommand, message = '') {
  if (busy) return;
  busy = true;
  controls.disabled = true;
  const report = (text: string, error = false) => {
    status(text, error);
    if (command.action === 'import') status(text, error, 'import-status');
  };
  try {
    const reply: Reply = await chrome.runtime.sendMessage({ channel: UI_CHANNEL, command });
    if (!reply?.ok) throw new Error(reply?.error || 'The extension did not respond');
    state = reply.result as Snapshot;
    render();
    report(message || (command.action === 'setEnabled'
      ? (state.enabled ? 'Auto-approval is active for all websites.' : 'Paused. All requests will be rejected.')
      : ''));
  } catch (error) {
    if (state) render();
    report(errorMessage(error), true);
  } finally {
    if (command.action === 'import') command.nsec = '';
    busy = false;
    controls.disabled = !state;
  }
}
accounts.addEventListener('change', () => void run({ action: 'switch', id: accounts.value }, 'Active account switched.'));
enabled.addEventListener('change', () => void run({ action: 'setEnabled', enabled: enabled.checked }));
$('next').addEventListener('click', () => {
  const index = state.accounts.findIndex((account) => account.id === state.activeId);
  void run({ action: 'switch', id: state.accounts[(index + 1) % state.accounts.length].id }, 'Active account switched.');
});
$('rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run({ action: 'rename', id: state.activeId, name: name.value }, 'Account renamed.');
});
$('generate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const count = $<HTMLInputElement>('count').valueAsNumber;
  void run({ action: 'generate', count }, `${count} account${count === 1 ? '' : 's'} generated.`);
});
$('import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const command: AdminCommand = {
    action: 'import',
    nsec: $<HTMLInputElement>('import-nsec').value,
    name: $<HTMLInputElement>('import-name').value,
  };
  // Remove sensitive input immediately, on both successful and failed attempts.
  $<HTMLFormElement>('import-form').reset();
  void run(command, 'Account imported. Select it from Active account to use it.');
});
$('delete').addEventListener('click', () => {
  const account = state.accounts.find((item) => item.id === state.activeId)!;
  if (confirm(`Permanently delete "${account.name}" and its private key? This cannot be undone.`)) {
    void run({ action: 'delete', id: account.id }, 'Account deleted.');
  }
});
$('refresh').addEventListener('click', () => void run({ action: 'getState' }, 'Request log refreshed.'));
$('clear').addEventListener('click', () => void run({ action: 'clearLogs' }, 'Request log cleared.'));
for (const format of ['npub', 'hex'] as const) {
  $(`copy-${format}`).addEventListener('click', () => {
    const account = state.accounts.find((item) => item.id === state.activeId)!;
    void navigator.clipboard.writeText(format === 'npub' ? account.npub : account.pubkey)
      .then(() => status('Public key copied.'))
      .catch(() => status('Clipboard access failed. Open Manage this account to select and copy the public key.', true));
  });
}
void run({ action: 'getState' });
