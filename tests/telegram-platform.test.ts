import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../src/server/conversation-store.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const token = '123456:platform-telegram-secret';
const model = {
  apiKey: 'model-key',
  model: 'model-id',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
};
const telegram = {
  telegramBotToken: token,
  telegramOwnerId: '1001',
  telegramAllowedIds: ['2002'],
};
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-platform-'));
  dirs.push(dir);
  return join(dir, 'opendots.sqlite');
}

/** Boots a Platform the way index.ts does: one database file shared by all three stores. */
function boot(database: string, config: Partial<PlatformConfig> = {}) {
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  const conversationStore = new ConversationStore(database);
  const platform = new Platform(
    store,
    workspace,
    { ...model, ...config },
    conversationStore,
  );
  return { platform, store, workspace, conversationStore };
}

/** Platform.stop closes the conversation store; the other two close here. */
async function shutdown(booted: ReturnType<typeof boot>) {
  await booted.platform.stop();
  booted.store.close();
  booted.workspace.close();
}

/** A fake Bot API: getMe succeeds, the given batches are returned, then getUpdates waits for abort. */
function fakeBotApi(batches: unknown[][]) {
  const calls: Array<{ method: string; url: URL; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      // Other hosts (the SDK's own telemetry) are refused; only Bot API calls are recorded.
      if (url.hostname !== 'api.telegram.org')
        return Promise.reject(new Error('non-Telegram request blocked'));
      const method = url.pathname.split('/').pop() ?? '';
      calls.push({ method, url, body: init?.body });
      if (method === 'getMe')
        return Promise.resolve(
          Response.json({ ok: true, result: { id: 1, is_bot: true } }),
        );
      if (method === 'getUpdates') {
        const batch = batches.shift();
        if (batch)
          return Promise.resolve(Response.json({ ok: true, result: batch }));
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        );
      }
      return Promise.resolve(
        Response.json({ ok: true, result: { message_id: 1 } }),
      );
    }),
  );
  return calls;
}

function unlistedUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 3003, type: 'private' },
      from: { id: 3003, is_bot: false },
      text: 'let me in',
    },
  };
}

it('starts with no Telegram token, makes no Telegram request, and blocks nothing else', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  const calls = fakeBotApi([]);
  const booted = boot(tempDatabase());
  await booted.platform.start();
  expect(booted.platform.setup()).toMatchObject({
    telegram: 'not_configured',
    missing: [],
  });
  expect(() => booted.platform.requireReady()).not.toThrow();
  const dot = booted.workspace.dots()[0];
  await expect(
    booted.platform.createConversation(dot.id, 'Still works'),
  ).resolves.toMatchObject({ title: 'Still works' });
  expect(calls).toEqual([]);
  await shutdown(booted);
});

it('reports setup_required until getMe confirms the token, then online while polling', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  const calls = fakeBotApi([]);
  const booted = boot(tempDatabase(), telegram);
  expect(booted.platform.setup().telegram).toBe('setup_required');
  await booted.platform.start();
  await vi.waitFor(() =>
    expect(booted.platform.setup().telegram).toBe('online'),
  );
  expect(calls.map(({ method }) => method)).toContain('getMe');
  await shutdown(booted);
});

it('drops an unlisted sender silently, then resumes from the stored offset after restart', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  const database = tempDatabase();
  const first = boot(database, telegram);
  const firstCalls = fakeBotApi([[unlistedUpdate(42)]]);
  await first.platform.start();
  await vi.waitFor(() =>
    expect(first.conversationStore.highWaterOffset('telegram')).toBe(42),
  );
  expect(firstCalls.some(({ method }) => method === 'sendMessage')).toBe(false);
  expect(first.conversationStore.runs('telegram-3003')).toHaveLength(0);
  expect(first.workspace.conversations()).toHaveLength(0);
  await shutdown(first);

  const second = boot(database, telegram);
  const secondCalls = fakeBotApi([]);
  await second.platform.start();
  await vi.waitFor(() =>
    expect(secondCalls.some(({ method }) => method === 'getUpdates')).toBe(
      true,
    ),
  );
  const polled = secondCalls.find(({ method }) => method === 'getUpdates');
  expect(polled?.url.searchParams.get('offset')).toBe('43');
  await shutdown(second);
}, 20000);

it('never prints the bot token or puts it in the setup payload', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    output.push(args.join(' '));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      throw new Error(`connection refused for ${String(input)}`);
    }),
  );
  const booted = boot(tempDatabase(), telegram);
  await booted.platform.start();
  await vi.waitFor(() =>
    expect(booted.platform.setup().telegram).toBe('activation_failed'),
  );
  expect(output.join('\n')).toContain('Telegram activation failed');
  expect(output.join('\n')).not.toContain(token);
  expect(JSON.stringify(booted.platform.setup())).not.toContain(token);
  await shutdown(booted);
});

