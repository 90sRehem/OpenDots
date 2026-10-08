import { Observable, ReplaySubject } from 'rxjs';
import {
  AbstractAgent,
  compactEvents,
  EventType,
  type BaseEvent,
  type Message,
} from '@ag-ui/client';
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';
import {
  ConversationStore,
  type ConversationRun,
  type MessageRole,
  type RunStatus,
} from './conversation-store.js';

const RESTART_INTERRUPT_REASON =
  'Run interrupted because the server process restarted. Review completed effects before retrying.';
const STOP_INTERRUPT_REASON =
  'Run stopped by request. Review completed effects before retrying.';

interface ActiveRun {
  run: ConversationRun;
  runId: string;
  agent: AbstractAgent;
  liveSubject: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
}

/**
 * Durable `AgentRunner` (`run`/`connect`/`isRunning`/`stop`) backed by
 * `conversation-store.ts`. This is the seam PRD §4 (W01) and
 * technical-contract.md §3.2 describe: it replaces the SDK's process-global,
 * non-durable `InMemoryAgentRunner` default with an application-owned SQLite
 * transcript, while reusing CopilotKit's own OSS SSE handlers/encoder
 * unchanged (nothing here reimplements `/info`, SSE framing, or the AG-UI
 * wire protocol).
 *
 * Four properties fall directly out of that role:
 *  - **Admission rule** (technical-contract.md §2): only new user text or a
 *    valid, expected frontend-tool response is ever written to the
 *    transcript. The client resends its whole message array on every `run`
 *    (standard AG-UI behavior) — this runner diffs that array against the
 *    canonical history already in the store (by AG-UI message id, since the
 *    full original `Message` object is what is stored as `content`) and
 *    only ever *admits* ids it has not already seen, after validating the
 *    new ones are a `user` message or a `tool` message answering a toolCall
 *    this thread's own assistant history is still waiting on. A resend of an
 *    already-known id is never used to overwrite the canonical copy — it is
 *    simply ignored, so a tampered resend of history is inert by
 *    construction, not by an extra check. A forged or unexpected new message
 *    (an injected `assistant` message, or a `tool` reply to a toolCallId
 *    nothing is waiting on) fails the whole admission for that `run` call:
 *    nothing is written, and the caller gets a `RUN_ERROR`.
 *  - **Commit before publish**: every AG-UI event the agent emits is written
 *    to `ag_ui_events` before it reaches any subscriber (the original caller
 *    or a `connect()` viewer), so a crash between "emitted" and "visible" can
 *    never happen.
 *  - **Per-thread serialization**: `run()` calls for the same `threadId` are
 *    queued and execute strictly one after another; different threads run
 *    concurrently and independently.
 *  - **Restart durability, not silent resume**: this process never resumes a
 *    run it did not itself start. The first time any method touches a
 *    thread, any `runs` row still `running` that this process is not itself
 *    tracking predates this process (a crash or a kill, not a clean stop) and
 *    is marked `interrupted` — mirroring `store.ts`'s own `invalidate()`
 *    "review completed effects before retrying" stance — never replayed or
 *    resumed automatically.
 */
