import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/server/conversation-store.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  cleanupLearningFixtures,
  enableCollection,
  learningDatabasePath,
  onlyDot,
} from './learning-fixtures.js';
import {
  claimJob,
  lessonReply,
  queueCorrection,
  startLoopbackModel,
  versionsFor,
  waitFor,
  type LoopbackModel,
} from './learning-extractor-fixtures.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

// The Platform-owned extraction worker, end to end: one job at a time, with
// preemption by foreground work, pause, revoked consent, and shutdown, and with
// startup recovery that never repeats a paid call.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    // Tests stop platforms early to simulate shutdown, so cleanup must tolerate a second stop.
    try {
      await cleanup();
    } catch {
      // Already closed.
    }
  }
  cleanupLearningFixtures();
});

function openAll(path: string) {
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, 'owner');
  const conversationStore = new ConversationStore(path);
  return { store, workspace, conversationStore };
}

function platformFor(path: string, config: Partial<PlatformConfig> = {}) {
  const stores = openAll(path);
  const platform = new Platform(
    stores.store,
    stores.workspace,
    {
      apiKey: 'chat-key',
      model: 'chat-model',
      baseUrl: 'https://api.openai.com/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
      ...config,
    },
    stores.conversationStore,
  );
  cleanups.push(
    () => {
      stores.workspace.close();
      stores.store.close();
    },
    () => platform.stop(),
  );
  return { platform, ...stores };
}

function withDot(path: string) {
  const stores = openAll(path);
  const dot = enableCollection(stores.workspace, onlyDot(stores.workspace));
  stores.workspace.bindThread('thread-worker', dot.id, 'Worker');
  return { ...stores, dot };
}

async function server(
  answer: Parameters<typeof startLoopbackModel>[0],
): Promise<LoopbackModel> {
  const model = await startLoopbackModel(answer);
  cleanups.push(() => model.close());
  return model;
}

