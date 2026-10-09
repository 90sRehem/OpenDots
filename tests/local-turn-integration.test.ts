import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { from, Observable, Subject } from 'rxjs';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { ConversationStore } from '../src/server/conversation-store.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { VoiceService } from '../src/server/voice.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { voiceReceiptMessagePrefix } from '../src/shared/voice-receipt.js';

// File-backed server path: the same database file is opened by the stores
// and the platform, as index.ts does at startup. Only the model is stubbed.

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
// Each handle is closed once by the test itself, and again here if needed.
const safely = (close: () => void) => () => {
  try {
    close();
  } catch {
    // Already closed (a test simulated a shutdown or a crash).
  }
};

const config: PlatformConfig = {
  apiKey: 'model-key',
  model: 'model-id',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceKey: 'voice-key',
  voiceModel: 'voice-model',
  voiceName: 'marin',
  slackUsers: [],
};

function openDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-local-turns-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'opendots.sqlite');
}

function open(database: string) {
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  const conversationStore = new ConversationStore(database);
  cleanup.push(
    safely(() => store.close()),
    safely(() => workspace.close()),
    safely(() => conversationStore.close()),
  );
  const platform = new Platform(store, workspace, config, conversationStore);
  return { store, workspace, conversationStore, platform };
}

// --- model stub ----------------------------------------------------------------

let modelRuns = 0;
let onHeld: (() => void) | undefined;
let held: Subject<BaseEvent> | undefined;

function lastUserText(input: RunAgentInput) {
  const message = input.messages.filter((item) => item.role === 'user').at(-1);
  return typeof message?.content === 'string' ? message.content : '';
}

function answer(input: RunAgentInput): Observable<BaseEvent> {
  const messageId = `reply-${input.runId}`;
  return from([
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: `Answer to: ${lastUserText(input)}`,
    },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[]);
}

/** The next model run stays open until the runtime aborts it. */
function holdNextModelRun() {
  return new Promise<void>((resolve) => {
    onHeld = resolve;
  });
}

function mockModel() {
  modelRuns = 0;
  onHeld = undefined;
  held = undefined;
  vi.spyOn(DotAgent.prototype, 'run').mockImplementation((input) => {
    modelRuns += 1;
    if (onHeld) {
      const resolve = onHeld;
      onHeld = undefined;
      held = new Subject<BaseEvent>();
      resolve();
      return held.asObservable();
    }
    return answer(input);
  });
  vi.spyOn(DotAgent.prototype, 'abortRun').mockImplementation(() => {
    held?.error(new Error('Model stream aborted.'));
    held = undefined;
  });
}

// --- web chat ------------------------------------------------------------------

/** A browser-equivalent AG-UI client, routed in-process through the platform. */
function webChat(platform: Platform, dotId: string, threadId: string) {
  const localFetch: typeof fetch = async (input, init) =>
    platform.handle(
      input instanceof Request ? input : new Request(input, init),
    );
  const agent = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: 'http://probe.invalid/api/copilotkit',
    agentId: `chat-${threadId}`,
    runtimeAgentId: dotId,
    fetch: localFetch,
  });
  agent.threadId = threadId;
  return agent;
}

// --- tests -----------------------------------------------------------------------

it('gives a scheduled task and a web-chat message one canonical thread that both read back', async () => {
  mockModel();
  const { platform, workspace } = open(openDatabase());
  const dot = workspace.dots()[0];
  const thread = await platform.createConversation(dot.id, 'Work');
  workspace.bindTask('task-1', thread.id);

  const chat = webChat(platform, dot.id, thread.id);
  await chat.connectAgent();
  chat.addMessage({ id: 'web-1', role: 'user', content: 'Web question' });
  await chat.runAgent({ runId: 'run-web' });

  const reply = await platform.turn(
    workspace.taskThread('task-1')!,
    'Check the report',
    new AbortController().signal,
    { opendotsSource: 'scheduled_task' },
  );
  expect(reply).toBe('Answer to: Check the report');
  expect(modelRuns).toBe(2);
  // Neither path created a second thread.
  expect(workspace.conversations()).toHaveLength(1);
  expect(await platform.history(thread.id)).toBe(
    [
      'user: Web question',
      'assistant: Answer to: Web question',
      'user: Check the report',
      'assistant: Answer to: Check the report',
    ].join('\n'),
  );

  // A browser reconnecting reads the stored transcript without a model rerun.
  const reader = webChat(platform, dot.id, thread.id);
  await reader.connectAgent();
  expect(reader.messages.map((message) => message.content)).toEqual([
    'Web question',
    'Answer to: Web question',
    'Check the report',
    'Answer to: Check the report',
  ]);
  expect(modelRuns).toBe(2);
});

