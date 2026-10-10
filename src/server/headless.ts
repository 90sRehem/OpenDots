import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type RunErrorEvent,
  type TextMessageContentEvent,
  type TextMessageStartEvent,
} from '@ag-ui/client';
import { randomUUID } from 'node:crypto';
import { Observable, of } from 'rxjs';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';
import type { ConversationRunner } from './conversation-runner.js';
import type { ServerTurnSource } from './conversation-store.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

/**
 * The agent the runner executes for one turn. The runner starts a turn only
 * once its thread is free, so a turn can wait behind another run. If its
 * caller gave up while it waited, it ends here without calling the model.
 */
class TurnAgent extends AbstractAgent {
  constructor(
    private readonly inner: AbstractAgent,
    private readonly signal: AbortSignal,
  ) {
    super({ agentId: inner.agentId });
  }
  clone() {
    return new TurnAgent(this.inner.clone(), this.signal);
  }
  abortRun() {
    this.inner.abortRun();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (this.signal.aborted)
      return of({
        type: EventType.RUN_ERROR,
        message: 'Turn was cancelled before it started; it was not run.',
      } as BaseEvent);
    return this.inner.run(input);
  }
}

/**
 * Runs one turn on the local durable runner and resolves to the Dot's reply.
 * The turn's user message and every event are committed by the runner, so the
 * reply appears in the same canonical thread history the web chat reads.
 *
 * Aborting `signal` stops an in-flight turn through `runner.stop`, which
 * records it `interrupted`; the caller then sees the signal's reason.
 *
 * `source` is chosen by the server caller and recorded as the run's origin.
 * It is never derived from `metadata`, which is only the message's display data.
 */
export async function runThreadTurn(
  runner: Pick<ConversationRunner, 'runTurn' | 'stop'>,
  agent: AbstractAgent,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  source: ServerTurnSource,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const runId = randomUUID();
  const idPrefix =
    metadata?.opendotsSource === 'voice_receipt'
      ? voiceReceiptMessagePrefix
      : metadata?.opendotsSource === 'scheduled_task'
        ? scheduledTaskMessagePrefix
        : '';
  const message: Message = {
    id: `${idPrefix}${randomUUID()}`,
    role: 'user',
    content: prompt,
    ...(metadata ? { metadata } : {}),
  };
  const stop = () => void runner.stop({ threadId, runId });
  signal.addEventListener('abort', stop, { once: true });
  const replies: { id: string; text: string }[] = [];
  let runError: Error | undefined;
  try {
    await new Promise<void>((resolve) => {
      runner
        .runTurn(
          {
            threadId,
            agent: new TurnAgent(agent, signal),
            input: {
              threadId,
              runId,
              state: undefined,
              messages: [message],
              tools: [],
              context: [],
              forwardedProps: {},
            },
          },
          source,
        )
        .subscribe({
          next: (event) => {
            if (event.type === EventType.TEXT_MESSAGE_START) {
              const start = event as TextMessageStartEvent;
              if (start.role === 'assistant')
                replies.push({ id: start.messageId, text: '' });
            } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
              const content = event as TextMessageContentEvent;
              for (const reply of replies)
                if (reply.id === content.messageId) reply.text += content.delta;
            } else if (event.type === EventType.RUN_ERROR) {
              runError = new Error((event as RunErrorEvent).message);
            }
          },
          error: (error) => {
            runError =
              error instanceof Error ? error : new Error(String(error));
            resolve();
          },
          complete: resolve,
        });
    });
  } finally {
    signal.removeEventListener('abort', stop);
  }
  signal.throwIfAborted();
  return currentTurnText(
    replies.map((reply) => ({
      id: reply.id,
      role: 'assistant',
      content: reply.text,
    })),
    runError,
  );
}
