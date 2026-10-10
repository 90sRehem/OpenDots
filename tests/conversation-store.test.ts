import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../src/server/conversation-store.js';

const resources: { store: ConversationStore; dir?: string }[] = [];
function fixture(fileBacked = false) {
  if (!fileBacked) {
    const store = new ConversationStore(':memory:');
    resources.push({ store });
    return { store, path: ':memory:' as const };
  }
  const dir = mkdtempSync(join(tmpdir(), 'opendots-conversation-'));
  const path = join(dir, 'test.sqlite');
  const store = new ConversationStore(path);
  resources.push({ store, dir });
  return { store, path };
}
afterEach(() =>
  resources.splice(0).forEach(({ store, dir }) => {
    store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }),
);

describe('conversation admission', () => {
  it('admits a turn with the message and its run committed together (:memory:)', () => {
    const { store } = fixture();
    const { message, run } = store.admitTurn({
      source: 'web_owner',
      threadId: 'thread-1',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'user',
      content: { text: 'hello' },
    });
    expect(message.ordinal).toBe(0);
    expect(store.run(run.id)?.status).toBe('running');
    expect(store.events(run.id)).toHaveLength(1);
    expect(store.events(run.id)[0].payload).toMatchObject({
      type: 'RUN_STARTED',
    });
  });
  it('assigns increasing ordinals per thread as messages are appended', () => {
    const { store } = fixture();
    store.admitTurn({
      source: 'web_owner',
      threadId: 'thread-1',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'user',
      content: { text: 'first' },
    });
    const reply = store.appendMessage({
      threadId: 'thread-1',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'assistant',
      content: { text: 'second' },
    });
    expect(reply.ordinal).toBe(1);
    expect(store.messages('thread-1').map((m) => m.ordinal)).toEqual([0, 1]);
  });
  it('rolls back message, run, and event writes together when the transaction body throws', () => {
    const { store } = fixture();
    const privateStore = store as unknown as {
      transaction: <T>(fn: () => T) => T;
      insertMessage: (params: {
        threadId: string;
        dotId: string;
        ownerId: string;
        role: 'user';
        content: unknown;
      }) => unknown;
      insertRun: (
        threadId: string,
        source: 'web_owner',
        ordinal: number,
      ) => { id: string };
      insertEvent: (
        threadId: string,
        runId: string,
        payload: unknown,
      ) => unknown;
    };
    expect(() =>
      privateStore.transaction(() => {
        privateStore.insertMessage({
          threadId: 'thread-1',
          dotId: 'dot-1',
          ownerId: 'owner-1',
          role: 'user',
          content: { text: 'doomed' },
        });
        const run = privateStore.insertRun('thread-1', 'web_owner', 0);
        privateStore.insertEvent('thread-1', run.id, { type: 'RUN_STARTED' });
        throw new Error('simulated failure mid-turn');
      }),
    ).toThrow('simulated failure mid-turn');
    expect(store.messages('thread-1')).toHaveLength(0);
    expect(store.runs('thread-1')).toHaveLength(0);
  });
});

describe('run terminal transitions', () => {
  it('refuses to finish an already-terminal run and does not append a duplicate event', () => {
    const { store } = fixture();
    const { run } = store.admitTurn({
      source: 'web_owner',
      threadId: 'thread-1',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'user',
      content: { text: 'hello' },
    });
    const finished = store.finishRun(run.id, 'completed');
    expect(() => store.finishRun(run.id, 'failed', 'too late')).toThrow();
    expect(store.run(run.id)?.status).toBe('completed');
    expect(store.run(run.id)?.finishedAt).toBe(finished.finishedAt);
    expect(store.run(run.id)?.error).toBeNull();
    const eventTypes = store
      .events(run.id)
      .map((event) => (event.payload as { type: string }).type);
    expect(eventTypes).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });
});

describe('restart durability', () => {
  it('reads a thread back in ordinal order with no message loss after closing and reopening the handle', () => {
    const { store, path } = fixture(true);
    const { run } = store.admitTurn({
      source: 'web_owner',
      threadId: 'thread-1',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'user',
      content: { text: 'first' },
    });
    store.appendMessage({
      threadId: 'thread-1',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'assistant',
      content: { text: 'second' },
    });
    store.finishRun(run.id, 'completed');
    store.close();
    resources.splice(
      resources.findIndex((resource) => resource.store === store),
      1,
    );

    const reopened = new ConversationStore(path);
    const dir = join(path, '..');
    resources.push({ store: reopened, dir });
    const messages = reopened.messages('thread-1');
    expect(messages.map((m) => m.ordinal)).toEqual([0, 1]);
    expect(messages.map((m) => m.content)).toEqual([
      { text: 'first' },
      { text: 'second' },
    ]);
    expect(reopened.run(run.id)?.status).toBe('completed');
  });
});

