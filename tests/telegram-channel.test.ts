import { afterEach, expect, it, vi } from 'vitest';
import { AbstractAgent, EventType, type RunAgentInput } from '@ag-ui/client';
import { of } from 'rxjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../src/server/conversation-store.js';
import { TelegramChannel } from '../src/server/telegram-channel.js';
import { SetupTelemetry } from '../src/server/setup-telemetry.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const token = '123456:telegram-test-secret';
const resources: Array<{ close(): void }> = [];
const dirs: string[] = [];

afterEach(() => {
  resources.splice(0).forEach((resource) => resource.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class EchoAgent extends AbstractAgent {
  clone() { return new EchoAgent(); }
  run(input: RunAgentInput) {
    const id = `reply-${input.runId}`;
    return of(
      { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: 'Hello from Dot.' },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    ) as ReturnType<AbstractAgent['run']>;
  }
}

function fixture(agentFactory = vi.fn(() => new EchoAgent())) {
  const store = new ConversationStore(':memory:');
  const workspace = new WorkspaceStore(':memory:', '1001');
  resources.push(store, workspace);
  const connector = new TelegramChannel(
    token,
    '1001',
    ['2002'],
    store,
    workspace,
    agentFactory,
    () => false,
  );
  return { connector, store, workspace, agentFactory };
}

function messageUpdate(updateId = 10, sender = 2002) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: sender, type: 'private' },
      from: { id: sender, is_bot: false },
      text: 'Hi Dot',
    },
  };
}

function fakeTelegram(updates: unknown[], sendFailure = false) {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname.endsWith('/getUpdates'))
      return Response.json({ ok: true, result: updates });
    if (sendFailure) throw new Error(`transport failed for ${url.href}`);
    return Response.json({ ok: true, result: { message_id: 99 } });
  }));
  return requests;
}

it.each([
  ['edited_message', { edited_message: { chat: { id: 2002, type: 'private' }, from: { id: 2002, is_bot: false }, text: 'edited' } }],
  ['channel_post', { channel_post: { chat: { id: 2002, type: 'channel' }, text: 'post' } }],
  ['my_chat_member', { my_chat_member: { chat: { id: 2002, type: 'private' } } }],
  ['callback_query', { callback_query: { id: 'cb' } }],
  ['other update', { inline_query: { id: 'inline' } }],
  ['group message', { message: { chat: { id: -2, type: 'group' }, from: { id: 2002, is_bot: false }, text: 'no' } }],
  ['unauthorized sender', { message: { chat: { id: 3003, type: 'private' }, from: { id: 3003, is_bot: false }, text: 'no' } }],
  ['bot sender', { message: { chat: { id: 2002, type: 'private' }, from: { id: 2002, is_bot: true }, text: 'no' } }],
])('silently drops %s without replying, running, or creating a thread', async (_name, update) => {
  const f = fixture();
  const requests = fakeTelegram([{ update_id: 1, ...update }]);
  await f.connector.pollOnce();
  expect(requests.filter(({ url }) => url.pathname.endsWith('/sendMessage'))).toHaveLength(0);
  expect(f.agentFactory).not.toHaveBeenCalled();
  expect(f.store.runs('telegram-2002')).toHaveLength(0);
  expect(f.workspace.conversations()).toHaveLength(0);
});

it('admits an allow-listed private message, runs the agent, and replies in the same chat', async () => {
  const f = fixture();
  const requests = fakeTelegram([messageUpdate()]);
  await f.connector.pollOnce();
  expect(f.agentFactory).toHaveBeenCalledOnce();
  expect(f.store.messages('telegram-2002').map((entry) => entry.role)).toEqual(['user', 'assistant']);
  expect(f.store.runs('telegram-2002').map((run) => run.status)).toEqual(['completed']);
  const sent = requests.find(({ url }) => url.pathname.endsWith('/sendMessage'))!;
  expect(JSON.parse(String(sent.init?.body))).toEqual({ chat_id: 2002, text: 'Hello from Dot.' });
  expect(f.store.pendingOutbound()).toHaveLength(0);
  expect(f.store.highWaterOffset('telegram')).toBe(10);
});

it('advances the durable offset when no Dot is available to run the message', async () => {
  const f = fixture();
  vi.spyOn(f.workspace, 'dots').mockReturnValue([]);
  fakeTelegram([messageUpdate(15)]);
  await f.connector.pollOnce();
  expect(f.agentFactory).not.toHaveBeenCalled();
  expect(f.store.runs('telegram-2002')).toHaveLength(0);
  expect(f.store.highWaterOffset('telegram')).toBe(15);
});