it('does not start polling when TELEGRAM_DOT_ID names no Dot', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const calls = fakeBotApi([]);
  const booted = boot(tempDatabase(), {
    ...telegram,
    telegramDotId: 'missing-dot',
  });
  await booted.platform.start();
  expect(booted.platform.setup().telegram).toBe('setup_required');
  expect(calls).toEqual([]);
  await shutdown(booted);
});

function sentMessages(calls: ReturnType<typeof fakeBotApi>) {
  return calls
    .filter(({ method }) => method === 'sendMessage')
    .map(({ body }) => JSON.parse(String(body)));
}

const RESEND_NOTICE =
  'A previous run was interrupted. Please resend your message to continue.';

it('tells the owner to resend when a Telegram run was interrupted at boot, once', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  const database = tempDatabase();
  // A previous process admitted a Telegram turn and exited before finishing it.
  const previousWorkspace = new WorkspaceStore(database, 'owner');
  const previousConversations = new ConversationStore(database);
  const dot = previousWorkspace.dots()[0];
  previousWorkspace.bindThread(
    'telegram-2002',
    dot.id,
    'Telegram conversation',
  );
  previousConversations.admitTurn({
    source: 'channel_owner',
    threadId: 'telegram-2002',
    dotId: dot.id,
    ownerId: previousWorkspace.ownerId,
    role: 'user',
    content: { id: 'interrupted-message', role: 'user', content: 'hello' },
  });
  previousConversations.close();
  previousWorkspace.close();

  // Platform's constructor marks that run interrupted before the connector starts.
  const first = boot(database, telegram);
  const firstCalls = fakeBotApi([]);
  await first.platform.start();
  await vi.waitFor(() =>
    expect(firstCalls.some(({ method }) => method === 'getUpdates')).toBe(true),
  );
  expect(sentMessages(firstCalls)).toEqual([
    { chat_id: 1001, text: RESEND_NOTICE },
  ]);
  await shutdown(first);

  // A later restart must not repeat the notice for the same run.
  const second = boot(database, telegram);
  const secondCalls = fakeBotApi([]);
  await second.platform.start();
  await vi.waitFor(() =>
    expect(secondCalls.some(({ method }) => method === 'getUpdates')).toBe(
      true,
    ),
  );
  expect(sentMessages(secondCalls)).toEqual([]);
  await shutdown(second);
}, 20000);

it('never sends Telegram notices for web conversation runs interrupted at boot', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  const database = tempDatabase();
  const previousWorkspace = new WorkspaceStore(database, 'owner');
  const previousConversations = new ConversationStore(database);
  const dot = previousWorkspace.dots()[0];
  previousWorkspace.bindThread('web-thread', dot.id, 'Web conversation');
  previousConversations.admitTurn({
    source: 'web_owner',
    threadId: 'web-thread',
    dotId: dot.id,
    ownerId: previousWorkspace.ownerId,
    role: 'user',
    content: { id: 'web-message', role: 'user', content: 'hello' },
  });
  previousConversations.close();
  previousWorkspace.close();

  const booted = boot(database, telegram);
  const calls = fakeBotApi([]);
  await booted.platform.start();
  await vi.waitFor(() =>
    expect(calls.some(({ method }) => method === 'getUpdates')).toBe(true),
  );
  expect(sentMessages(calls)).toEqual([]);
  await shutdown(booted);
}, 20000);
it('aborts a pending getMe when the server stops instead of blocking shutdown', async () => {
  vi.stubEnv('DO_NOT_TRACK', '1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let getMeStarted!: () => void;
  const started = new Promise<void>((resolve) => (getMeStarted = resolve));
  const methods: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const method = new URL(String(input)).pathname.split('/').pop() ?? '';
      methods.push(method);
      if (method === 'getMe') {
        getMeStarted();
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        );
      }
      return new Promise<Response>(() => {});
    }),
  );
  const booted = boot(tempDatabase(), telegram);
  const start = booted.platform.start();
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const platformStopped = booted.platform.stop();
  await expect(
    Promise.race([
      platformStopped,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('stop did not abort the pending getMe')),
          2000,
        );
      }),
    ]),
  ).resolves.toBeUndefined();
  clearTimeout(timer);
  await start;
  expect(methods).toContain('getMe');
  booted.store.close();
  booted.workspace.close();
});
