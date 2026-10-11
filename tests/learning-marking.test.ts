import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { ConversationStore } from '../src/server/conversation-store.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { learningExtractionStatus } from '../src/server/learning.js';
import type { LearningVersionView } from '../src/shared/learning.js';
import {
  citeMessage,
  cleanupLearningFixtures,
  completedWebTurn,
  enableCollection,
  learningDatabasePath,
  onlyDot,
  openWebTurn,
  payloadFor,
  rawDatabase,
} from './learning-fixtures.js';

// Explicit owner marking: an owner names one of their own completed turns and
// writes the lesson. It goes through the real /api app, so the host, origin,
// token and ownership checks all run in front of it.

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  cleanupLearningFixtures();
  vi.restoreAllMocks();
});

/**
 * A workspace whose default Dot is opted in to learning. A thread bound before
 * the Dot opts in is never enrolled, which is how these tests make legacy threads.
 */
function marking(options: { ownerToken?: string; enable?: boolean } = {}) {
  const dbPath = learningDatabasePath();
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(dbPath, 'owner');
  const conversations = new ConversationStore(dbPath);
  cleanup.push(() => {
    store.close();
    ws.close();
    conversations.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(
    store,
    ws,
    {
      baseUrl: config.baseUrl,
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
    },
    conversations,
  );
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: options.ownerToken,
  });
  const base = onlyDot(ws);
  const dot = options.enable === false ? base : enableCollection(ws, base);
  return { dbPath, ws, conversations, app, dot };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type Harness = ReturnType<typeof marking>;

function markRequest(
  dotId: string,
  runId: string,
  slug: string,
  overrides: Record<string, unknown> = {},
) {
  return [
    `/api/dots/${dotId}/learning/runs/${runId}/proposals`,
    json({ payload: { ...payloadFor(slug), ...overrides } }),
  ] as const;
}

async function mark(
  app: Harness['app'],
  dotId: string,
  runId: string,
  slug: string,
  overrides: Record<string, unknown> = {},
) {
  return app.request(...markRequest(dotId, runId, slug, overrides));
}

interface TurnList {
  available: boolean;
  reason: string;
  turns: {
    runId: string;
    conversationTitle: string;
    excerpt: string;
    marked: boolean;
  }[];
}

async function turnList(app: Harness['app'], dotId: string) {
  const response = await app.request(`/api/dots/${dotId}/learning/turns`);
  expect(response.status).toBe(200);
  return (await response.json()) as TurnList;
}

describe('owner marking: which turns can be marked', () => {
  it('lists completed web-owner turns of opted-in conversations, newest first', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const first = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Always cite the source page before a claim.',
    });
    const second = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Keep the summary under three bullets.',
    });
    const listed = await turnList(app, dot.id);
    expect(listed.available).toBe(true);
    expect(listed.turns.map((turn) => turn.runId)).toEqual([
      second.run.id,
      first.run.id,
    ]);
    expect(listed.turns[0]).toMatchObject({
      conversationTitle: 'Research notes',
      excerpt: 'Keep the summary under three bullets.',
      marked: false,
    });
  });

  it('refuses every ineligible turn and stores no proposal for any of them', async () => {
    const { app, ws, conversations, dbPath, dot } = marking();
    const db = rawDatabase(dbPath);
    for (const threadId of [
      'thread-channel',
      'thread-task',
      'thread-voice',
      'thread-failed',
      'thread-interrupted',
      'thread-running',
      'thread-unbounded',
      'thread-legacy',
    ])
      ws.bindThread(threadId, dot.id, threadId);

    const channel = openWebTurn(
      conversations,
      { threadId: 'thread-channel', dotId: dot.id, text: 'From Telegram.' },
      'channel_owner',
    );
    conversations.finishRun(channel.run.id, 'completed');
    const task = openWebTurn(
      conversations,
      { threadId: 'thread-task', dotId: dot.id, text: 'Scheduled.' },
      'scheduled_task',
    );
    conversations.finishRun(task.run.id, 'completed');
    const voice = openWebTurn(
      conversations,
      { threadId: 'thread-voice', dotId: dot.id, text: 'Said aloud.' },
      'voice_compute',
    );
    conversations.finishRun(voice.run.id, 'completed');
    const failed = openWebTurn(conversations, {
      threadId: 'thread-failed',
      dotId: dot.id,
      text: 'Failed turn.',
    });
    conversations.finishRun(failed.run.id, 'failed', 'Model error.');
    const interrupted = openWebTurn(conversations, {
      threadId: 'thread-interrupted',
      dotId: dot.id,
      text: 'Interrupted turn.',
    });
    conversations.finishRun(interrupted.run.id, 'interrupted', 'restart');
    const running = openWebTurn(conversations, {
      threadId: 'thread-running',
      dotId: dot.id,
      text: 'Still running.',
    });
    const unbounded = completedWebTurn(conversations, {
      threadId: 'thread-unbounded',
      dotId: dot.id,
      text: 'Recorded before bounds.',
    });
    db.prepare(
      'UPDATE conversation_runs SET firstOrdinal=NULL, lastOrdinal=NULL WHERE id=?',
    ).run(unbounded.run.id);
    const legacy = completedWebTurn(conversations, {
      threadId: 'thread-legacy',
      dotId: dot.id,
      text: 'Conversation that never opted in.',
    });
    db.prepare(
      'UPDATE thread_bindings SET localLearningEnrolled=0 WHERE id=?',
    ).run('thread-legacy');

    const refused: [string, string][] = [
      [channel.run.id, 'channel'],
      [task.run.id, 'scheduled'],
      [voice.run.id, 'voice'],
      [failed.run.id, 'failed'],
      [interrupted.run.id, 'interrupted'],
      [running.run.id, 'running'],
      [unbounded.run.id, 'unbounded'],
      [legacy.run.id, 'not-enrolled'],
    ];
    for (const [runId, label] of refused) {
      const response = await mark(app, dot.id, runId, `refused-${label}`);
      expect(response.status, label).toBe(409);
      expect(await response.json(), label).toMatchObject({
        code: 'ineligible_run',
      });
    }

    expect(ws.learningSkills(dot.id)).toHaveLength(0);
    expect(ws.learningUsage(dot.id).pendingVersions).toBe(0);
    // None of these turns is offered for marking.
    const listed = await turnList(app, dot.id);
    expect(listed.turns).toEqual([]);
    expect(listed.reason).toContain('No completed turns');
  });

  it('says why nothing can be marked when the Dot has learning off', async () => {
    const { app, ws, conversations, dot } = marking({ enable: false });
    ws.bindThread('thread-off', dot.id, 'Off');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-off',
      dotId: dot.id,
      text: 'Recorded while learning was off.',
    });
    const listed = await turnList(app, dot.id);
    expect(listed).toMatchObject({ available: false, turns: [] });
    expect(listed.reason).toContain('Learn from future conversations');
    const response = await mark(app, dot.id, turn.run.id, 'off-for-dot');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'ineligible_run' });
  });
});

