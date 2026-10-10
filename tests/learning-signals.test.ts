import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Observable, lastValueFrom, toArray } from 'rxjs';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import { ConversationRunner } from '../src/server/conversation-runner.js';
import { detectLearningCandidate } from '../src/server/learning.js';
import type {
  AdmittedRunSource,
  ServerTurnSource,
} from '../src/server/conversation-store.js';
import {
  cleanupLearningFixtures,
  enableCollection,
  learningDatabasePath,
  openLearningStores,
  onlyDot,
  rawDatabase,
  sha256,
} from './learning-fixtures.js';
import type { Dot } from '../src/shared/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanupLearningFixtures();
});

interface Script {
  reply?: string;
  /** Tool names the run calls, in order. Arguments are fixed and must never be stored. */
  tools?: string[];
  failure?: string;
  /** Emits the run start and then never finishes, so only a stop can end it. */
  hang?: boolean;
}

/** Stands in for the model: replays a fixed script as AG-UI events. */
class ScriptedAgent extends AbstractAgent {
  private onAbort?: () => void;
  constructor(
    agentId: string,
    private readonly script: Script = {},
  ) {
    super({ agentId });
  }
  clone() {
    return new ScriptedAgent(this.agentId!, this.script);
  }
  // A stop ends the stream with an error, as a real agent's abort does.
  abortRun() {
    this.onAbort?.();
    super.abortRun();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const { reply, tools = [], failure, hang } = this.script;
    return new Observable((subscriber) => {
      this.onAbort = () => subscriber.error(new Error('Run stopped.'));
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      if (hang) return;
      if (failure) {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: failure,
        } as BaseEvent);
        subscriber.complete();
        return;
      }
      const parentMessageId = `reply-${input.runId}`;
      if (reply) {
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId: parentMessageId,
          role: 'assistant',
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: parentMessageId,
          delta: reply,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId: parentMessageId,
        } as BaseEvent);
      }
      tools.forEach((name, index) => {
        const toolCallId = `call-${input.runId}-${index}`;
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: name,
          parentMessageId,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: '{"path":"private/secret.txt"}',
        } as BaseEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `result-${toolCallId}`,
          toolCallId,
          content: 'ok',
        } as BaseEvent);
      });
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

function runRequest(
  threadId: string,
  agent: AbstractAgent,
  messages: Message[],
) {
  return {
    threadId,
    agent,
    input: {
      threadId,
      runId: randomUUID(),
      state: undefined,
      messages,
      tools: [],
      context: [],
      forwardedProps: {},
    },
  };
}

function runEvents(
  runner: ConversationRunner,
  threadId: string,
  agent: AbstractAgent,
  messages: Message[],
  source?: ServerTurnSource,
): Promise<BaseEvent[]> {
  const request = runRequest(threadId, agent, messages);
  const observable = source
    ? runner.runTurn(request, source)
    : runner.run(request);
  return lastValueFrom(observable.pipe(toArray()));
}

function setup() {
  const path = learningDatabasePath();
  const stores = openLearningStores(path);
  const dot = enableCollection(stores.workspace, onlyDot(stores.workspace));
  const runner = new ConversationRunner(stores.conversations, 'owner');
  return { path, ...stores, dot, runner };
}

/** Binds a thread to a Dot, so its consent is copied from the Dot at this moment. */
function bind(
  workspace: ReturnType<typeof openLearningStores>['workspace'],
  threadId: string,
  dot: Dot,
) {
  workspace.bindThread(threadId, dot.id, threadId);
}

/** One completed web-owner turn: the owner asks, the agent calls these tools. */
async function toolTurn(
  runner: ConversationRunner,
  threadId: string,
  dot: Dot,
  tools: string[],
  text = 'Prepare the weekly digest.',
) {
  return runEvents(runner, threadId, new ScriptedAgent(dot.id, { tools }), [
    { id: randomUUID(), role: 'user', content: text },
  ]);
}

function jobsFor(conversations: ReturnType<typeof setup>['conversations']) {
  return conversations.learningJobs();
}

