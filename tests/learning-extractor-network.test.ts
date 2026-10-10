import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEARNING_EXTRACTION,
  localExtractionCall,
  learningExtractorReadiness,
  parseExtractionReply,
  pinnedLoopbackFetch,
  runLearningExtraction,
} from '../src/server/learning.js';
import {
  cleanupLearningFixtures,
  enableCollection,
  learningDatabasePath,
  onlyDot,
  openLearningStores,
} from './learning-fixtures.js';
import {
  claimJob,
  lessonReply,
  queueCorrection,
  startLoopbackModel,
  versionsFor,
  type LoopbackModel,
} from './learning-extractor-fixtures.js';

// Network-deny checks for local extraction: only the pinned loopback endpoint
// is ever reached, redirects are refused, and no chat-provider or Intelligence
// traffic is generated, with those variables present or absent.

const servers: LoopbackModel[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  cleanupLearningFixtures();
});

async function model(
  answer: Parameters<typeof startLoopbackModel>[0],
): Promise<LoopbackModel> {
  const server = await startLoopbackModel(answer);
  servers.push(server);
  return server;
}

const ready = (baseURL: string) => {
  const readiness = learningExtractorReadiness(baseURL, 'local-model');
  if (readiness.state !== 'ready')
    throw new Error('Expected a ready endpoint.');
  return readiness;
};

describe('pinned loopback transport', () => {
  it('reaches the pinned endpoint and reads usage from the stream', async () => {
    const server = await model(() => ({
      kind: 'stream',
      content: lessonReply('cite-research-claims'),
      usage: true,
    }));
    const call = localExtractionCall(ready(server.baseURL));
    const reply = await call({
      system: 'Return JSON.',
      user: '{"excerpt":[]}',
      abortController: new AbortController(),
    });
    expect(reply.text).toContain('cite-research-claims');
    expect(reply.inputTokens).toBe(120);
    expect(reply.outputTokens).toBe(40);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].path).toBe('/v1/chat/completions');
    expect(server.requests[0].body.model).toBe('local-model');
    // One tool-free call: no tools field, temperature zero, bounded output.
    expect(server.requests[0].body).toMatchObject({
      max_completion_tokens: 1400,
      temperature: 0,
      stream: true,
    });
    expect(server.requests[0].body).not.toHaveProperty('tools');
  });

  it('bounds an over-long streamed reply instead of buffering it whole', async () => {
    const server = await model(() => ({
      kind: 'stream',
      content: 'x'.repeat(LEARNING_EXTRACTION.outputChars + 2_000),
      chunkSize: 100,
    }));
    const reply = await localExtractionCall(ready(server.baseURL))({
      system: 'Return JSON.',
      user: '{}',
      abortController: new AbortController(),
    });
    expect(reply.text.length).toBeLessThanOrEqual(
      LEARNING_EXTRACTION.outputChars,
    );
    expect(() => parseExtractionReply(reply.text)).toThrow('malformed_output');
  });

  it('reports missing usage as null, not as zero', async () => {
    const server = await model(() => ({
      kind: 'stream',
      content: '{"lesson": null}',
    }));
    const reply = await localExtractionCall(ready(server.baseURL))({
      system: 'Return JSON.',
      user: '{}',
      abortController: new AbortController(),
    });
    expect(reply).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  it('sends no Authorization header to the local endpoint', async () => {
    const server = await model(() => ({
      kind: 'stream',
      content: '{"lesson": null}',
    }));
    await localExtractionCall(ready(server.baseURL))({
      system: 'Return JSON.',
      user: '{}',
      abortController: new AbortController(),
    });
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it('refuses to follow a redirect, even to another loopback address', async () => {
    const elsewhere = await model(() => ({
      kind: 'stream',
      content: '{"lesson": null}',
    }));
    const redirecting = await model(() => ({
      kind: 'redirect',
      location: `${elsewhere.baseURL}/chat/completions`,
    }));
    await expect(
      localExtractionCall(ready(redirecting.baseURL))({
        system: 'Return JSON.',
        user: '{}',
        abortController: new AbortController(),
      }),
    ).rejects.toThrow();
    expect(elsewhere.requests).toHaveLength(0);
  });

  it('refuses any request outside the pinned origin without touching the network', async () => {
    const server = await model(() => ({
      kind: 'stream',
      content: '{"lesson": null}',
    }));
    const pinned = pinnedLoopbackFetch(server.baseURL);
    await expect(
      pinned('https://api.openai.com/v1/chat/completions', { method: 'POST' }),
    ).rejects.toThrow('pinned loopback endpoint');
    await expect(
      pinned(`http://127.0.0.2:${new URL(server.baseURL).port}/v1/x`, {
        method: 'POST',
      }),
    ).rejects.toThrow('pinned loopback endpoint');
    expect(server.requests).toHaveLength(0);
  });

  it('turns a non-2xx answer into a failed call, never a fallback', async () => {
    const server = await model(() => ({ kind: 'status', code: 500 }));
    await expect(
      localExtractionCall(ready(server.baseURL))({
        system: 'Return JSON.',
        user: '{}',
        abortController: new AbortController(),
      }),
    ).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });

  it('stops a hung call when its controller aborts', async () => {
    const server = await model(() => ({ kind: 'hang' }));
    const controller = new AbortController();
    const pending = localExtractionCall(ready(server.baseURL))({
      system: 'Return JSON.',
      user: '{}',
      abortController: controller,
    });
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('no Intelligence or cloud traffic', () => {
  it('makes no learning request when the endpoint is unset, with or without Intelligence variables', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const url of [undefined, '']) {
      expect(learningExtractorReadiness(url, 'local-model')).toEqual({
        state: 'unavailable',
        reason: 'not_configured',
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never reaches a cloud default: a remote endpoint is refused before any call', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'http://example.com/v1',
      'http://localhost:4000/v1',
    ]) {
      expect(learningExtractorReadiness(url, 'local-model')).toMatchObject({
        state: 'unavailable',
      });
    }
  });

  it('runs one extraction against the loopback endpoint only', async () => {
    const server = await model(() => ({
      kind: 'stream',
      content: lessonReply('cite-research-claims'),
      usage: true,
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = enableCollection(stores.workspace, onlyDot(stores.workspace));
    stores.workspace.bindThread('thread-net', dot.id, 'Net');
    const { job, lease } = claimJob(
      stores.conversations,
      queueCorrection(
        stores.conversations,
        dot.id,
        'thread-net',
        'Cite claims.',
      ),
    );
    const call = localExtractionCall(ready(server.baseURL));
    const result = await runLearningExtraction(
      job,
      lease,
      {
        conversations: stores.conversations,
        workspace: stores.workspace,
        call,
        model: 'local-model',
        timeoutMs: 5000,
        blockedBy: () => null,
      },
      new AbortController().signal,
    );
    expect(result.state).toBe('completed');
    expect(versionsFor(stores.workspace, dot.id)).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
