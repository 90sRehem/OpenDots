import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { extractionClaimLimits } from '../src/server/learning.js';
import type {
  ConversationStore,
  LearningJob,
} from '../src/server/conversation-store.js';
import type { WorkspaceStore } from '../src/server/workspace.js';
import { citeMessage, openWebTurn, sha256 } from './learning-fixtures.js';

// Shared fixtures for the local extraction tests. The fake model is a real
// loopback HTTP server that speaks the streamed chat-completions wire format, so
// the adapter, the pinned fetch, and the call path all run unmodified.

export type ModelAnswer =
  | { kind: 'stream'; content: string; usage?: boolean; chunkSize?: number }
  | { kind: 'redirect'; location: string }
  | { kind: 'status'; code: number }
  | { kind: 'hang' };

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: { model?: string; messages?: { role: string; content: unknown }[] };
}

export interface LoopbackModel {
  baseURL: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startLoopbackModel(
  answer: (request: RecordedRequest) => ModelAnswer | Promise<ModelAnswer>,
): Promise<LoopbackModel> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      path: request.url ?? '',
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
    };
    requests.push(recorded);
    const reply = await answer(recorded);
    if (reply.kind === 'hang') return;
    if (reply.kind === 'redirect') {
      response.writeHead(302, { Location: reply.location });
      response.end();
      return;
    }
    if (reply.kind === 'status') {
      response.writeHead(reply.code, { 'Content-Type': 'application/json' });
      response.end('{"error":"refused"}');
      return;
    }
    const frame = (delta: object, finish: string | null, usage?: object) =>
      `data: ${JSON.stringify({
        id: 'loopback-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: recorded.body.model ?? 'model',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunkSize =
      reply.chunkSize && reply.chunkSize > 0
        ? reply.chunkSize
        : reply.content.length || 1;
    for (let offset = 0; offset < reply.content.length; offset += chunkSize) {
      response.write(
        frame(
          {
            role: offset === 0 ? 'assistant' : undefined,
            content: reply.content.slice(offset, offset + chunkSize),
          },
          null,
        ),
      );
    }
    response.write(
      frame(
        {},
        'stop',
        reply.usage
          ? { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
          : undefined,
      ),
    );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A lesson reply in the exact strict shape the model is asked for. */
export function lessonReply(
  name: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    lesson: {
      name,
      description:
        'Check each cited research claim against its source before summarizing.',
      triggers: ['review research sources'],
      steps: ['Open the cited source and confirm the claim appears in it.'],
      pitfalls: ['Do not present an unverified claim as confirmed.'],
      verification:
        'Every substantive claim links to a source the owner can open.',
      requiredTools: ['read_space_page'],
      notFor: ['Authorizing connected-service writes'],
      ...overrides,
    },
  });
}

/** Queues one extraction job from a completed web-owner correction turn. */
export function queueCorrection(
  conversations: ConversationStore,
  dotId: string,
  threadId: string,
  text: string,
): LearningJob {
  const turn = openWebTurn(conversations, { threadId, dotId, text });
  const finished = conversations.finishRunWithLearning(
    turn.run.id,
    'completed',
    null,
    {
      signal: 'correction',
      evidence: [citeMessage(turn.message, turn.run)],
      sourceDigest: sha256(text),
    },
  );
  if (!finished.job)
    throw new Error(`Expected a queued job, got ${finished.skipped}.`);
  return finished.job;
}

/** Queues a correction job whose run is still open, so the caller can extend it first. */
export function openCorrection(
  conversations: ConversationStore,
  dotId: string,
  threadId: string,
  text: string,
) {
  return openWebTurn(conversations, { threadId, dotId, text });
}

/** Moves a queued job to running and returns the lease that owns it. */
export function claimJob(
  conversations: ConversationStore,
  job: LearningJob,
  now = Date.now(),
): { job: LearningJob; lease: string } {
  const lease = randomUUID();
  const claim = conversations.claimLearningJob(
    job.id,
    lease,
    extractionClaimLimits(now),
    now,
  );
  if (!('job' in claim)) throw new Error(`Claim skipped: ${claim.skipped}.`);
  return { job: claim.job, lease };
}

/** The Dot's approved-or-pending versions, read through the same store the worker writes to. */
export function versionsFor(workspace: WorkspaceStore, dotId: string) {
  return workspace
    .learningSkills(dotId)
    .flatMap((skill) => workspace.learningVersions(skill.id));
}

/** Polls until the predicate holds, failing the test after the deadline. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