describe('correction signal', () => {
  it.each([
    'Não faça isso assim, prefiro respostas curtas.',
    'Prefiro tabelas nas respostas.',
    'Instead, answer with a table.',
    'Please remember this for later.',
    'NÃO FAÇA isso de novo.',
  ])('enqueues exactly one extraction for the cue in "%s"', async (text) => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-cue', dot);
    const events = await runEvents(
      runner,
      'thread-cue',
      new ScriptedAgent(dot.id, { reply: 'Ok.' }),
      [{ id: 'owner-cue', role: 'user', content: text }],
    );
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    const [run] = conversations.runs('thread-cue');
    const [owner] = conversations.messages('thread-cue');
    const [job] = jobsFor(conversations);
    expect(jobsFor(conversations)).toHaveLength(1);
    expect(job).toMatchObject({
      sourceRunId: run.id,
      threadId: 'thread-cue',
      signal: 'correction',
      state: 'queued',
      patternHash: null,
    });
    expect(job.evidence).toEqual([
      {
        threadId: 'thread-cue',
        runId: run.id,
        messageId: owner.id,
        ordinal: owner.ordinal,
        role: 'user',
        sha256: sha256(JSON.stringify(owner.content)),
        signal: 'correction',
      },
    ]);
  });

  it('keeps one job for a run with several cued owner messages', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-many', dot);
    await runEvents(
      runner,
      'thread-many',
      new ScriptedAgent(dot.id, { reply: 'Ok.' }),
      [
        { id: 'owner-a', role: 'user', content: 'Prefiro tabelas.' },
        { id: 'owner-b', role: 'user', content: 'Remember this too.' },
      ],
    );
    const [run] = conversations.runs('thread-many');
    const jobs = jobsFor(conversations);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      sourceRunId: run.id,
      signal: 'correction',
    });
    expect(jobs[0].evidence).toHaveLength(2);
  });

  it('ignores cues that only the assistant or a plain request contains', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-plain', dot);
    const events = await runEvents(
      runner,
      'thread-plain',
      new ScriptedAgent(dot.id, { reply: 'Prefiro usar a tabela.' }),
      [
        {
          id: 'owner-plain',
          role: 'user',
          content: 'Pesquise o clima de amanhã.',
        },
      ],
    );
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect(conversations.runs('thread-plain')[0].status).toBe('completed');
    expect(jobsFor(conversations)).toEqual([]);
  });
});