it('saves a page conversation from the same committed transcript used by direct chat', async () => {
  mockModel();
  const { platform, workspace, conversationStore } = open(openDatabase());
  const dot = workspace.dots()[0];
  const page = workspace.pages.create(dot.spaceId, {
    title: 'Page conversation',
  });
  const thread = await platform.pages.conversation(
    dot.spaceId,
    page.id,
    dot.id,
  );

  expect(
    await platform.turn(
      thread.id,
      'Page question',
      new AbortController().signal,
    ),
  ).toBe('Answer to: Page question');
  expect(workspace.conversations()).toHaveLength(1);
  expect(
    conversationStore.messages(thread.id).map((message) => message.role),
  ).toEqual(['user', 'assistant']);

  const saved = await platform.pages.saveConversation(thread.id, 'Saved', null);
  expect(saved.content).toBe(
    '## You\n\nPage question\n\n## Dot\n\nAnswer to: Page question',
  );
});

it('runs voice compute and the call receipt on the existing thread, and drops a duplicate receipt', async () => {
  mockModel();
  const database = openDatabase();
  const { platform, workspace, conversationStore } = open(database);
  const dot = workspace.dots()[0];
  const thread = await platform.createConversation(dot.id, 'Phone');
  await webChat(platform, dot.id, thread.id).connectAgent();
  await platform.turn(
    thread.id,
    'Earlier question',
    new AbortController().signal,
  );

  const transport = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/hangup')
      ? new Response(null, { status: 200 })
      : new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
          headers: { location: '/v1/realtime/calls/rtc_test' },
        }),
  );
  const voice = new VoiceService(platform, transport);
  const call = await voice.begin(
    thread.id,
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111',
    new AbortController().signal,
  );
  // Voice speaks from the canonical history, not a separate context.
  const session = String(
    (transport.mock.calls[0][1]?.body as FormData).get('session'),
  );
  expect(session).toContain('assistant: Answer to: Earlier question');

  voice.activate(call.id);
  expect(await voice.compute(call.id, 'tool-1', 'Look up the weather')).toBe(
    'Answer to: Look up the weather',
  );
  await voice.end(call.id, 'Caller asked about the weather');
  const afterCall = modelRuns;
  expect(afterCall).toBe(3);

  // A duplicate end with a late transcript must not start a second receipt.
  const again = await voice.end(call.id, 'A duplicate transcript');
  expect(again.transcript).toBe('Caller asked about the weather');
  expect(modelRuns).toBe(afterCall);
  const receipts = conversationStore
    .messages(thread.id)
    .filter((message) =>
      (message.content as { id: string }).id.startsWith(
        voiceReceiptMessagePrefix,
      ),
    );
  expect(receipts).toHaveLength(1);
  expect(await platform.history(thread.id)).toContain(
    'Caller asked about the weather',
  );
});

it('records a turn in progress at shutdown as interrupted and never resumes it on the next start', async () => {
  mockModel();
  const database = openDatabase();
  const first = open(database);
  const dot = first.workspace.dots()[0];
  const thread = await first.platform.createConversation(dot.id, 'Long task');
  first.workspace.bindTask('task-2', thread.id);

  const started = holdNextModelRun();
  const turn = first.platform.turn(
    thread.id,
    'Long scheduled task',
    new AbortController().signal,
    { opendotsSource: 'scheduled_task' },
  );
  const outcome = turn.then(
    () => 'resolved',
    (error: Error) => error.message,
  );
  await started;
  await first.platform.stop();
  expect(await outcome).toBe('Server is stopping.');
  expect(modelRuns).toBe(1);

  // Read the database as the next process sees it.
  const reader = new ConversationStore(database);
  cleanup.push(safely(() => reader.close()));
  expect(reader.runs(thread.id).map((run) => run.status)).toEqual([
    'interrupted',
  ]);
  expect(reader.runs(thread.id)[0].error).toContain('Run stopped by request');

  const second = open(database);
  expect(
    await second.platform.turn(
      thread.id,
      'Next question',
      new AbortController().signal,
    ),
  ).toBe('Answer to: Next question');
  expect(modelRuns).toBe(2);
  expect(
    second.conversationStore.runs(thread.id).map((run) => run.status),
  ).toEqual(['interrupted', 'completed']);
});

it('marks work left open by a crashed process interrupted at startup and never reruns it', async () => {
  mockModel();
  const database = openDatabase();
  const first = open(database);
  const dot = first.workspace.dots()[0];
  const thread = await first.platform.createConversation(dot.id, 'Crash');
  const call = first.workspace.createCall(thread.id);
  first.workspace.setCall(call.id, 'active', '');
  first.conversationStore.admitTurn({
    threadId: thread.id,
    dotId: dot.id,
    ownerId: 'owner',
    role: 'user',
    content: { id: 'unfinished', role: 'user', content: 'Unfinished task' },
  });
  // The process dies here: no stop() and no graceful close.
  first.conversationStore.close();
  first.workspace.close();
  first.store.close();

  const second = open(database);
  const [run] = second.conversationStore.runs(thread.id);
  expect(run.status).toBe('interrupted');
  expect(run.error).toContain('server process restarted');
  expect(second.workspace.call(call.id)).toMatchObject({
    status: 'failed',
    endedAt: expect.any(Number),
  });
  expect(second.workspace.call(call.id).error).toContain(
    'interrupted by a server restart',
  );
  expect(modelRuns).toBe(0);

  expect(
    await second.platform.turn(
      thread.id,
      'Fresh question',
      new AbortController().signal,
    ),
  ).toBe('Answer to: Fresh question');
  expect(modelRuns).toBe(1);
});