it('deduplicates redelivered update ids and never performs another outbound attempt', async () => {
  const f = fixture();
  const requests = fakeTelegram([messageUpdate(), messageUpdate()]);
  await f.connector.pollOnce();
  expect(f.store.runs('telegram-2002')).toHaveLength(1);
  expect(f.store.messages('telegram-2002')).toHaveLength(2);
  expect(requests.filter(({ url }) => url.pathname.endsWith('/sendMessage'))).toHaveLength(1);
});

it('uses the atomic inbound transaction so a pre-commit crash can be redelivered once', async () => {
  const f = fixture();
  const update = messageUpdate(21);
  fakeTelegram([update]);
  const failBeforeCommit = vi.spyOn(f.store, 'admitInboundTurn').mockImplementationOnce(() => {
    throw new Error('injected crash before admission');
  });
  await expect(f.connector.pollOnce()).rejects.toThrow('injected crash before admission');
  expect(f.store.highWaterOffset('telegram')).toBeNull();
  expect(f.store.runs('telegram-2002')).toHaveLength(0);
  failBeforeCommit.mockRestore();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return Response.json({ ok: true, result: url.pathname.endsWith('/getUpdates') ? [update] : { message_id: 1 } });
  }));
  await f.connector.pollOnce();
  expect(f.store.runs('telegram-2002')).toHaveLength(1);
  expect(f.agentFactory).toHaveBeenCalledOnce();
  expect(f.store.highWaterOffset('telegram')).toBe(21);
});

it('resumes from the durable offset after restart without replaying committed updates or losing history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-restart-'));
  dirs.push(dir);
  const storePath = join(dir, 'conversation.sqlite');
  const workspacePath = join(dir, 'workspace.sqlite');
  const store = new ConversationStore(storePath);
  const workspace = new WorkspaceStore(workspacePath, '1001');
  resources.push(store, workspace);
  const first = new TelegramChannel(token, '1001', ['2002'], store, workspace, () => new EchoAgent(), () => false);
  fakeTelegram([messageUpdate(42)]);
  await first.pollOnce();
  store.close();
  workspace.close();
  resources.splice(resources.indexOf(store), 1);
  resources.splice(resources.indexOf(workspace), 1);

  const reopenedStore = new ConversationStore(storePath);
  const reopenedWorkspace = new WorkspaceStore(workspacePath, '1001');
  resources.push(reopenedStore, reopenedWorkspace);
  const requests = fakeTelegram([]);
  const restarted = new TelegramChannel(token, '1001', ['2002'], reopenedStore, reopenedWorkspace, () => new EchoAgent(), () => false);
  await restarted.pollOnce();
  expect(requests[0].url.searchParams.get('offset')).toBe('43');
  expect(reopenedStore.runs('telegram-2002')).toHaveLength(1);
  expect(reopenedStore.messages('telegram-2002').map((message) => message.role)).toEqual(['user', 'assistant']);
});

it('sends a single owner resend notice for an interrupted run, including across another restart', async () => {
  const f = fixture();
  const dot = f.workspace.dots()[0];
  f.workspace.bindThread('telegram-2002', dot.id, 'Telegram conversation');
  f.store.admitTurn({
    threadId: 'telegram-2002',
    dotId: dot.id,
    ownerId: f.workspace.ownerId,
    role: 'user',
    content: { id: 'interrupted-message', role: 'user', content: 'again' },
  });
  const requests = fakeTelegram([]);
  const stopped = new TelegramChannel(token, '1001', ['2002'], f.store, f.workspace, () => new EchoAgent(), () => true);
  await stopped.start();
  await stopped.start();
  const notices = requests
    .filter(({ url }) => url.pathname.endsWith('/sendMessage'))
    .map(({ init }) => JSON.parse(String(init?.body)));
  expect(notices).toEqual([
    {
      chat_id: 1001,
      text: 'A previous run was interrupted. Please resend your message to continue.',
    },
  ]);
  expect(f.store.runs('telegram-2002')[0].status).toBe('interrupted');
});

it.each(['getUpdates', 'sendMessage'])('does not expose the token on %s failure', async (method) => {
  const f = fixture();
  const output: string[] = [];
  const telemetry = vi.spyOn(SetupTelemetry.prototype, 'capture');
  vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args) => output.push(args.join(' ')));
  if (method === 'getUpdates') {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`aborted ${token}`); }));
    await expect(f.connector.pollOnce()).rejects.toThrow('Telegram request failed.');
  } else {
    const requests = fakeTelegram([messageUpdate()], true);
    await f.connector.pollOnce();
    expect(requests.filter(({ url }) => url.pathname.endsWith('/sendMessage'))).toHaveLength(3);
  }
  expect(output.join(' ')).not.toContain(token);
  expect(JSON.stringify(f.store.pendingOutbound())).not.toContain(token);
  expect(JSON.stringify(telemetry.mock.calls)).not.toContain(token);
  expect(telemetry).not.toHaveBeenCalled();
});