describe('repeated-workflow signal', () => {
  const pattern = ['search_web', 'read_page', 'write_note'];

  it('enqueues only the newest of two matching runs of the same Dot, once', async () => {
    const { conversations, workspace, runner, dot } = setup();
    for (const id of ['thread-w1', 'thread-w2', 'thread-w3'])
      bind(workspace, id, dot);
    await toolTurn(runner, 'thread-w1', dot, pattern);
    expect(jobsFor(conversations)).toEqual([]);

    await toolTurn(runner, 'thread-w2', dot, pattern);
    const second = conversations.runs('thread-w2')[0];
    const afterSecond = jobsFor(conversations);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toMatchObject({
      sourceRunId: second.id,
      signal: 'repeated_workflow',
      state: 'queued',
    });
    expect(afterSecond[0].patternHash).toMatch(/^[0-9a-f]{64}$/);
    expect(afterSecond[0].evidence.map((record) => record.runId)).toEqual([
      second.id,
      conversations.runs('thread-w1')[0].id,
    ]);
    expect(
      afterSecond[0].evidence.every(
        (record) =>
          record.role === 'assistant' && record.signal === 'repeated_workflow',
      ),
    ).toBe(true);

    await toolTurn(runner, 'thread-w3', dot, pattern);
    const third = conversations.runs('thread-w3')[0];
    expect(jobsFor(conversations).map((job) => job.sourceRunId)).toEqual([
      second.id,
      third.id,
    ]);
  });

  it('hashes tool names and never stores tool arguments', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-hash-1', dot);
    bind(workspace, 'thread-hash-2', dot);
    await toolTurn(runner, 'thread-hash-1', dot, pattern);
    await toolTurn(runner, 'thread-hash-2', dot, pattern);
    const [job] = jobsFor(conversations);
    const stored = JSON.stringify(job);
    for (const name of pattern) expect(stored).not.toContain(name);
    expect(stored).not.toContain('private/secret.txt');
    expect(job.patternHash).toBe(
      sha256(JSON.stringify(pattern.map((name) => sha256(name)))),
    );
  });

  it('ignores a different ordered pattern and any pattern under three calls', async () => {
    const { conversations, workspace, runner, dot } = setup();
    for (const id of ['thread-d1', 'thread-d2', 'thread-s1', 'thread-s2'])
      bind(workspace, id, dot);
    await toolTurn(runner, 'thread-d1', dot, [
      'search_web',
      'write_note',
      'read_page',
    ]);
    await toolTurn(runner, 'thread-d2', dot, [
      'search_web',
      'read_page',
      'write_note',
    ]);
    await toolTurn(runner, 'thread-s1', dot, ['search_web', 'read_page']);
    await toolTurn(runner, 'thread-s2', dot, ['search_web', 'read_page']);
    expect(jobsFor(conversations)).toEqual([]);
  });

  /**
   * A still-running web-owner run whose bounds hold a tool result and the
   * assistant tool calls that answer it, but no direct owner message: the tool
   * continuation the runner admits as its own run.
   */
  function toolOnlyRun(
    conversations: ReturnType<typeof setup>['conversations'],
    workspace: ReturnType<typeof setup>['workspace'],
    dot: Dot,
    threadId: string,
  ) {
    bind(workspace, threadId, dot);
    const admitted = conversations.admitTurn({
      threadId,
      dotId: dot.id,
      ownerId: 'owner',
      role: 'tool',
      content: {
        id: `tool-${threadId}`,
        role: 'tool',
        toolCallId: `call-${threadId}`,
        content: 'ok',
      },
      toolCallId: `call-${threadId}`,
      source: 'web_owner',
    });
    conversations.appendMessage({
      threadId,
      dotId: dot.id,
      ownerId: 'owner',
      role: 'assistant',
      content: {
        id: `assistant-${threadId}`,
        role: 'assistant',
        toolCalls: pattern.map((name, index) => ({
          id: `call-${threadId}-${index}`,
          type: 'function',
          function: { name, arguments: '{}' },
        })),
      },
      runId: admitted.run.id,
    });
    return conversations.run(admitted.run.id)!;
  }

  it('ignores a tool-only run as the repeated-workflow candidate', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-prior', dot);
    await toolTurn(runner, 'thread-prior', dot, pattern);
    const candidate = toolOnlyRun(
      conversations,
      workspace,
      dot,
      'thread-candidate',
    );
    const detected = detectLearningCandidate(conversations, candidate);
    expect(detected).toBeNull();
    conversations.finishRunWithLearning(
      candidate.id,
      'completed',
      null,
      detected,
    );
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('ignores a tool-only run as a repeated-workflow comparison run', async () => {
    const { conversations, workspace, runner, dot } = setup();
    const comparison = toolOnlyRun(
      conversations,
      workspace,
      dot,
      'thread-comparison',
    );
    conversations.finishRun(comparison.id, 'completed');
    bind(workspace, 'thread-candidate', dot);
    await toolTurn(runner, 'thread-candidate', dot, pattern);
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('ignores a matching run from a Dot that is not the same Dot', async () => {
    const { conversations, workspace, runner, dot } = setup();
    const other = workspace.createDot(
      dot.spaceId,
      'Other Dot',
      'Help.',
      true,
      true,
      [dot.spaceId],
      null,
      false,
      true,
    );
    bind(workspace, 'thread-same', dot);
    bind(workspace, 'thread-other', other);
    await toolTurn(runner, 'thread-same', dot, pattern);
    await toolTurn(runner, 'thread-other', other, pattern);
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('ignores a matching run on a thread that is not enrolled', async () => {
    const { conversations, workspace, runner, dot, path } = setup();
    bind(workspace, 'thread-legacy', dot);
    rawDatabase(path)
      .prepare('UPDATE thread_bindings SET localLearningEnrolled=0 WHERE id=?')
      .run('thread-legacy');
    bind(workspace, 'thread-current', dot);
    await toolTurn(runner, 'thread-legacy', dot, pattern);
    await toolTurn(runner, 'thread-current', dot, pattern);
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('ignores a matching run older than seven days', async () => {
    const { conversations, workspace, runner, dot, path } = setup();
    bind(workspace, 'thread-old', dot);
    bind(workspace, 'thread-new', dot);
    await toolTurn(runner, 'thread-old', dot, pattern);
    rawDatabase(path)
      .prepare(
        'UPDATE conversation_runs SET startedAt = startedAt - ? WHERE threadId = ?',
      )
      .run(8 * 24 * 60 * 60 * 1000, 'thread-old');
    await toolTurn(runner, 'thread-new', dot, pattern);
    expect(jobsFor(conversations)).toEqual([]);
  });

  // Each fixture run is a real completed turn, so these take a while on a slow disk.
  const SLOW_TEST_MS = 30_000;

  /** One matching run, then `fillers` non-matching runs, then the run being judged. */
  async function matchAfterFillers(fillers: number) {
    const fixture = setup();
    bind(fixture.workspace, 'match', fixture.dot);
    await toolTurn(fixture.runner, 'match', fixture.dot, pattern);
    for (let i = 0; i < fillers; i += 1) {
      bind(fixture.workspace, `filler-${i}`, fixture.dot);
      await toolTurn(fixture.runner, `filler-${i}`, fixture.dot, [
        `filler_${i}_a`,
        `filler_${i}_b`,
        `filler_${i}_c`,
      ]);
    }
    bind(fixture.workspace, 'current', fixture.dot);
    await toolTurn(fixture.runner, 'current', fixture.dot, pattern);
    return jobsFor(fixture.conversations);
  }

  // The matching run is the 19th most recent earlier run: still compared.
  it(
    'compares the matching run that is within the last twenty eligible runs',
    async () => {
      const jobs = await matchAfterFillers(18);
      expect(jobs.map((job) => job.threadId)).toEqual(['current']);
    },
    SLOW_TEST_MS,
  );

  // The matching run is the 20th most recent earlier run: never compared.
  it(
    'does not compare a matching run beyond the last twenty eligible runs',
    async () => {
      expect(await matchAfterFillers(19)).toEqual([]);
    },
    SLOW_TEST_MS,
  );
});

describe('eligibility', () => {
  it.each<AdmittedRunSource>([
    'scheduled_task',
    'voice_compute',
    'voice_receipt',
  ])(
    'queues no job for a %s run even with a correction cue',
    async (source) => {
      const { conversations, workspace, runner, dot } = setup();
      bind(workspace, `thread-${source}`, dot);
      const events = await runEvents(
        runner,
        `thread-${source}`,
        new ScriptedAgent(dot.id, { reply: 'Ok.' }),
        [{ id: `owner-${source}`, role: 'user', content: 'Prefiro tabelas.' }],
        source as ServerTurnSource,
      );
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
      expect(conversations.runs(`thread-${source}`)[0]).toMatchObject({
        source,
        status: 'completed',
      });
      expect(jobsFor(conversations)).toEqual([]);
    },
  );

  it('queues no job for a channel run', () => {
    const { conversations, workspace, dot } = setup();
    workspace.bindThread('telegram-7', dot.id, 'Telegram');
    const admitted = conversations.admitInboundTurn({
      platform: 'telegram',
      updateId: 'update-7',
      offset: 7,
      threadId: 'telegram-7',
      dotId: dot.id,
      ownerId: 'owner',
      role: 'user',
      content: { id: 'channel-7', role: 'user', content: 'Prefiro tabelas.' },
      source: 'channel_owner',
    });
    expect(detectLearningCandidate(conversations, admitted!.run)).toBeNull();
  });

  it('queues no job for a failed run', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-failed', dot);
    const events = await runEvents(
      runner,
      'thread-failed',
      new ScriptedAgent(dot.id, { failure: 'Provider failed.' }),
      [{ id: 'owner-failed', role: 'user', content: 'Prefiro tabelas.' }],
    );
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
    expect(conversations.runs('thread-failed')[0].status).toBe('failed');
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('queues no job for an interrupted run', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-stopped', dot);
    const pending = runEvents(
      runner,
      'thread-stopped',
      new ScriptedAgent(dot.id, { hang: true }),
      [{ id: 'owner-stopped', role: 'user', content: 'Prefiro tabelas.' }],
    ).catch(() => undefined);
    await vi.waitFor(async () =>
      expect(await runner.isRunning({ threadId: 'thread-stopped' })).toBe(true),
    );
    await runner.stop({ threadId: 'thread-stopped' });
    await pending;
    expect(conversations.runs('thread-stopped')[0].status).toBe('interrupted');
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('queues no job for a thread that has no owner binding', async () => {
    const { conversations, runner, dot } = setup();
    const events = await runEvents(
      runner,
      'thread-unowned',
      new ScriptedAgent(dot.id, { reply: 'Ok.' }),
      [{ id: 'owner-unowned', role: 'user', content: 'Prefiro tabelas.' }],
    );
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect(conversations.runs('thread-unowned')[0].status).toBe('completed');
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('queues no job for a legacy thread that was not enrolled', async () => {
    const { conversations, workspace, runner, dot, path } = setup();
    bind(workspace, 'thread-optout', dot);
    rawDatabase(path)
      .prepare('UPDATE thread_bindings SET localLearningEnrolled=0 WHERE id=?')
      .run('thread-optout');
    await runEvents(
      runner,
      'thread-optout',
      new ScriptedAgent(dot.id, { reply: 'Ok.' }),
      [{ id: 'owner-optout', role: 'user', content: 'Prefiro tabelas.' }],
    );
    expect(conversations.runs('thread-optout')[0].status).toBe('completed');
    expect(jobsFor(conversations)).toEqual([]);
  });

  it('queues no job once the Dot stops allowing learning', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-disabled', dot);
    workspace.updateDot(dot.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      learningEnabled: false,
    });
    await runEvents(
      runner,
      'thread-disabled',
      new ScriptedAgent(dot.id, { reply: 'Ok.' }),
      [{ id: 'owner-disabled', role: 'user', content: 'Prefiro tabelas.' }],
    );
    expect(jobsFor(conversations)).toEqual([]);
  });
});

describe('deduplication and failure isolation', () => {
  it('rejects a second job for the same source run and still completes it', async () => {
    const { conversations, workspace, dot, path } = setup();
    bind(workspace, 'thread-dup', dot);
    // An open run that already has a job row, as a concurrent writer would leave it.
    const admitted = conversations.admitTurn({
      threadId: 'thread-dup',
      dotId: dot.id,
      ownerId: 'owner',
      role: 'user',
      content: { id: 'owner-dup', role: 'user', content: 'Prefiro tabelas.' },
      source: 'web_owner',
    });
    rawDatabase(path)
      .prepare(
        `INSERT INTO learning_jobs (id, ownerId, dotId, threadId, sourceRunId, signal, state, evidence, sourceDigest, consentRevision, createdAt)
         VALUES (?, 'owner', ?, 'thread-dup', ?, 'correction', 'queued', '[]', ?, 0, ?)`,
      )
      .run(
        randomUUID(),
        dot.id,
        admitted.run.id,
        sha256('earlier'),
        Date.now(),
      );
    const finished = conversations.finishRunWithLearning(
      admitted.run.id,
      'completed',
      null,
      detectLearningCandidate(conversations, admitted.run),
    );
    expect(finished.skipped).toBe('duplicate_run');
    expect(finished.run.status).toBe('completed');
    expect(jobsFor(conversations)).toHaveLength(1);
  });

  it('enforces one job per owner and source run in the database', () => {
    const { conversations, workspace, dot, path } = setup();
    bind(workspace, 'thread-unique', dot);
    const { run } = conversations.admitTurn({
      threadId: 'thread-unique',
      dotId: dot.id,
      ownerId: 'owner',
      role: 'user',
      content: {
        id: 'owner-unique',
        role: 'user',
        content: 'Prefiro tabelas.',
      },
      source: 'web_owner',
    });
    const insert = rawDatabase(path).prepare(
      `INSERT INTO learning_jobs (id, ownerId, dotId, threadId, sourceRunId, signal, state, evidence, sourceDigest, consentRevision, createdAt)
       VALUES (?, 'owner', ?, 'thread-unique', ?, 'correction', 'queued', '[]', ?, 0, ?)`,
    );
    insert.run(randomUUID(), dot.id, run.id, sha256('a'), Date.now());
    expect(() =>
      insert.run(randomUUID(), dot.id, run.id, sha256('b'), Date.now()),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('never surfaces a detection failure to the chat', async () => {
    const { conversations, workspace, runner, dot } = setup();
    bind(workspace, 'thread-broken', dot);
    vi.spyOn(conversations, 'boundedMessageDigests').mockImplementation(() => {
      throw new Error('detector broke');
    });
    const events = await runEvents(
      runner,
      'thread-broken',
      new ScriptedAgent(dot.id, { reply: 'Ok.' }),
      [{ id: 'owner-broken', role: 'user', content: 'Prefiro tabelas.' }],
    );
    expect(events.map((event) => event.type)).not.toContain(
      EventType.RUN_ERROR,
    );
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect(conversations.runs('thread-broken')[0].status).toBe('completed');
    expect(jobsFor(conversations)).toEqual([]);
  });
});