export class ConversationRunner extends AgentRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: ConversationStore,
    private readonly ownerId: string,
  ) {
    super();
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    // Queuing happens outside the returned Observable on purpose: unlike a
    // request-scoped execution, this run must keep going even if the
    // originating transport disconnects (a late `connect()` can still see
    // it finish), so nothing here is wired to the subject's subscribers.
    void this.enqueue(request.threadId, () =>
      this.executeRun(request, subject),
    );
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const { threadId } = request;
    this.reconcileThread(threadId);
    const active = this.active.get(threadId);
    // The active run's own events are sourced live from its buffered
    // `liveSubject` below (which has replayed everything since that run
    // started), so the historic DB read excludes it to avoid emitting every
    // one of its events twice.
    const historic: BaseEvent[] = [];
    for (const run of this.store.runs(threadId)) {
      if (active && run.id === active.run.id) continue;
      for (const event of this.store.events(run.id))
        historic.push(event.payload as BaseEvent);
    }
    const out = new ReplaySubject<BaseEvent>(Infinity);
    // A `MESSAGES_SNAPSHOT` first, built from this store's own canonical
    // `messages` table rather than reconstructed from the replayed event
    // stream: a viewer's `.messages` is then correct immediately on
    // connect, independent of whether any individual historic run's events
    // happen to carry enough detail to rebuild it from scratch.
    out.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: this.canonicalMessages(threadId),
    } as BaseEvent);
    for (const event of compactEvents(historic)) out.next(event);
    if (!active) {
      out.complete();
      return out.asObservable();
    }
    const bridge = active.liveSubject.subscribe({
      next: (event) => out.next(event),
      error: (error) => out.error(error),
      complete: () => out.complete(),
    });
    // Unsubscribing (the viewer's transport disconnecting) only tears down
    // this bridge; it never touches the run itself, so dropping a viewer
    // never repeats execution or any side effect.
    return new Observable<BaseEvent>((subscriber) => {
      const inner = out.subscribe(subscriber);
      return () => {
        inner.unsubscribe();
        bridge.unsubscribe();
      };
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    this.reconcileThread(request.threadId);
    return this.active.has(request.threadId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    this.reconcileThread(request.threadId);
    const active = this.active.get(request.threadId);
    if (!active) return false;
    if (request.runId !== undefined && active.runId !== request.runId)
      return false;
    active.stopRequested = true;
    try {
      active.agent.abortRun();
    } catch {
      active.stopRequested = false;
      return false;
    }
    return true;
  }

  private enqueue(threadId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.queues.get(threadId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.queues.set(
      threadId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Any `runs` row this process finds `running` for a thread it is not
   * itself actively executing predates this process. Called at the top of
   * every public method so a thread is reconciled the moment anything
   * touches it, with no separate startup sweep required.
   */
  private reconcileThread(threadId: string) {
    if (this.active.has(threadId)) return;
    for (const run of this.store.runs(threadId)) {
      if (run.status !== 'running') continue;
      try {
        this.store.finishRun(run.id, 'interrupted', RESTART_INTERRUPT_REASON);
      } catch {
        // Already transitioned by a concurrent caller on this same thread.
      }
    }
  }

  private canonicalMessages(threadId: string): Message[] {
    return this.store.messages(threadId).map((row) => row.content as Message);
  }

  /** ToolCall ids an assistant message in `messages` raised that no `tool`
   *  message in the same list has yet answered. */
  private pendingToolCallIds(messages: Message[]): Set<string> {
    const answered = new Set<string>();
    for (const message of messages)
      if (message.role === 'tool') answered.add(message.toolCallId);
    const pending = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const call of message.toolCalls ?? [])
        if (!answered.has(call.id)) pending.add(call.id);
    }
    return pending;
  }

  private async executeRun(
    request: AgentRunnerRunRequest,
    subject: ReplaySubject<BaseEvent>,
  ): Promise<void> {
    this.reconcileThread(request.threadId);
    const threadId = request.threadId;
    const dotId = request.agent.agentId;
    if (!dotId) {
      subject.next({
        type: EventType.RUN_ERROR,
        message: 'Runner could not identify the Dot for this run.',
        code: 'ADMISSION_REJECTED',
      } as BaseEvent);
      subject.complete();
      return;
    }
    const before = this.canonicalMessages(threadId);
    const knownIds = new Set(before.map((message) => message.id));
    const incoming = request.input.messages ?? [];
    const candidates = incoming.filter((message) => !knownIds.has(message.id));
    const pending = this.pendingToolCallIds(before);
    const rejected = candidates.find(
      (message) =>
        message.role !== 'user' &&
        !(message.role === 'tool' && pending.has(message.toolCallId)),
    );
    if (candidates.length === 0 || rejected) {
      subject.next({
        type: EventType.RUN_ERROR,
        message: rejected
          ? 'This message was not admitted: only new user text or an expected tool response may be added to a thread.'
          : 'No new message to admit for this run.',
        code: 'ADMISSION_REJECTED',
      } as BaseEvent);
      subject.complete();
      return;
    }
    let admittedRun: ConversationRun | undefined;
    try {
      for (const message of candidates) {
        const params = {
          threadId,
          dotId,
          ownerId: this.ownerId,
          role: (message.role === 'tool' ? 'tool' : 'user') as MessageRole,
          content: message,
          toolCallId: message.role === 'tool' ? message.toolCallId : null,
        };
        if (!admittedRun) admittedRun = this.store.admitTurn(params).run;
        else this.store.appendMessage(params);
      }
    } catch (error) {
      // An unexpected store failure mid-admission (not a validation
      // rejection, which is handled above and never reaches here). If the
      // first write already landed, the run it started must not be left
      // `running` forever; either way the caller must still see a
      // terminal event instead of a hung stream.
      if (admittedRun) {
        try {
          this.store.finishRun(
            admittedRun.id,
            'failed',
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          // Already terminal; nothing further to reconcile.
        }
      }
      subject.next({
        type: EventType.RUN_ERROR,
        message: 'This turn could not be admitted.',
        code: 'ADMISSION_FAILED',
      } as BaseEvent);
      subject.complete();
      return;
    }
    const run = admittedRun!;
    const agent = request.agent;
    const active: ActiveRun = {
      run,
      runId: request.input.runId,
      agent,
      liveSubject: subject,
      stopRequested: false,
    };
    let sawErrorEvent = false;
    let errorMessage: string | undefined;
    let sawTerminalEvent = false;
    try {
      // `RunAgentParameters` (the parameter `runAgent()` accepts) carries no
      // `messages`/`state`/`threadId` fields — only the instance fields do —
      // so this is the one and only place that controls what the agent
      // actually executes with. Whatever the SDK set on this clone from the
      // client's raw request body before handing it to this runner is
      // overwritten here with the canonical, store-backed history.
      agent.threadId = threadId;
      agent.setMessages(this.canonicalMessages(threadId));
      agent.setState(request.input.state);
      this.active.set(threadId, active);
      const result = await agent.runAgent(
        {
          runId: request.input.runId,
          tools: request.input.tools,
          context: request.input.context,
          forwardedProps: request.input.forwardedProps,
          resume: request.input.resume,
        },
        {
          onEvent: ({ event }) => {
            // `admitTurn`/`finishRun` are this store's own authority for a
            // run's start/end bookkeeping event (conversation-store.ts
            // inserts its own `RUN_STARTED` on admission and its own
            // `RUN_FINISHED`/`RUN_ERROR` when the status transition below
            // lands) - so the agent's OWN start/end events are published
            // live here (the original caller and any live `connect()`
            // viewer still see them) but never also recorded, which would
            // otherwise leave two boundary events of the same type back to
            // back in the persisted, replayable stream. Content events
            // (text, tool calls, state, ...) have no such store-level
            // counterpart and are recorded exactly as emitted.
            const boundary =
              event.type === EventType.RUN_STARTED ||
              event.type === EventType.RUN_FINISHED ||
              event.type === EventType.RUN_ERROR;
            if (
              event.type === EventType.RUN_FINISHED ||
              event.type === EventType.RUN_ERROR
            )
              sawTerminalEvent = true;
            if (event.type === EventType.RUN_ERROR) {
              sawErrorEvent = true;
              errorMessage =
                'message' in event && typeof event.message === 'string'
                  ? event.message
                  : undefined;
            }
            if (!boundary) this.store.recordEvent(threadId, run.id, event);
            subject.next(event);
          },
        },
      );
      // `newMessages` is `runAgent()`'s own diff of what this run actually
      // produced (assistant text, tool calls, tool results it resolved
      // itself), computed against the canonical `messages` set above it -
      // not against the client's raw, untrusted payload. Persisting exactly
      // this list is what makes the next turn's `canonicalMessages()` see
      // the assistant's/tool's own output without ever trusting the client
      // to have reported it accurately.
      for (const message of result.newMessages) {
        this.store.appendMessage({
          threadId,
          dotId,
          ownerId: this.ownerId,
          role: message.role === 'tool' ? 'tool' : 'assistant',
          content: message,
          toolCallId: message.role === 'tool' ? message.toolCallId : null,
        });
      }
      const status = active.stopRequested
        ? 'interrupted'
        : sawErrorEvent
          ? 'failed'
          : 'completed';
      const reason = active.stopRequested
        ? STOP_INTERRUPT_REASON
        : (errorMessage ?? null);
      this.store.finishRun(run.id, status, reason);
      if (!sawTerminalEvent)
        subject.next(
          this.terminalEvent(threadId, request.input.runId, status, reason),
        );
    } catch (error) {
      const status = active.stopRequested ? 'interrupted' : 'failed';
      const reason = active.stopRequested
        ? STOP_INTERRUPT_REASON
        : error instanceof Error
          ? error.message
          : String(error);
      this.store.finishRun(run.id, status, reason);
      if (!sawTerminalEvent)
        subject.next(
          this.terminalEvent(threadId, request.input.runId, status, reason),
        );
    } finally {
      this.active.delete(threadId);
      subject.complete();
    }
  }

  /**
   * The terminal AG-UI event for a finalized run. The agent's own observable
   * is the primary source of `RUN_FINISHED`/`RUN_ERROR`, but a rejection
   * (abort, timeout, provider failure) or an agent that simply ends its stream
   * never emits one; the caller must still see the run terminate explicitly
   * rather than as a bare stream close.
   */
  private terminalEvent(
    threadId: string,
    runId: string,
    status: Exclude<RunStatus, 'running'>,
    error: string | null,
  ): BaseEvent {
    if (status === 'completed')
      return { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent;
    return {
      type: EventType.RUN_ERROR,
      message: error ?? 'Run failed.',
      ...(status === 'interrupted' ? { code: 'STOPPED' } : {}),
    } as BaseEvent;
  }
}
