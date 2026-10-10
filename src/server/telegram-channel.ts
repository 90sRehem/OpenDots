import { randomUUID } from 'node:crypto';
import {
  AbstractAgent,
  EventType,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { safeFailure } from './channel-errors.js';
import { ConversationStore } from './conversation-store.js';
import { WorkspaceStore } from './workspace.js';

const PLATFORM = 'telegram';
const MAX_OUTBOUND_ATTEMPTS = 3;
const INTERRUPTED_NOTICE =
  'A previous run was interrupted. Please resend your message to continue.';

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
    text?: string;
    caption?: string;
  };
};

type TelegramResult<T> = { ok: boolean; result: T };
export type TelegramAgentFactory = (dotId: string) => AbstractAgent;

/** Accept only owner-authorized human messages in private Telegram chats. */
export function isEligibleTelegramUpdate(
  update: TelegramUpdate,
  ownerId: string,
  allowedIds: ReadonlySet<string>,
): update is TelegramUpdate & {
  message: NonNullable<TelegramUpdate['message']> & {
    from: NonNullable<TelegramUpdate['message']>['from'];
  };
} {
  const message = update?.message;
  const sender = message?.from;
  return (
    !!message &&
    message.chat?.type === 'private' &&
    !!sender &&
    sender.is_bot === false &&
    (String(sender.id) === ownerId || allowedIds.has(String(sender.id)))
  );
}

/** In-process long-poll Telegram connector. Configuration/startup wiring is owned by T11. */
export class TelegramChannel {
  #token: string;
  #allowedIds: ReadonlySet<string>;
  #stopped = false;
  #controller?: AbortController;

  constructor(
    token: string,
    private readonly ownerId: string,
    allowedIds: string[],
    private readonly store: ConversationStore,
    private readonly workspace: WorkspaceStore,
    private readonly agentFactory: TelegramAgentFactory,
    private readonly isPaused: () => boolean,
  ) {
    this.#token = token;
    this.#allowedIds = new Set(allowedIds);
  }