describe('owner marking: the proposal it creates', () => {
  it('writes an owner-authored pending lesson from the chosen turn with no model call', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Check the cited source before a claim.',
    });
    // No local extractor is configured, and the request must not reach any model.
    expect(learningExtractionStatus().available).toBe(false);
    const fetch = vi.spyOn(globalThis, 'fetch');

    const response = await mark(app, dot.id, turn.run.id, 'cite-before-claims');
    expect(response.status).toBe(201);
    const created = (await response.json()) as LearningVersionView;
    expect(created).toMatchObject({
      slug: 'cite-before-claims',
      state: 'pending',
      createdBy: 'owner',
      extractorPromptVersion: 'owner-v1',
      safetyFindings: [],
    });
    // The one evidence record cites the owner's own message by digest, as explicit.
    expect(created.evidence).toEqual([
      citeMessage(turn.message, turn.run, 'explicit'),
    ]);
    expect(fetch).not.toHaveBeenCalled();

    const listed = await turnList(app, dot.id);
    expect(listed.turns).toEqual([
      expect.objectContaining({ runId: turn.run.id, marked: true }),
    ]);
  });

  it('keeps the marked lesson pending until it is reviewed and approved', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Check the cited source before a claim.',
    });
    const created = (await (
      await mark(app, dot.id, turn.run.id, 'review-first')
    ).json()) as LearningVersionView;
    // Choosing the turn is not activation.
    expect(ws.learningSkills(dot.id)[0].activeVersionId).toBeNull();

    const read = await app.request(
      `/api/dots/${dot.id}/learning/versions/${created.id}`,
    );
    const { review } = (await read.json()) as {
      review: Record<string, unknown>;
    };
    const approved = await app.request(
      `/api/dots/${dot.id}/learning/versions/${created.id}/approve`,
      json({ review }),
    );
    expect(approved.status).toBe(200);
    expect(ws.learningSkills(dot.id)[0].activeVersionId).toBe(created.id);
  });

  it('stores a lesson with a soft finding as quarantined, and refuses to approve it', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Link the source page.',
    });
    const response = await mark(app, dot.id, turn.run.id, 'with-a-link', {
      description: 'Read https://example.com/source before a claim.',
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as LearningVersionView;
    expect(created.state).toBe('quarantined');
    expect(created.safetyFindings.map((finding) => finding.code)).toContain(
      'link',
    );

    const read = await app.request(
      `/api/dots/${dot.id}/learning/versions/${created.id}`,
    );
    const { review } = (await read.json()) as {
      review: Record<string, unknown>;
    };
    const approved = await app.request(
      `/api/dots/${dot.id}/learning/versions/${created.id}/approve`,
      json({ review }),
    );
    expect(approved.status).toBe(409);
    expect(ws.learningSkills(dot.id)[0].activeVersionId).toBeNull();
  });

  it('refuses a lesson with a hard finding and stores nothing', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Use the template.',
    });
    const response = await mark(app, dot.id, turn.run.id, 'templated', {
      verification: 'Run {{ command }} to check the result.',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('Template syntax is not allowed.'),
    });
    expect(ws.learningSkills(dot.id)).toHaveLength(0);
    // The refusal leaves the turn unmarked, so a corrected lesson can still use it.
    expect((await turnList(app, dot.id)).turns[0].marked).toBe(false);
  });

  it('refuses a second lesson from the same turn', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Check the cited source before a claim.',
    });
    expect((await mark(app, dot.id, turn.run.id, 'first-lesson')).status).toBe(
      201,
    );
    const again = await mark(app, dot.id, turn.run.id, 'second-lesson');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'duplicate_run' });
    expect(ws.learningUsage(dot.id).pendingVersions).toBe(1);
  });

  it('refuses an exact repeat of a lesson that already exists', async () => {
    const { app, ws, conversations, dot } = marking();
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const first = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Check the cited source before a claim.',
    });
    const second = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Check the cited source again.',
    });
    expect((await mark(app, dot.id, first.run.id, 'repeat-me')).status).toBe(
      201,
    );
    const repeat = await mark(app, dot.id, second.run.id, 'repeat-me');
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toMatchObject({ code: 'state' });
    // The refused turn never claimed its run, so it is still offered.
    expect(
      (await turnList(app, dot.id)).turns.find(
        (item) => item.runId === second.run.id,
      )?.marked,
    ).toBe(false);
  });
});

