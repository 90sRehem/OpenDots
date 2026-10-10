import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { localPageIntelligence, PageService } from './page-service.js';
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
import {
  ConversationStore,
  type LearningJob,
  type ServerTurnSource,
} from './conversation-store.js';
import { SetupTelemetry } from './setup-telemetry.js';
import {
  extractionClaimLimits,
  learningConsentCurrent,
  learningExtractorReadiness,
  LEARNING_EXTRACTION,
  localExtractionCall,
  LearningStop,
  runLearningExtraction,
  type ExtractionCall,
  type LearningExtractorReadiness,
} from './learning.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class Platform {
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  readonly handler: CopilotHonoApp;
  private readonly runner: ConversationRunner;
  private readonly turns = new Set<Promise<string>>();
  private readonly shutdown = new AbortController();
  private readonly extraction: LearningExtractorReadiness;
  private readonly extractionCall?: ExtractionCall;
  private extractionLoop: Promise<void> = Promise.resolve();
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
    const pageIntelligence = localPageIntelligence(
      workspace,
      conversationStore,
    );
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return pageIntelligence;
    });
    // Web chat, scheduled tasks, and voice compute all share this runner, so
    // they share one canonical transcript per thread.
    this.runner = new ConversationRunner(conversationStore, workspace.ownerId);
    // Local extraction is optional. Without an approved loopback endpoint it is
    // visibly unavailable, and nothing falls back to the chat provider.
    this.extraction = learningExtractorReadiness(
      config.learningExtractorUrl,
      config.learningExtractorModel,
    );
    if (this.extraction.state === 'ready')
      this.extractionCall = localExtractionCall(this.extraction);
    // A job still running belonged to a process that exited. It becomes
    // interrupted and is never repeated, so no paid call runs twice.
    conversationStore.interruptRunningLearningJobs();
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
    if (this.extraction.state === 'ready')
      this.extractionLoop = this.runExtractionLoop();
  }
  async stop() {
    // Each in-flight turn ends through `runner.stop`, so it is recorded
    // `interrupted` before the database closes. Nothing resumes it next start.
    this.shutdown.abort(new Error('Server is stopping.'));
    await Promise.allSettled([...this.turns]);
    // The extraction loop stops its one call as `interrupted` before the store closes.
    await this.extractionLoop;
    await this.setupTelemetry.stop();
    this.conversationStore.close();
  }
  /** Whether local learning extraction can run, and if not, why. Manual authoring is unaffected. */
  learningExtraction():
    | { state: 'ready'; model: string }
    | { state: 'unavailable'; reason: string } {
    return this.extraction.state === 'ready'
      ? { state: 'ready', model: this.extraction.model }
      : { state: 'unavailable', reason: this.extraction.reason };
  }
  /** Live foreground work: any turn in flight, or any admitted run still queued or executing. */
  private foregroundBusy(): boolean {
    return this.turns.size > 0 || this.runner.foregroundRuns() > 0;
  }
  /** The reason background extraction must stop now, or null. Pause stops; revoked memory or consent cancels. */
  private learningBlockedBy(
    job?: LearningJob,
  ): 'paused' | 'consent_revoked' | null {
    const settings = this.store.settings();
    if (settings.paused) return 'paused';
    if (!settings.memoryAllowed) return 'consent_revoked';
    if (
      job &&
      !learningConsentCurrent(
        this.conversationStore.learningConsent(job.threadId),
        job,
      )
    )
      return 'consent_revoked';
    return null;
  }
  /**
   * One pass of the single bounded extraction worker. It claims at most one job
   * and runs it to a terminal state before returning. It never runs while
   * foreground work is live, and a global budget or concurrency skip ends the
   * pass so no other job can claim past it.
   */
  private async extractOnce(): Promise<'ran' | 'waiting' | 'idle'> {
    if (this.extraction.state !== 'ready') return 'idle';
    const settings = this.store.settings();
    if (!settings.memoryAllowed) {
      for (const job of this.conversationStore.learningJobsQueued())
        this.conversationStore.cancelLearningJob(job.id, 'consent_revoked');
      return 'idle';
    }
    if (settings.paused) return 'idle';
    if (this.foregroundBusy()) return 'waiting';
    for (const job of this.conversationStore.learningJobsQueued()) {
      if (
        !learningConsentCurrent(
          this.conversationStore.learningConsent(job.threadId),
          job,
        )
      ) {
        this.conversationStore.cancelLearningJob(job.id, 'consent_revoked');
        continue;
      }
      const lease = randomUUID();
      const claim = this.conversationStore.claimLearningJob(
        job.id,
        lease,
        extractionClaimLimits(Date.now()),
      );
      if ('skipped' in claim) {
        if (
          claim.skipped === 'dot_daily' ||
          claim.skipped === 'dot_interval' ||
          claim.skipped === 'not_queued'
        )
          continue;
        return 'idle';
      }
      await this.extractClaimed(claim.job, lease);
      return 'ran';
    }
    return 'idle';
  }
  /**
   * Runs one claimed job. A watchdog stops the call on shutdown, live foreground
   * work, pause, or revoked consent. The stop reason decides the terminal state.
   */
  private async extractClaimed(job: LearningJob, lease: string): Promise<void> {
    if (this.extraction.state !== 'ready' || !this.extractionCall) return;
    const { model } = this.extraction;
    const stop = new AbortController();
    const watch = setInterval(() => {
      if (stop.signal.aborted) return;
      if (this.shutdown.signal.aborted)
        stop.abort(new LearningStop('shutdown'));
      else if (this.foregroundBusy()) stop.abort(new LearningStop('preempted'));
      else {
        const blocked = this.learningBlockedBy(job);
        if (blocked) stop.abort(new LearningStop(blocked));
      }
    }, LEARNING_EXTRACTION.watchdogMs);
    try {
      await runLearningExtraction(
        job,
        lease,
        {
          conversations: this.conversationStore,
          workspace: this.workspace,
          call: this.extractionCall,
          model,
          timeoutMs: LEARNING_EXTRACTION.timeoutMs,
          blockedBy: () => this.learningBlockedBy(job),
        },
        stop.signal,
      );
    } finally {
      clearInterval(watch);
    }
  }
  /** The worker loop: one pass after another, waiting while foreground work or an idle queue holds it. */
  private async runExtractionLoop(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      let pass: 'ran' | 'waiting' | 'idle';
      try {
        pass = await this.extractOnce();
      } catch {
        pass = 'idle';
      }
      if (pass === 'ran') continue;
      await sleep(
        pass === 'waiting'
          ? LEARNING_EXTRACTION.foregroundPollMs
          : LEARNING_EXTRACTION.queuePollMs,
        this.shutdown.signal,
      );
    }
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
    source: ServerTurnSource,
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
      source,
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