describe('extraction worker', () => {
  it('runs a queued job through the loopback model and stores one pending proposal', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({
      kind: 'stream',
      content: lessonReply('cite-research-claims'),
      usage: true,
    }));
    const { workspace, conversationStore, dot } = withDot(path);
    queueCorrection(
      conversationStore,
      dot.id,
      'thread-worker',
      'Cite every claim.',
    );
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    expect(platform.learningExtraction()).toEqual({
      state: 'ready',
      model: 'local-model',
    });
    await platform.start();
    await waitFor(() => versionsFor(workspace, dot.id).length === 1);
    expect(model.requests).toHaveLength(1);
    expect(versionsFor(workspace, dot.id)[0]).toMatchObject({
      state: 'pending',
    });
    await platform.stop();
    expect(model.requests).toHaveLength(1);
  });

  it('is visibly unavailable with no endpoint and never reaches the chat provider', async () => {
    const path = learningDatabasePath();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { workspace, conversationStore, dot } = withDot(path);
    queueCorrection(
      conversationStore,
      dot.id,
      'thread-worker',
      'Remember this.',
    );
    const { platform } = platformFor(path, {
      // Intelligence and chat-provider variables are present; they are not learning.
      intelligenceKey: 'intelligence-key',
      apiKey: 'chat-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(platform.learningExtraction()).toEqual({
      state: 'unavailable',
      reason: 'not_configured',
    });
    await platform.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(conversationStore.learningJobsQueued()).toHaveLength(1);
    expect(versionsFor(workspace, dot.id)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await platform.stop();
  });

  it('waits while foreground work is live and runs once it is idle', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({
      kind: 'stream',
      content: '{"lesson": null}',
    }));
    const { conversationStore, dot } = withDot(path);
    queueCorrection(conversationStore, dot.id, 'thread-worker', 'Wait for me.');
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    const foreground = vi
      .spyOn(platform['runner'], 'foregroundRuns')
      .mockReturnValue(1);
    await platform.start();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(model.requests).toHaveLength(0);
    expect(conversationStore.learningJobsQueued()).toHaveLength(1);
    foreground.mockReturnValue(0);
    await waitFor(
      () => conversationStore.learningJobs()[0].state === 'no_change',
    );
    expect(model.requests).toHaveLength(1);
    await platform.stop();
  });

  it('cancels a running call when foreground work arrives', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({ kind: 'hang' }));
    const { conversationStore, dot } = withDot(path);
    queueCorrection(conversationStore, dot.id, 'thread-worker', 'Preempt.');
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    const foreground = vi
      .spyOn(platform['runner'], 'foregroundRuns')
      .mockReturnValue(0);
    await platform.start();
    await waitFor(() => model.requests.length === 1);
    foreground.mockReturnValue(1);
    const jobId = conversationStore.learningJobs()[0].id;
    await waitFor(
      () => conversationStore.learningJob(jobId)?.state === 'cancelled',
    );
    expect(conversationStore.learningJob(jobId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'preempted',
    });
    await platform.stop();
  });

  it('cancels a running call when the owner pauses', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({ kind: 'hang' }));
    const { conversationStore, dot } = withDot(path);
    queueCorrection(conversationStore, dot.id, 'thread-worker', 'Pause.');
    const { platform, store } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    await platform.start();
    await waitFor(() => model.requests.length === 1);
    store.updateSettings({ paused: true });
    const jobId = conversationStore.learningJobs()[0].id;
    await waitFor(
      () => conversationStore.learningJob(jobId)?.state === 'cancelled',
    );
    expect(conversationStore.learningJob(jobId)?.errorCode).toBe('paused');
    await platform.stop();
  });

  it('cancels a running call when learning consent is revoked, storing nothing', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({ kind: 'hang' }));
    const { workspace, conversationStore, dot } = withDot(path);
    queueCorrection(conversationStore, dot.id, 'thread-worker', 'Revoke.');
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    await platform.start();
    await waitFor(() => model.requests.length === 1);
    workspace.updateDot(dot.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      learningEnabled: false,
    });
    const jobId = conversationStore.learningJobs()[0].id;
    await waitFor(
      () => conversationStore.learningJob(jobId)?.state === 'cancelled',
    );
    expect(conversationStore.learningJob(jobId)?.errorCode).toBe(
      'consent_revoked',
    );
    expect(versionsFor(workspace, dot.id)).toHaveLength(0);
    await platform.stop();
  });

  it('marks a call interrupted when the server shuts down, and never repeats it', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({ kind: 'hang' }));
    const { conversationStore, dot } = withDot(path);
    const job = queueCorrection(
      conversationStore,
      dot.id,
      'thread-worker',
      'Shut down.',
    );
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    await platform.start();
    await waitFor(() => model.requests.length === 1);
    await platform.stop();
    const reopened = new ConversationStore(path);
    cleanups.push(() => reopened.close());
    expect(reopened.learningJob(job.id)).toMatchObject({
      state: 'interrupted',
      errorCode: 'shutdown',
    });
    expect(model.requests).toHaveLength(1);
  });

  it('interrupts a job left running by a crashed process without calling the model again', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({
      kind: 'stream',
      content: lessonReply('should-not-run'),
    }));
    const { conversationStore, dot } = withDot(path);
    const job = queueCorrection(
      conversationStore,
      dot.id,
      'thread-worker',
      'Crash.',
    );
    claimJob(conversationStore, job);
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    await platform.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(conversationStore.learningJob(job.id)).toMatchObject({
      state: 'interrupted',
      errorCode: 'restart',
    });
    expect(model.requests).toHaveLength(0);
    await platform.stop();
  });

  it('keeps a finished chat run completed when its extraction fails', async () => {
    const path = learningDatabasePath();
    const model = await server(() => ({ kind: 'status', code: 500 }));
    const { conversationStore, dot } = withDot(path);
    const job = queueCorrection(
      conversationStore,
      dot.id,
      'thread-worker',
      'Fail.',
    );
    const { platform } = platformFor(path, {
      learningExtractorUrl: model.baseURL,
      learningExtractorModel: 'local-model',
    });
    await platform.start();
    await waitFor(
      () => conversationStore.learningJob(job.id)?.state === 'failed',
    );
    expect(conversationStore.learningJob(job.id)?.errorCode).toBe(
      'endpoint_error',
    );
    expect(conversationStore.run(job.sourceRunId)?.status).toBe('completed');
    await platform.stop();
  });
});
