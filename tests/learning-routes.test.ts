import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import {
  LEARNING_LIMITS,
  WorkspaceStore,
  learningEvidenceHash,
} from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { ConversationStore } from '../src/server/conversation-store.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import type { LearningVersionView } from '../src/shared/learning.js';
import {
  cleanupLearningFixtures,
  learningDatabasePath,
  payloadFor,
} from './learning-fixtures.js';

// Owner-scoped learning routes, exercised through the real /api app so the host,
// origin, content-type and token checks all run in front of them.

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  cleanupLearningFixtures();
});

function fixture(ownerToken?: string) {
  const dbPath = learningDatabasePath();
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(dbPath, 'owner');
  const conversationStore = new ConversationStore(dbPath);
  cleanup.push(() => {
    store.close();
    ws.close();
    conversationStore.close();
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
    conversationStore,
  );
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken,
  });
  return { dbPath, ws, app, dotId: ws.dots()[0].id };
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function propose(
  app: ReturnType<typeof fixture>['app'],
  dotId: string,
  slug: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await app.request(
    `/api/dots/${dotId}/learning/proposals`,
    json({ payload: { ...payloadFor(slug), ...overrides } }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as LearningVersionView;
}

async function detail(
  app: ReturnType<typeof fixture>['app'],
  dotId: string,
  versionId: string,
) {
  const response = await app.request(
    `/api/dots/${dotId}/learning/versions/${versionId}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    version: LearningVersionView;
    replaces: LearningVersionView | null;
    review: {
      versionId: string;
      contentHash: string;
      evidenceHash: string;
      expectedActiveVersionId: string | null;
    };
  };
}

async function review(
  app: ReturnType<typeof fixture>['app'],
  dotId: string,
  versionId: string,
  action: 'approve' | 'reject' | 'retire' | 'restore',
  token: unknown,
) {
  return app.request(
    `/api/dots/${dotId}/learning/versions/${versionId}/${action}`,
    json({ review: token }),
  );
}

/** Proposes, reads the exact review, and approves: one full activation. */
async function activate(
  app: ReturnType<typeof fixture>['app'],
  dotId: string,
  slug: string,
) {
  const proposed = await propose(app, dotId, slug);
  const read = await detail(app, dotId, proposed.id);
  const approved = await review(
    app,
    dotId,
    proposed.id,
    'approve',
    read.review,
  );
  expect(approved.status).toBe(200);
  return (await approved.json()) as LearningVersionView;
}

describe('owner learning routes: lifecycle', () => {
  it('lists skills, reports extraction as unavailable, and records a proposal as pending', async () => {
    const { app, dotId } = fixture();
    const listed = await app.request(`/api/dots/${dotId}/learning`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      extraction: { available: false },
      usage: { activeSkills: 0, pendingVersions: 0 },
      skills: [],
    });
    const proposed = await propose(app, dotId, 'review-evidence');
    expect(proposed).toMatchObject({
      slug: 'review-evidence',
      state: 'pending',
      createdBy: 'owner',
      baseVersionId: null,
    });
    const after = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(after.usage.pendingVersions).toBe(1);
    expect(after.skills[0].versions[0]).toMatchObject({
      id: proposed.id,
      state: 'pending',
    });
  });

  it('approves the exact reviewed version, makes it active, and bumps the Dot revision', async () => {
    const { app, ws, dotId } = fixture();
    const before = ws.learningRevision(dotId);
    const active = await activate(app, dotId, 'review-evidence');
    expect(active.state).toBe('approved');
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(listed.skills[0].activeVersionId).toBe(active.id);
    expect(ws.learningRevision(dotId)).toBeGreaterThan(before);
  });

  it('refuses a review whose content, evidence, or active pointer no longer matches', async () => {
    const { app, dotId } = fixture();
    const first = await propose(app, dotId, 'review-evidence');
    const read = await detail(app, dotId, first.id);
    const tampered = await review(app, dotId, first.id, 'approve', {
      ...read.review,
      contentHash: '0'.repeat(64),
    });
    expect(tampered.status).toBe(409);
    expect(await tampered.json()).toMatchObject({ code: 'stale_content' });
    const wrongActive = await review(app, dotId, first.id, 'approve', {
      ...read.review,
      expectedActiveVersionId: 'some-other-version',
    });
    expect(wrongActive.status).toBe(409);
    expect(await wrongActive.json()).toMatchObject({ code: 'stale_active' });
    // Nothing was activated by either refused attempt.
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(listed.skills[0].activeVersionId).toBeNull();
  });

  it('rejects a proposal without touching the active library, and holds its slug back', async () => {
    const { app, ws, dotId } = fixture();
    const active = await activate(app, dotId, 'review-evidence');
    const second = await propose(app, dotId, 'triage-notes');
    const read = await detail(app, dotId, second.id);
    const rejected = await review(app, dotId, second.id, 'reject', read.review);
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ state: 'rejected' });
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(
      listed.skills.find((s: { slug: string }) => s.slug === 'review-evidence')
        .activeVersionId,
    ).toBe(active.id);
    expect(
      listed.skills.find((s: { slug: string }) => s.slug === 'triage-notes')
        .blockedUntil,
    ).toBeGreaterThan(Date.now());
    expect(ws.learningVersion(second.id)?.state).toBe('rejected');
  });

  it('edits create a new pending version based on the active one, and leave the reviewed text unchanged', async () => {
    const { app, dotId } = fixture();
    const active = await activate(app, dotId, 'review-evidence');
    const read = await detail(app, dotId, active.id);
    const edited = await app.request(
      `/api/dots/${dotId}/learning/versions/${active.id}/edit`,
      json({
        review: read.review,
        payload: {
          ...payloadFor('review-evidence'),
          verification: 'Check two sources.',
        },
      }),
    );
    expect(edited.status).toBe(201);
    const pending = (await edited.json()) as LearningVersionView;
    expect(pending).toMatchObject({
      state: 'pending',
      baseVersionId: active.id,
      payload: { verification: 'Check two sources.' },
    });
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    const versions = listed.skills[0].versions as LearningVersionView[];
    expect(versions.find((v) => v.id === active.id)).toMatchObject({
      state: 'approved',
      payload: { verification: payloadFor('review-evidence').verification },
    });
  });

  it('refuses an edit that renames the lesson', async () => {
    const { app, dotId } = fixture();
    const active = await activate(app, dotId, 'review-evidence');
    const read = await detail(app, dotId, active.id);
    const renamed = await app.request(
      `/api/dots/${dotId}/learning/versions/${active.id}/edit`,
      json({
        review: read.review,
        payload: payloadFor('other-name'),
      }),
    );
    expect(renamed.status).toBe(400);
  });

  it('retires the active version at once, and restores it only through a fresh review', async () => {
    const { app, dotId } = fixture();
    const active = await activate(app, dotId, 'review-evidence');
    const read = await detail(app, dotId, active.id);
    const retired = await review(app, dotId, active.id, 'retire', read.review);
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({ state: 'retired' });
    const afterRetire = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(afterRetire.skills[0].activeVersionId).toBeNull();
    const retiredRead = await detail(app, dotId, active.id);
    const restored = await review(
      app,
      dotId,
      active.id,
      'restore',
      retiredRead.review,
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ state: 'approved' });
  });

  it('refuses a review that names a different version than the path', async () => {
    const { app, dotId } = fixture();
    const first = await propose(app, dotId, 'review-evidence');
    const other = await propose(app, dotId, 'triage-notes');
    const read = await detail(app, dotId, first.id);
    const mismatched = await review(
      app,
      dotId,
      other.id,
      'approve',
      read.review,
    );
    expect(mismatched.status).toBe(400);
  });

  it('refuses unknown fields and oversized lessons', async () => {
    const { app, dotId } = fixture();
    const extra = await app.request(
      `/api/dots/${dotId}/learning/proposals`,
      json({ payload: payloadFor('review-evidence'), extractorModel: 'x' }),
    );
    expect(extra.status).toBe(400);
    const oversized = await app.request(
      `/api/dots/${dotId}/learning/proposals`,
      json({
        payload: {
          ...payloadFor('review-evidence'),
          steps: ['x'.repeat(301)],
        },
      }),
    );
    expect(oversized.status).toBe(400);
  });

  it('caps pending proposals per Dot and reports the refusal without changing the library', async () => {
    const { app, dotId } = fixture();
    const active = await activate(app, dotId, 'review-evidence');
    for (let index = 0; index < LEARNING_LIMITS.pendingVersionsPerDot; index++)
      await propose(app, dotId, `lesson-${index}`);
    const refused = await app.request(
      `/api/dots/${dotId}/learning/proposals`,
      json({ payload: payloadFor('lesson-extra') }),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'This Dot already has proposals awaiting review.',
    });
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(
      listed.skills.find((s: { slug: string }) => s.slug === 'review-evidence')
        .activeVersionId,
    ).toBe(active.id);
    expect(listed.usage.pendingVersions).toBe(
      LEARNING_LIMITS.pendingVersionsPerDot,
    );
  });

  it('refuses activation past the Dot active cap and keeps every active skill', async () => {
    const { app, ws, dotId } = fixture();
    // Fill the cap through the store: the HTTP path is covered above, and this keeps the test fast.
    for (let index = 0; index < LEARNING_LIMITS.activeSkillsPerDot; index++) {
      const version = ws.proposeLearningVersion({
        dotId,
        slug: `skill-${index}`,
        payload: payloadFor(`skill-${index}`),
        evidence: [],
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'owner-v1',
      });
      ws.approveLearningVersion({
        versionId: version.id,
        contentHash: version.contentHash,
        evidenceHash: learningEvidenceHash(version.evidence),
        expectedActiveVersionId: null,
      });
    }
    const proposed = await propose(app, dotId, 'one-too-many');
    const read = await detail(app, dotId, proposed.id);
    const refused = await review(
      app,
      dotId,
      proposed.id,
      'approve',
      read.review,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'capacity' });
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(listed.usage.activeSkills).toBe(LEARNING_LIMITS.activeSkillsPerDot);
    expect(
      listed.skills.filter(
        (s: { activeVersionId: string | null }) => s.activeVersionId,
      ),
    ).toHaveLength(LEARNING_LIMITS.activeSkillsPerDot);
  });
});

describe('owner learning routes: transport and ownership', () => {
  it('refuses unauthenticated learning requests when the owner token is configured', async () => {
    const { app, dotId } = fixture('owner-secret');
    expect((await app.request(`/api/dots/${dotId}/learning`)).status).toBe(401);
    expect(
      (
        await app.request(
          `/api/dots/${dotId}/learning/proposals`,
          json({ payload: payloadFor('review-evidence') }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(`/api/dots/${dotId}/learning`, {
          headers: { Authorization: 'Bearer owner-secret' },
        })
      ).status,
    ).toBe(200);
  });

  it('refuses cross-origin and form-encoded learning mutations through the shared API checks', async () => {
    const { app, dotId } = fixture();
    expect(
      (
        await app.request(`/api/dots/${dotId}/learning/proposals`, {
          ...json({ payload: payloadFor('review-evidence') }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://evil.example',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/dots/${dotId}/learning/proposals`, {
          method: 'POST',
          body: 'payload=hello',
        })
      ).status,
    ).toBe(415);
  });

  it('answers 404 for an unknown Dot and for a learning version another owner wrote', async () => {
    const { app, dbPath, ws, dotId } = fixture();
    expect((await app.request('/api/dots/missing/learning')).status).toBe(404);
    // A second owner writes a proposal against the same Dot in the same database.
    const stranger = new WorkspaceStore(dbPath, 'stranger');
    cleanup.push(() => stranger.close());
    const foreign = stranger.proposeLearningVersion({
      dotId,
      slug: 'foreign-lesson',
      payload: payloadFor('foreign-lesson'),
      evidence: [],
      state: 'pending',
      createdBy: 'owner',
      extractorPromptVersion: 'owner-v1',
    });
    // The owner neither lists nor reads it, and cannot review or edit it.
    const listed = await (
      await app.request(`/api/dots/${dotId}/learning`)
    ).json();
    expect(JSON.stringify(listed)).not.toContain(foreign.id);
    expect(
      (await app.request(`/api/dots/${dotId}/learning/versions/${foreign.id}`))
        .status,
    ).toBe(404);
    const token = {
      versionId: foreign.id,
      contentHash: foreign.contentHash,
      evidenceHash: foreign.contentHash,
      expectedActiveVersionId: null,
    };
    expect(
      (await review(app, dotId, foreign.id, 'approve', token)).status,
    ).toBe(404);
    expect((await review(app, dotId, foreign.id, 'reject', token)).status).toBe(
      404,
    );
    expect(
      (
        await app.request(
          `/api/dots/${dotId}/learning/versions/${foreign.id}/edit`,
          json({ review: token, payload: payloadFor('foreign-lesson') }),
        )
      ).status,
    ).toBe(404);
    expect(stranger.learningVersion(foreign.id)?.state).toBe('pending');
    expect(ws.learningVersion(foreign.id)?.state).toBe('pending');
  });

  it('refuses a version reached through a Dot it does not belong to', async () => {
    const { app, ws, dotId } = fixture();
    const proposed = await propose(app, dotId, 'review-evidence');
    const otherDot = ws.createDot(
      ws.spaces()[0].id,
      'Second Dot',
      'Second Dot instructions.',
      true,
      true,
    );
    expect(
      (
        await app.request(
          `/api/dots/${otherDot.id}/learning/versions/${proposed.id}`,
        )
      ).status,
    ).toBe(404);
  });
});
