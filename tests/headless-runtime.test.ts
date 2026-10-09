import { afterEach, expect, it } from 'vitest';
import { Observable, Subject } from 'rxjs';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { ConversationStore } from '../src/server/conversation-store.js';
import { ConversationRunner } from '../src/server/conversation-runner.js';
import { runThreadTurn } from '../src/server/headless.js';

// Turns run on the real local runner over an in-memory store. The agents
// below stand in for the model; nothing here reaches a provider.

class ReplyAgent extends AbstractAgent {
  calls = 0;
  constructor(
    agentId: string,
    private reply: string | undefined,
  ) {
    super({ agentId });
  }
  clone() {
    return new ReplyAgent(this.agentId!, this.reply);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.calls += 1;
    const messageId = `reply-${input.runId}`;
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      if (this.reply !== undefined) {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: 'assistant',
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: this.reply,
        });
        subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId });
      }
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

/** Starts a run and then never finishes it, until the runner aborts it. */
class HangingAgent extends AbstractAgent {
  aborted = false;
  started: Promise<void>;
  private resolveStarted!: () => void;
  private current?: Subject<BaseEvent>;
  constructor(agentId: string) {
    super({ agentId });
    this.started = new Promise((resolve) => (this.resolveStarted = resolve));
  }
  clone() {
    return new HangingAgent(this.agentId!);
  }
  abortRun() {
    this.aborted = true;
    this.current?.error(new Error('Aborted'));
  }
  run(): Observable<BaseEvent> {
    this.current = new Subject<BaseEvent>();
    this.resolveStarted();
    return this.current.asObservable();
  }
}

class FailingAgent extends AbstractAgent {
  constructor(agentId: string) {
    super({ agentId });
  }
  clone() {
    return new FailingAgent(this.agentId!);
  }
  run(): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_ERROR,
        message: 'Provider failed',
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

const stores: ConversationStore[] = [];
function fixture() {
  const store = new ConversationStore(':memory:');
  stores.push(store);
  return { store, runner: new ConversationRunner(store, 'owner-1') };
}
afterEach(() => stores.splice(0).forEach((store) => store.close()));

it('runs a voice receipt on the local runner and commits the marked prompt and reply to the thread', async () => {
  const { store, runner } = fixture();
  const agent = new ReplyAgent('dot-1', 'Confirmed receipt');
  expect(
    await runThreadTurn(
      runner,
      agent,
      'thread-receipt',
      'Record my call',
      new AbortController().signal,
      { opendotsSource: 'voice_receipt' },
    ),
  ).toBe('Confirmed receipt');
  expect(agent.calls).toBe(1);
  const [prompt, reply] = store.messages('thread-receipt');
  expect(prompt).toMatchObject({ role: 'user' });
  expect(prompt.content).toMatchObject({
    id: expect.stringMatching(/^opendots:voice_receipt:/),
    role: 'user',
    content: 'Record my call',
    metadata: { opendotsSource: 'voice_receipt' },
  });
  expect(reply.role).toBe('assistant');
  expect(reply.content).toMatchObject({ role: 'assistant' });
});

it('marks a scheduled prompt with its own prefix and keeps the user role', async () => {
  const { store, runner } = fixture();
  await runThreadTurn(
    runner,
    new ReplyAgent('dot-1', 'Scheduled task complete'),
    'thread-task',
    'Check the nightly report',
    new AbortController().signal,
    { opendotsSource: 'scheduled_task' },
  );
  expect(store.messages('thread-task')[0].content).toMatchObject({
    id: expect.stringMatching(/^opendots:scheduled_task:/),
    role: 'user',
    content: 'Check the nightly report',
  });
});

it('stops an in-flight turn through the runner, records it interrupted, and reports the caller reason', async () => {
  const { store, runner } = fixture();
  const agent = new HangingAgent('dot-1');
  const controller = new AbortController();
  const turn = runThreadTurn(
    runner,
    agent,
    'thread-cancel',
    'Call',
    controller.signal,
  );
  await agent.started;
  controller.abort(new Error('Call ended'));
  await expect(turn).rejects.toThrow('Call ended');
  expect(agent.aborted).toBe(true);
  expect(store.runs('thread-cancel')[0].status).toBe('interrupted');
  expect(await runner.isRunning({ threadId: 'thread-cancel' })).toBe(false);
});

it('never calls the model for a turn whose caller gave up while it waited behind another run', async () => {
  const { store, runner } = fixture();
  const blocking = new HangingAgent('dot-1');
  const first = runThreadTurn(
    runner,
    blocking,
    'thread-queue',
    'First',
    new AbortController().signal,
  );
  await blocking.started;

  const queued = new ReplyAgent('dot-1', 'Should not be written');
  const controller = new AbortController();
  const second = runThreadTurn(
    runner,
    queued,
    'thread-queue',
    'Second',
    controller.signal,
  );
  controller.abort(new Error('Gave up waiting'));
  await runner.stop({ threadId: 'thread-queue' });

  await expect(first).rejects.toThrow('Run stopped by request');
  await expect(second).rejects.toThrow('Gave up waiting');
  expect(queued.calls).toBe(0);
  expect(
    store
      .messages('thread-queue')
      .some((message) => message.role === 'assistant'),
  ).toBe(false);
});

it('surfaces a provider failure as the turn error and records the run failed', async () => {
  const { store, runner } = fixture();
  await expect(
    runThreadTurn(
      runner,
      new FailingAgent('dot-1'),
      'thread-fail',
      'Call',
      new AbortController().signal,
    ),
  ).rejects.toThrow('Provider failed');
  expect(store.runs('thread-fail')[0].status).toBe('failed');
});

it('rejects a turn that produces no assistant text rather than reusing an earlier answer', async () => {
  const { store, runner } = fixture();
  await runThreadTurn(
    runner,
    new ReplyAgent('dot-1', 'Earlier answer'),
    'thread-silent',
    'First',
    new AbortController().signal,
  );
  await expect(
    runThreadTurn(
      runner,
      new ReplyAgent('dot-1', undefined),
      'thread-silent',
      'Second',
      new AbortController().signal,
    ),
  ).rejects.toThrow('no assistant response');
  expect(store.runs('thread-silent').map((run) => run.status)).toEqual([
    'completed',
    'completed',
  ]);
});