describe('connector_inbound uniqueness', () => {
  it('commits an inbound update and its turn atomically and returns null for a duplicate', () => {
    const { store } = fixture();
    const params = {
      platform: 'telegram',
      updateId: 'update-atomic',
      offset: 14,
      threadId: 'thread-atomic',
      dotId: 'dot-1',
      ownerId: 'owner-1',
      role: 'user' as const,
      content: { id: 'message-1', role: 'user', content: 'hello' },
      source: 'channel_owner' as const,
    };
    const admitted = store.admitInboundTurn(params);
    expect(admitted).not.toBeNull();
    expect(store.highWaterOffset('telegram')).toBe(14);
    expect(store.messages('thread-atomic')).toHaveLength(1);
    expect(store.runs('thread-atomic')).toHaveLength(1);
    expect(store.events(admitted!.run.id)).toHaveLength(1);
    expect(store.admitInboundTurn({ ...params, offset: 15 })).toBeNull();
    expect(store.highWaterOffset('telegram')).toBe(14);
    expect(store.messages('thread-atomic')).toHaveLength(1);
    expect(store.runs('thread-atomic')).toHaveLength(1);
  });
  it('rejects a duplicate (platform, update_id) pair via the database constraint', () => {
    const { store } = fixture();
    expect(store.admitInbound('telegram', 'update-1', 1)).toBe(true);
    expect(store.admitInbound('telegram', 'update-1', 2)).toBe(false);
    expect(store.highWaterOffset('telegram')).toBe(1);
  });
  it('allows the same update_id across different platforms', () => {
    const { store } = fixture();
    expect(store.admitInbound('telegram', 'update-1', 1)).toBe(true);
    expect(store.admitInbound('slack', 'update-1', 1)).toBe(true);
  });
});

describe('connector_outbound lifecycle', () => {
  it('tracks pending -> attempting -> delivered with retry count on failure', () => {
    const { store } = fixture();
    const outbound = store.queueOutbound('thread-1', null, { text: 'reply' });
    expect(outbound.status).toBe('pending');
    store.markOutbound(outbound.id, 'attempting');
    store.markOutbound(outbound.id, 'failed', 'network error');
    expect(store.outbound(outbound.id)?.retryCount).toBe(1);
    store.markOutbound(outbound.id, 'attempting');
    store.markOutbound(outbound.id, 'delivered');
    expect(store.outbound(outbound.id)?.status).toBe('delivered');
    expect(store.pendingOutbound('thread-1')).toHaveLength(0);
  });
});

describe('additive schema migration', () => {
  it('adds new columns to an existing file-backed database via ALTER TABLE, without dropping prior rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-conversation-migrate-'));
    const path = join(dir, 'legacy.sqlite');
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE messages(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, toolCallId TEXT, toolResult TEXT, createdAt INTEGER NOT NULL, UNIQUE(threadId, ordinal));
        CREATE TABLE connector_outbound(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, runId TEXT, status TEXT NOT NULL, payload TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
        INSERT INTO messages (id, threadId, dotId, ownerId, ordinal, role, content, createdAt) VALUES ('m1', 'thread-1', 'dot-1', 'owner-1', 0, 'user', '{"text":"legacy"}', 1);
        INSERT INTO connector_outbound (id, threadId, runId, status, payload, error, createdAt, updatedAt) VALUES ('o1', 'thread-1', NULL, 'pending', '{"text":"legacy"}', NULL, 1, 1);`);
      legacy.close();

      const store = new ConversationStore(path);
      resources.push({ store });
      expect(store.messages('thread-1')).toHaveLength(1);
      expect(store.messages('thread-1')[0].metadata).toBeNull();
      expect(store.outbound('o1')?.retryCount).toBe(0);
      store.markOutbound('o1', 'failed', 'retry after migration');
      expect(store.outbound('o1')?.retryCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