  stop() {
    this.#stopped = true;
    this.#controller?.abort();
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#controller = new AbortController();
    await this.recoverInterruptedRuns();
    while (!this.#stopped && !this.isPaused()) {
      try {
        await this.pollOnce();
      } catch (error) {
        // Errors from fetch may contain the request URL, so report only a closed classification.
        if (!this.#stopped)
          console.error(`Telegram polling failed: ${safeFailure(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async pollOnce(): Promise<void> {
    const highWater = this.store.highWaterOffset(PLATFORM);
    const updates = await this.request<TelegramUpdate[]>('getUpdates', {
      ...(highWater === null ? {} : { offset: highWater + 1 }),
      timeout: 30,
      allowed_updates: [
        'message',
        'edited_message',
        'channel_post',
        'my_chat_member',
        'callback_query',
      ],
    });
    for (const update of updates) {
      if (this.isPaused() || this.#stopped) return;
      await this.handleUpdate(update);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!isEligibleTelegramUpdate(update, this.ownerId, this.#allowedIds)) {
      this.store.admitInbound(
        PLATFORM,
        String(update.update_id),
        update.update_id,
      );
      return;
    }

    const message = update.message;
    const text = message.text ?? message.caption;
    if (typeof text !== 'string' || !text.trim()) {
      this.store.admitInbound(
        PLATFORM,
        String(update.update_id),
        update.update_id,
      );
      return;
    }

    const dot = this.workspace.dots()[0];
    if (!dot) {
      this.store.admitInbound(
        PLATFORM,
        String(update.update_id),
        update.update_id,
      );
      return;
    }
    const threadId = `telegram-${message.chat.id}`;
    try {
      this.workspace.requireThread(threadId, dot.id);
    } catch {
      try {
        this.workspace.bindThread(threadId, dot.id, 'Telegram conversation');
      } catch {
        this.workspace.requireThread(threadId, dot.id);
      }
    }
    const userMessage: Message = {
      id: randomUUID(),
      role: 'user',
      content: text,
    };
    const admitted = this.store.admitInboundTurn({
      platform: PLATFORM,
      updateId: String(update.update_id),
      offset: update.update_id,
      threadId,
      dotId: dot.id,
      ownerId: this.workspace.ownerId,
      role: 'user',
      content: userMessage,
      metadata: { platform: PLATFORM, chatId: message.chat.id },
      source: 'channel_owner',
    });
    if (!admitted) return;

    const agent = this.agentFactory(dot.id);
    const history = this.store
      .messages(threadId)
      .map((entry) => entry.content as Message);
    const input: RunAgentInput = {
      threadId,
      runId: randomUUID(),
      state: {},
      messages: history,
      tools: [],
      context: [],
      forwardedProps: {},
    };
    let reply = '';
    let failed = false;
    try {
      const events = await lastValueFrom(agent.run(input).pipe(toArray()));
      for (const event of events) {
        if (
          event.type === EventType.TEXT_MESSAGE_CONTENT &&
          'delta' in event &&
          typeof event.delta === 'string'
        )
          reply += event.delta;
        if (event.type === EventType.RUN_ERROR) failed = true;
      }
      if (reply) {
        this.store.appendMessage({
          threadId,
          dotId: dot.id,
          ownerId: this.workspace.ownerId,
          role: 'assistant',
          content: { id: randomUUID(), role: 'assistant', content: reply },
          metadata: { platform: PLATFORM },
          runId: admitted.run.id,
        });
      }
      this.store.finishRun(
        admitted.run.id,
        failed ? 'failed' : 'completed',
        failed ? 'Agent run failed.' : null,
      );
    } catch {
      this.store.finishRun(admitted.run.id, 'failed', 'Agent run failed.');
      return;
    }
    if (!failed && reply.trim()) {
      const outbound = this.store.queueOutbound(threadId, admitted.run.id, {
        chat_id: message.chat.id,
        text: reply,
      });
      await this.deliver(outbound.id);
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    for (const thread of this.workspace.conversations()) {
      for (const run of this.store.runs(thread.id)) {
        if (run.status !== 'running') continue;
        this.store.finishRun(
          run.id,
          'interrupted',
          'Run interrupted by process restart.',
        );
        const outbound = this.store.queueOutbound(thread.id, run.id, {
          chat_id: Number(this.ownerId),
          text: INTERRUPTED_NOTICE,
        });
        await this.deliver(outbound.id);
      }
    }
    for (const outbound of this.store.pendingOutbound())
      await this.deliver(outbound.id);
  }

  private async deliver(id: string): Promise<void> {
    let outbound = this.store.outbound(id);
    if (
      !outbound ||
      outbound.status === 'delivered' ||
      outbound.status === 'failed'
    )
      return;
    while (outbound.retryCount < MAX_OUTBOUND_ATTEMPTS) {
      this.store.markOutbound(id, 'attempting');
      try {
        await this.request('sendMessage', outbound.payload);
        this.store.markOutbound(id, 'delivered');
        return;
      } catch (error) {
        outbound = this.store.markOutbound(id, 'failed', safeFailure(error));
        if (outbound.retryCount >= MAX_OUTBOUND_ATTEMPTS) return;
      }
    }
  }

  private async request<T = unknown>(
    method: string,
    body?: unknown,
  ): Promise<T> {
    try {
      const url = new URL(
        `https://api.telegram.org/bot${this.#token}/${method}`,
      );
      const isGet = method === 'getUpdates';
      if (isGet && body && typeof body === 'object')
        for (const [key, value] of Object.entries(body))
          url.searchParams.set(key, JSON.stringify(value));
      const response = await fetch(url, {
        method: isGet ? 'GET' : 'POST',
        ...(!isGet && body !== undefined
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
        ...(this.#controller ? { signal: this.#controller.signal } : {}),
      });
      if (!response.ok)
        throw Object.assign(new Error('Telegram request failed.'), {
          status: response.status,
        });
      const result = (await response.json()) as TelegramResult<T>;
      if (!result.ok) throw new Error('Telegram request failed.');
      return result.result;
    } catch {
      throw new Error('Telegram request failed.');
    }
  }
}