describe('owner marking: transport and ownership', () => {
  it('refuses unauthenticated turn listing and marking when the owner token is configured', async () => {
    const { app, ws, conversations, dot } = marking({
      ownerToken: 'owner-secret',
    });
    ws.bindThread('thread-web', dot.id, 'Research notes');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-web',
      dotId: dot.id,
      text: 'Check the cited source before a claim.',
    });
    expect(
      (await app.request(`/api/dots/${dot.id}/learning/turns`)).status,
    ).toBe(401);
    expect((await mark(app, dot.id, turn.run.id, 'needs-token')).status).toBe(
      401,
    );
    expect(ws.learningSkills(dot.id)).toHaveLength(0);
    const authorized = await app.request(`/api/dots/${dot.id}/learning/turns`, {
      headers: { Authorization: 'Bearer owner-secret' },
    });
    expect(authorized.status).toBe(200);
  });

  it('answers 404 for an unknown Dot and for a turn another owner wrote', async () => {
    const { app, ws, conversations, dbPath, dot } = marking();
    const db = rawDatabase(dbPath);
    ws.bindThread('thread-owned-elsewhere', dot.id, 'Theirs');
    const foreign = completedWebTurn(conversations, {
      threadId: 'thread-owned-elsewhere',
      dotId: dot.id,
      text: 'Another owner wrote this turn.',
    });
    db.prepare("UPDATE thread_bindings SET ownerId='stranger' WHERE id=?").run(
      'thread-owned-elsewhere',
    );

    expect((await app.request('/api/dots/missing/learning/turns')).status).toBe(
      404,
    );
    expect(
      (await mark(app, 'missing', foreign.run.id, 'unknown-dot')).status,
    ).toBe(404);
    const refused = await mark(app, dot.id, foreign.run.id, 'foreign-turn');
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: 'Turn not found.' });
    expect((await turnList(app, dot.id)).turns).toEqual([]);
    expect(ws.learningSkills(dot.id)).toHaveLength(0);
  });

  it('refuses a turn named through a Dot it does not belong to', async () => {
    const { app, ws, conversations, dot } = marking();
    const other = ws.createDot(
      ws.spaces()[0].id,
      'Second Dot',
      'Second Dot instructions.',
      true,
      true,
    );
    ws.bindThread('thread-first', dot.id, 'First');
    const turn = completedWebTurn(conversations, {
      threadId: 'thread-first',
      dotId: dot.id,
      text: 'Belongs to the first Dot.',
    });
    const response = await mark(app, other.id, turn.run.id, 'wrong-dot');
    expect(response.status).toBe(404);
    expect(ws.learningSkills(other.id)).toHaveLength(0);
  });
});
