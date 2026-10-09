import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import {
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
  type PlatformConfig,
} from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { ConversationRunner } from './conversation-runner.js';
import { ConversationStore } from './conversation-store.js';
import { SetupTelemetry } from './setup-telemetry.js';
export class Platform {
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  readonly handler: CopilotHonoApp;
  private readonly runner: ConversationRunner;
  private readonly turns = new Set<Promise<string>>();
  private readonly shutdown = new AbortController();
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    readonly conversationStore: ConversationStore,
  ) {
    this.setupTelemetry = new SetupTelemetry(store);
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(workspace.connections);
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return {
        getOrCreateThread: async (input) => {
          const existing = workspace
            .conversations()
            .some((thread) => thread.id === input.threadId);
          return existing
            ? workspace.requireThread(input.threadId, input.agentId)
            : workspace.bindThread(input.threadId, input.agentId, input.name);
        },
        getThreadMessages: async ({ threadId }) => ({
          messages: conversationStore.messages(threadId).map((message) => {
            const content = message.content as { content?: unknown };
            return {
              role: message.role,
              content:
                content && typeof content === 'object' && 'content' in content
                  ? content.content
                  : message.content,
            };
          }),
        }),
      };
    });
    // Web chat, scheduled tasks, and voice compute all share this runner, so
    // they share one canonical transcript per thread.
    this.runner = new ConversationRunner(conversationStore, workspace.ownerId);
    const runtime = new CopilotRuntime({
      runner: this.runner,
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'OpenDots owner',
      }),
      agents: async () =>
        Object.fromEntries(
          workspace.dots().map((dot) => [dot.id, this.dotAgent(dot.id)]),
        ),
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
    // Work this database still shows as open was left by a process that has
    // exited. Mark it interrupted now; it is never resumed. `isRunning`
    // reconciles its thread before answering, and does so synchronously.
    for (const thread of workspace.conversations())
      void this.runner.isRunning({ threadId: thread.id });
    for (const call of workspace.calls())
      if (
        !call.endedAt &&
        (call.status === 'connecting' || call.status === 'active')
      )
        workspace.setCall(
          call.id,
          'failed',
          call.transcript,
          'Call interrupted by a server restart. Start a new call to continue.',
        );
  }
  private dotAgent(dotId: string) {
    return new DotAgent(
      this.store,
      this.workspace,
      this.config,
      dotId,
      false,
      this.setupTelemetry,
    );
  }
  setup() {
    const status = setupStatus(
      this.config,
      this.config.slackChannel ? 'setup_required' : 'not_configured',
    );
    const missing = status.missing.filter(
      (item) => item !== INTELLIGENCE_KEY_MISSING_LABEL,
    );
    return {
      ...status,
      missing,
      voice: !!(
        this.config.voiceKey &&
        this.config.voiceModel &&
        !missing.length
      ),
    };
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async start() {
    this.setupTelemetry.start();
  }
  async stop() {
    // Each in-flight turn ends through `runner.stop`, so it is recorded
    // `interrupted` before the database closes. Nothing resumes it next start.
    this.shutdown.abort(new Error('Server is stopping.'));
    await Promise.allSettled([...this.turns]);
    await this.setupTelemetry.stop();
    this.conversationStore.close();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    return this.workspace.bindThread(id, dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    return this.conversationStore
      .messages(threadId)
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map((message) => {
        const content = message.content as { content?: unknown };
        const text =
          content &&
          typeof content === 'object' &&
          typeof content.content === 'string'
            ? content.content
            : '';
        return `${message.role}: ${text}`;
      })
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    const turn = runThreadTurn(
      this.runner,
      this.dotAgent(thread.dotId),
      threadId,
      prompt,
      AbortSignal.any([signal, this.shutdown.signal]),
      metadata,
    );
    this.turns.add(turn);
    try {
      return await turn;
    } finally {
      this.turns.delete(turn);
    }
  }
}
