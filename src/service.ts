import { errorMessage, isMethod, type AdminCommand, type Params, type Reply, type Snapshot } from './protocol';
import { importAccount, newAccount, publicState, Store } from './store';
import { perform } from './signer';

export class SignerService {
  constructor(private store: Store) {}

  admin(command: AdminCommand): Promise<Snapshot> {
    return this.store.transact((state) => {
      switch (command.action) {
        case 'getState': break;
        case 'generate': {
          if (!Number.isInteger(command.count) || command.count < 1 || command.count > 20) {
            throw new Error('Generate between 1 and 20 accounts at a time');
          }
          if (state.accounts.length + command.count > 100) throw new Error('The account limit is 100');
          for (let i = 0; i < command.count; i++) state.accounts.push(newAccount(state.nextNumber++));
          break;
        }
        case 'import': {
          if (state.accounts.length >= 100) throw new Error('The account limit is 100');
          if (command.name !== undefined && (typeof command.name !== 'string' || command.name.trim().length > 60)) {
            throw new Error('Account name must contain at most 60 characters');
          }
          const name = command.name?.trim() || `Imported Account ${String(state.nextNumber).padStart(2, '0')}`;
          const account = importAccount(command.nsec, name);
          if (state.accounts.some((item) => item.pubkey === account.pubkey)) {
            throw new Error('This account already exists. Select it from Active account');
          }
          state.accounts.push(account);
          state.nextNumber++;
          // Importing never changes the active key or the auto-approval setting.
          break;
        }
        case 'switch':
        case 'rename':
        case 'delete': {
          const account = state.accounts.find((item) => item.id === command.id);
          if (!account) throw new Error('Account not found');
          if (command.action === 'switch') state.activeId = account.id;
          if (command.action === 'rename') {
            if (typeof command.name !== 'string' || !command.name.trim() || command.name.trim().length > 60) {
              throw new Error('Account name must contain 1 to 60 characters');
            }
            account.name = command.name.trim();
          }
          if (command.action === 'delete') {
            if (state.accounts.length === 1) throw new Error('Keep at least one account');
            state.accounts = state.accounts.filter((item) => item.id !== account.id);
            if (state.activeId === account.id) state.activeId = state.accounts[0].id;
          }
          break;
        }
        case 'setEnabled':
          if (typeof command.enabled !== 'boolean') throw new Error('Invalid enabled value');
          state.enabled = command.enabled;
          break;
        case 'clearLogs': state.logs = []; break;
        default: throw new Error('Unknown account management command');
      }
      return publicState(state);
    });
  }

  async request(method: unknown, params: unknown, origin: string): Promise<Reply> {
    if (!isMethod(method)) throw new Error('Unsupported NIP-07 method');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid request parameters');
    if (!/^https?:\/\//.test(origin)) throw new Error('Only HTTP and HTTPS pages are supported');
    return this.store.transact(async (state) => {
      const account = state.accounts.find((item) => item.id === state.activeId)!;
      let reply: Reply;
      try {
        if (!state.enabled) throw new Error('NosTest is paused. Resume it from the extension popup');
        reply = { ok: true, result: await perform(method, params as Params, account) };
      } catch (error) {
        reply = { ok: false, error: errorMessage(error) };
      }
      state.logs.unshift({
        id: crypto.randomUUID(), time: Date.now(), origin, method,
        accountId: account.id, pubkey: account.pubkey, ok: reply.ok,
      });
      state.logs = state.logs.slice(0, 50);
      return reply;
    });
  }
}
