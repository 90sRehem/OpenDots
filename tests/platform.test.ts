import { afterEach, expect, it } from 'vitest';
import { ConversationStore } from '../src/server/conversation-store.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function fixture(config: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const conversationStore = new ConversationStore(':memory:');
  cleanup.push(() => {
    store.close();
    workspace.close();
    conversationStore.close();
  });
  const platform = new Platform(
    store,
    workspace,
    {
      apiKey: 'model-key',
      model: 'model-id',
      baseUrl: 'https://example.com',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      ...config,
    },
    conversationStore,
  );
  return { platform, workspace, conversationStore };
}

it('serves the SSE runtime and reports ready without Intelligence configuration', async () => {
  const { platform } = fixture();
  const response = await platform.handle(
    new Request('http://localhost/api/copilotkit/info'),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).mode).toBe('sse');
  expect(platform.setup()).toMatchObject({
    intelligence: false,
    model: true,
    missing: [],
  });
  expect(() => platform.requireReady()).not.toThrow();
});

it.each([
  [{ apiKey: undefined }, ['OPENAI_API_KEY']],
  [{ model: undefined }, ['OPENAI_MODEL']],
])('keeps model setup fail-closed for %o', (override, missing) => {
  const { platform } = fixture(override);
  expect(platform.setup().missing).toEqual(missing);
  expect(() => platform.requireReady()).toThrow(
    `Setup required: ${missing.join(', ')}.`,
  );
});

it('binds conversations locally and reads bounded history from the durable store', async () => {
  const { platform, workspace, conversationStore } = fixture();
  const dot = workspace.dots()[0];
  const thread = await platform.createConversation(dot.id, 'Local');
  expect(workspace.requireThread(thread.id, dot.id)).toMatchObject({
    title: 'Local',
  });
  conversationStore.appendMessage({
    threadId: thread.id,
    dotId: dot.id,
    ownerId: workspace.ownerId,
    role: 'user',
    content: { id: 'user-1', role: 'user', content: 'Question' },
  });
  conversationStore.appendMessage({
    threadId: thread.id,
    dotId: dot.id,
    ownerId: workspace.ownerId,
    role: 'assistant',
    content: { id: 'answer-1', role: 'assistant', content: 'Answer' },
  });
  expect(await platform.history(thread.id)).toBe(
    'user: Question\nassistant: Answer',
  );
});

it('backs page conversations and saved page text with the durable store', async () => {
  const { platform, workspace, conversationStore } = fixture();
  const dot = workspace.dots()[0];
  const page = workspace.pages.create(dot.spaceId, {
    title: 'Page conversation',
  });
  const thread = await platform.pages.conversation(
    dot.spaceId,
    page.id,
    dot.id,
  );
  conversationStore.appendMessage({
    threadId: thread.id,
    dotId: dot.id,
    ownerId: workspace.ownerId,
    role: 'user',
    content: { id: 'question', role: 'user', content: 'Page question' },
  });
  const saved = await platform.pages.saveConversation(thread.id, 'Saved', null);
  expect(saved.content).toBe('## You\n\nPage question');
});
