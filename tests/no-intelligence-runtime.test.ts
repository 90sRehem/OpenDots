import { afterEach, expect, it, vi } from 'vitest';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  InMemoryAgentRunner,
} from '@copilotkit/runtime/v2';
import { ProxiedCopilotRuntimeAgent } from '@copilotkit/core';
import { Observable } from 'rxjs';

// Permanent regression test for the recon's E1 experiment
// (data/opendots-intelligence-removal/report.md, Appendix A): the OSS
// `@copilotkit/runtime` serves `/info`, executes and replays a routed run,
// and rejects `channels` with no `intelligence` option configured at all.
// The frozen dependency graph this pins is `@copilotkit/runtime`/`core`/
// `react-core` 1.75.0 and `@ag-ui/client`/`core` 0.0.59, per package.json.

class FixtureAgent extends AbstractAgent {
  constructor() {
    super({ agentId: 'dot' });
  }
  clone() {
    return new FixtureAgent();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: `reply-${input.runId}`,
        role: 'assistant',
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: `reply-${input.runId}`,
        delta: 'local answer',
      });
      subscriber.next({
        type: EventType.TEXT_MESSAGE_END,
        messageId: `reply-${input.runId}`,
      });
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }
}

// No `intelligence` option anywhere below: CopilotRuntime selects the OSS
// SSE runtime, and a Hono handler serves it over in-process fetch, with no
// listening socket, no model, and no credentials.
function createHarness() {
  const runtime = new CopilotRuntime({ agents: { dot: new FixtureAgent() } });
  const app = createCopilotHonoHandler({
    runtime,
    basePath: '/api/copilotkit',
  });
  const requests: string[] = [];
  const localFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return app.fetch(request);
  };
  return { runtime, localFetch, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('serves /info over SSE, replays a routed run to a fresh client, and rejects channels, with zero outbound network fetches', async () => {
  let externalFetches = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation((url) => {
      externalFetches++;
      return Promise.reject(new Error(`Network forbidden: ${String(url)}`));
    }),
  );

  const { localFetch, requests } = createHarness();

  const info = await (
    await localFetch('http://probe.invalid/api/copilotkit/info')
  ).json();
  expect(info.mode).toBe('sse');
  expect(info.intelligence).toBeUndefined();

  const proxy = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: 'http://probe.invalid/api/copilotkit',
    agentId: 'chat-owned',
    runtimeAgentId: 'dot',
    fetch: localFetch,
  });
  proxy.threadId = 'owned-thread';
  await proxy.connectAgent();
  expect(proxy.messages).toHaveLength(0);
  proxy.addMessage({ id: 'user-one', role: 'user', content: 'test' });
  const result = await proxy.runAgent({ runId: 'run-one' });
  expect(result.newMessages.at(-1)?.content).toBe('local answer');

  // Replay to a fresh client object: the routed run survives a brand new
  // `ProxiedCopilotRuntimeAgent` connecting to the same thread.
  const fresh = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: 'http://probe.invalid/api/copilotkit',
    agentId: 'chat-reloaded',
    runtimeAgentId: 'dot',
    fetch: localFetch,
  });
  fresh.threadId = 'owned-thread';
  await fresh.connectAgent();
  expect(fresh.messages.at(-1)?.content).toBe('local answer');

  // Mechanical proof that managed Channels cannot survive Intelligence
  // removal: constructing CopilotRuntime with a non-empty `channels` array
  // throws instead of silently degrading.
  expect(
    () =>
      new CopilotRuntime({
        agents: {},
        // Intentionally malformed: the SSE runtime rejects ANY non-empty
        // `channels` array before inspecting its shape further, so the full
        // `Channel` contract is irrelevant here.
        channels: [{ name: 'x' }],
      } as unknown as ConstructorParameters<typeof CopilotRuntime>[0]),
  ).toThrow(/requires the Intelligence runtime/);

  expect(externalFetches).toBe(0);
  expect(requests).toEqual([
    'GET /api/copilotkit/info',
    // `connectAgent()` probes discovery again internally before each connect.
    'GET /api/copilotkit/info',
    'POST /api/copilotkit/agent/dot/connect',
    'POST /api/copilotkit/agent/dot/run',
    'GET /api/copilotkit/info',
    'POST /api/copilotkit/agent/dot/connect',
  ]);
});

it('documents the non-durable default runner: a fresh InMemoryAgentRunner shares process-wide state instead of isolating per instance', async () => {
  // `InMemoryAgentRunner` backs onto a process-wide singleton store
  // (@copilotkit/runtime's in-memory.mjs: "Process-wide singleton backing
  // every InMemoryAgentRunner"), not per-instance state. A run executed
  // through this harness's own default runner is visible to ANY
  // `InMemoryAgentRunner` constructed afterwards in this process, even one
  // that never touched this harness or this CopilotRuntime instance. That
  // state is lost only when the process itself restarts, not when a "fresh"
  // instance is constructed. This is the non-durable, non-isolated default
  // runner that T03 replaces with an owned, durable transcript store; this
  // test documents the behavior, it does not fix it.
  const { localFetch } = createHarness();
  const proxy = new ProxiedCopilotRuntimeAgent({
    runtimeUrl: 'http://probe.invalid/api/copilotkit',
    agentId: 'chat-owned',
    runtimeAgentId: 'dot',
    fetch: localFetch,
  });
  proxy.threadId = 'shared-store-thread';
  await proxy.connectAgent();
  proxy.addMessage({ id: 'user-one', role: 'user', content: 'test' });
  await proxy.runAgent({ runId: 'run-shared' });

  const freshRunner = new InMemoryAgentRunner();
  const sharedMessages = freshRunner.getThreadMessages('shared-store-thread');
  expect(sharedMessages.length).toBeGreaterThan(0);
  expect(sharedMessages.at(-1)?.content).toBe('local answer');
});
