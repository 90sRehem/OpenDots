import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJson, LEARNING_LIMITS } from '../src/server/workspace.js';
import {
  citeMessage,
  cleanupLearningFixtures,
  completedWebTurn,
  dropLearningColumns,
  enableCollection,
  learningDatabasePath,
  onlyDot,
  openLearningStores,
  payloadFor,
  rawDatabase,
  sha256,
} from './learning-fixtures.js';

afterEach(cleanupLearningFixtures);

/** One completed owner turn in a fresh thread, cited by a proposal on `dotId`. */
function citedProposal(
  stores: ReturnType<typeof openLearningStores>,
  dotId: string,
  label: string,
) {
  const threadId = `thread-${label}-${randomUUID()}`;
  stores.workspace.bindThread(threadId, dotId, 'Thread');
  const turn = completedWebTurn(stores.conversations, {
    threadId,
    dotId,
    text: `Remember ${label}`,
  });
  return citeMessage(turn.message, turn.run);
}

describe('learning storage shape', () => {
  it('creates the approved tables, columns, and indexes', () => {
    const path = learningDatabasePath();
    openLearningStores(path);
    const db = rawDatabase(path);
    const columns = (table: string) =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name);
    expect(columns('learning_skills')).toEqual([
      'id',
      'ownerId',
      'dotId',
      'slug',
      'activeVersionId',
      'revision',
      'useCount',
      'lastUsedAt',
      'blockedUntil',
      'createdAt',
    ]);
    expect(columns('learning_versions')).toEqual([
      'id',
      'skillId',
      'version',
      'baseVersionId',
      'state',
      'payload',
      'contentHash',
      'evidence',
      'createdBy',
      'jobId',
      'extractorModel',
      'extractorPromptVersion',
      'safetyFindings',
      'safetyScanned',
      'createdAt',
      'reviewedAt',
      'reviewedBy',
      'reviewNote',
    ]);
    expect(columns('learning_jobs')).toEqual([
      'id',
      'ownerId',
      'dotId',
      'threadId',
      'sourceRunId',
      'signal',
      'state',
      'evidence',
      'sourceDigest',
      'patternHash',
      'consentRevision',
      'lease',
      'startedAt',
      'finishedAt',
      'reservedInputTokens',
      'reservedOutputTokens',
      'inputTokens',
      'outputTokens',
      'errorCode',
      'createdAt',
    ]);
    expect(columns('learning_uses')).toEqual([
      'skillId',
      'versionId',
      'sourceRunId',
      'usedAt',
    ]);
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'learning_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toEqual([
      'learning_jobs_budget',
      'learning_jobs_patterns',
      'learning_jobs_state',
      'learning_versions_state',
    ]);
    expect(
      columns('dots').includes('learningEnabled') &&
        columns('dots').includes('learningRevision'),
    ).toBe(true);
  });

  it('backfills safetyScanned for pre-existing extractor versions on upgrade', () => {
    const path = learningDatabasePath();
    const first = openLearningStores(path);
    const dot = onlyDot(first.workspace);
    const evidence = citedProposal(first, dot.id, 'backfill');
    const payload = payloadFor('backfill-check');
    const owner = first.workspace.proposeLearningVersion({
      dotId: dot.id,
      slug: 'backfill-check',
      payload,
      evidence: [evidence],
      state: 'pending',
      createdBy: 'owner',
      extractorPromptVersion: 'manual-v1',
    });
    const db = rawDatabase(path);
    db.prepare(
      `INSERT INTO learning_versions (id, skillId, version, baseVersionId, state, payload, contentHash, evidence, createdBy, jobId, extractorModel, extractorPromptVersion, safetyFindings, safetyScanned, createdAt, reviewedAt, reviewedBy, reviewNote)
       VALUES ('extractor-version', ?, ?, NULL, 'approved', ?, ?, ?, 'extractor', NULL, 'local', 'extractor-v1', '[]', 1, ?, NULL, NULL, NULL)`,
    ).run(
      owner.skillId,
      owner.version + 1,
      canonicalJson(payload),
      sha256(canonicalJson(payload)),
      canonicalJson([evidence]),
      Date.now(),
    );
    first.conversations.close();
    first.workspace.close();
    db.prepare('ALTER TABLE learning_versions DROP COLUMN safetyScanned').run();

    const upgraded = openLearningStores(path);
    expect(
      upgraded.workspace.learningVersion('extractor-version')?.safetyScanned,
    ).toBe(true);
    expect(upgraded.workspace.learningVersion(owner.id)?.safetyScanned).toBe(
      false,
    );
  });

  it('rejects states, signals, and job states outside the approved sets', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = citedProposal(stores, dot.id, 'shape');
    const version = stores.workspace.proposeLearningVersion({
      dotId: dot.id,
      slug: 'shape-check',
      payload: payloadFor('shape-check'),
      evidence: [evidence],
      state: 'pending',
      createdBy: 'owner',
      extractorPromptVersion: 'manual-v1',
    });
    const db = rawDatabase(path);
    expect(() =>
      db
        .prepare("UPDATE learning_versions SET state='live' WHERE id=?")
        .run(version.id),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO learning_jobs (id, ownerId, dotId, threadId, sourceRunId, signal, state, evidence, sourceDigest, consentRevision, createdAt)
           VALUES (?, 'owner', ?, 't', ?, 'guess', 'queued', '[]', ?, 0, 0)`,
        )
        .run(randomUUID(), dot.id, randomUUID(), sha256('x')),
    ).toThrow(/CHECK constraint/);
  });

  it('keeps version provenance immutable while letting review fields change', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const version = stores.workspace.proposeLearningVersion({
      dotId: dot.id,
      slug: 'immutable-check',
      payload: payloadFor('immutable-check'),
      evidence: [citedProposal(stores, dot.id, 'immutable')],
      state: 'pending',
      createdBy: 'owner',
      extractorPromptVersion: 'manual-v1',
    });
    const db = rawDatabase(path);
    expect(() =>
      db
        .prepare('UPDATE learning_versions SET payload=? WHERE id=?')
        .run('{"name":"other"}', version.id),
    ).toThrow(/provenance is immutable/);
    expect(() =>
      db
        .prepare('UPDATE learning_versions SET contentHash=? WHERE id=?')
        .run(sha256('other'), version.id),
    ).toThrow(/provenance is immutable/);
    // Review state is the part later review steps change; it stays writable.
    db.prepare("UPDATE learning_versions SET state='rejected' WHERE id=?").run(
      version.id,
    );
    expect(stores.workspace.learningVersion(version.id)?.state).toBe(
      'rejected',
    );
  });
});

describe('learning proposals', () => {
  it('stores a pending version with a canonical hash and monotonic numbers across reopen', () => {
    const path = learningDatabasePath();
    let stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = citedProposal(stores, dot.id, 'durable');
    const payload = payloadFor('durable-review');
    const first = stores.workspace.proposeLearningVersion({
      dotId: dot.id,
      slug: 'durable-review',
      payload,
      evidence: [evidence],
      state: 'pending',
      createdBy: 'owner',
      extractorPromptVersion: 'manual-v1',
    });
    const second = stores.workspace.proposeLearningVersion({
      dotId: dot.id,
      slug: 'durable-review',
      payload: { ...payload, verification: 'Check the cited page again.' },
      evidence: [evidence],
      state: 'quarantined',
      createdBy: 'owner',
      baseVersionId: first.id,
      extractorPromptVersion: 'manual-v1',
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.contentHash).toBe(sha256(canonicalJson(payload)));
    expect(second.baseVersionId).toBe(first.id);

    // Reopen the same file: proposals, hashes, and states survive a restart.
    stores.conversations.close();
    stores.workspace.close();
    stores = openLearningStores(path);
    const [skill] = stores.workspace.learningSkills(dot.id);
    expect(skill.slug).toBe('durable-review');
    const reread = stores.workspace.learningVersions(skill.id);
    expect(reread.map((row) => [row.version, row.state])).toEqual([
      [1, 'pending'],
      [2, 'quarantined'],
    ]);
    expect(reread[0]).toMatchObject({
      payload,
      evidence: [evidence],
      contentHash: first.contentHash,
      createdBy: 'owner',
      extractorPromptVersion: 'manual-v1',
    });
  });

  it('refuses payloads outside the approved schema or size', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = [citedProposal(stores, dot.id, 'schema')];
    const propose = (payload: unknown, slug = 'schema-check') =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug,
        payload,
        evidence,
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      });
    expect(() =>
      propose({ ...payloadFor('schema-check'), shell: 'rm -rf /' }),
    ).toThrow('reviewed schema');
    expect(() => propose(payloadFor('other-name'))).toThrow('reviewed schema');
    expect(() =>
      propose({
        ...payloadFor('schema-check'),
        description: 'x'.repeat(161),
      }),
    ).toThrow('reviewed schema');
    expect(() =>
      propose({
        ...payloadFor('schema-check'),
        steps: Array.from({ length: 9 }, () => 'Check.'),
      }),
    ).toThrow('reviewed schema');
    // Multi-byte text under the character limits still exceeds the 6 KiB byte cap.
    expect(() =>
      propose({
        ...payloadFor('schema-check'),
        steps: Array.from({ length: 8 }, () => '€'.repeat(300)),
      }),
    ).toThrow('size limit');
    expect(stores.workspace.learningSkills(dot.id)).toEqual([]);
  });

  it('refuses evidence that does not match canonical history', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const real = citedProposal(stores, dot.id, 'forged');
    const propose = (evidence: unknown[]) =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'forged-check',
        payload: payloadFor('forged-check'),
        evidence,
        state: 'pending',
        createdBy: 'extractor',
        jobId: null,
        extractorPromptVersion: 'extract-v1',
      });
    expect(() => propose([{ ...real, sha256: 'a'.repeat(64) }])).toThrow(
      /not verified \(digest_mismatch\)/,
    );
    expect(() => propose([{ ...real, ordinal: real.ordinal + 5 }])).toThrow(
      /not verified/,
    );
    expect(() =>
      propose([{ ...real, role: 'assistant', signal: 'repeated_workflow' }]),
    ).toThrow(/not verified \(message_mismatch\)/);
    expect(() => propose([{ ...real, role: 'assistant' }])).toThrow(
      /not verified \(role_not_direct_owner\)/,
    );
    expect(() => propose([{ ...real, threadId: 'elsewhere' }])).toThrow(
      /not verified \(thread_mismatch\)/,
    );
    expect(() => propose([{ ...real, messageId: randomUUID() }])).toThrow(
      /not verified \(message_not_found\)/,
    );
    // Extraction always cites canonical evidence; an empty citation is refused.
    expect(() => propose([])).toThrow('must cite canonical evidence');
  });

  it('keeps owner and extractor provenance tied to the right job', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = [citedProposal(stores, dot.id, 'provenance')];
    expect(() =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'provenance-check',
        payload: payloadFor('provenance-check'),
        evidence,
        state: 'pending',
        createdBy: 'owner',
        jobId: randomUUID(),
        extractorPromptVersion: 'manual-v1',
      }),
    ).toThrow('no extraction job');
    expect(() =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'provenance-check',
        payload: payloadFor('provenance-check'),
        evidence,
        state: 'pending',
        createdBy: 'extractor',
        jobId: randomUUID(),
        extractorPromptVersion: 'extract-v1',
      }),
    ).toThrow('its own Dot job');
    expect(() =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'provenance-check',
        payload: payloadFor('provenance-check'),
        evidence,
        state: 'approved' as 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      }),
    ).toThrow('start pending or quarantined');
  });

  it('enforces the per-Dot pending limit of ten', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = [citedProposal(stores, dot.id, 'per-dot')];
    const propose = (slug: string) =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug,
        payload: payloadFor(slug),
        evidence,
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      });
    for (let i = 0; i < LEARNING_LIMITS.pendingVersionsPerDot; i += 1)
      propose(`per-dot-${i}`);
    expect(() => propose('per-dot-overflow')).toThrow(
      'already has proposals awaiting review',
    );
  });

  it('enforces the workspace pending limit of one hundred across Dots', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const home = onlyDot(stores.workspace);
    const spaceId = home.spaceId;
    // Ten Dots with ten pending proposals each exactly fill the workspace cap.
    const dots = [home];
    for (let i = 1; i < 10; i += 1)
      dots.push(
        stores.workspace.createDot(spaceId, `Dot ${i}`, 'Help.', true, true),
      );
    for (const dot of dots) {
      const evidence = [citedProposal(stores, dot.id, `ws-${dot.id}`)];
      for (let i = 0; i < LEARNING_LIMITS.pendingVersionsPerDot; i += 1)
        stores.workspace.proposeLearningVersion({
          dotId: dot.id,
          slug: `ws-${i}`,
          payload: payloadFor(`ws-${i}`),
          evidence,
          state: 'pending',
          createdBy: 'owner',
          extractorPromptVersion: 'manual-v1',
        });
    }
    // An eleventh Dot has room under its own limit, so only the workspace cap can refuse it.
    const overflow = stores.workspace.createDot(
      spaceId,
      'Overflow',
      'Help.',
      true,
      true,
    );
    const evidence = [citedProposal(stores, overflow.id, 'ws-overflow')];
    expect(() =>
      stores.workspace.proposeLearningVersion({
        dotId: overflow.id,
        slug: 'ws-overflow',
        payload: payloadFor('ws-overflow'),
        evidence,
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      }),
    ).toThrow('Too many learning proposals');
  });

  it('caps each skill at eight versions and never overwrites one', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = [citedProposal(stores, dot.id, 'per-skill')];
    const propose = () =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'capped-skill',
        payload: payloadFor('capped-skill'),
        evidence,
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      });
    for (let i = 0; i < LEARNING_LIMITS.versionsPerSkill; i += 1) propose();
    expect(() => propose()).toThrow('maximum versions');
    const [skill] = stores.workspace.learningSkills(dot.id);
    expect(stores.workspace.learningVersions(skill.id)).toHaveLength(8);
  });

  it('caps learning skill identities at 512 workspace-wide', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = [citedProposal(stores, dot.id, 'identities')];
    const db = rawDatabase(path);
    const insert = db.prepare(
      "INSERT INTO learning_skills (id, ownerId, dotId, slug, revision, useCount, createdAt) VALUES (?, 'owner', ?, ?, 0, 0, ?)",
    );
    for (let i = 0; i < LEARNING_LIMITS.skillIdentities; i += 1)
      insert.run(randomUUID(), dot.id, `filler-${i}`, Date.now());
    expect(() =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'one-too-many',
        payload: payloadFor('one-too-many'),
        evidence,
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      }),
    ).toThrow('skill capacity is full');
  });

  it('prunes old terminal versions but keeps the newest number and referenced versions', () => {
    const path = learningDatabasePath();
    const stores = openLearningStores(path);
    const dot = onlyDot(stores.workspace);
    const evidence = [citedProposal(stores, dot.id, 'prune')];
    const propose = () =>
      stores.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug: 'pruned-skill',
        payload: payloadFor('pruned-skill'),
        evidence,
        state: 'pending',
        createdBy: 'owner',
        extractorPromptVersion: 'manual-v1',
      });
    const [v1, v2, v3] = [propose(), propose(), propose()];
    const db = rawDatabase(path);
    const old = Date.now() - LEARNING_LIMITS.versionRetentionMs - 1000;
    for (const version of [v1, v2, v3])
      db.prepare(
        "UPDATE learning_versions SET state='rejected', reviewedAt=? WHERE id=?",
      ).run(old, version.id);
    // Version 1 is referenced by a use row, so it must survive pruning.
    db.prepare(
      'INSERT INTO learning_uses (skillId, versionId, sourceRunId, usedAt) VALUES (?, ?, ?, ?)',
    ).run(v1.skillId, v1.id, randomUUID(), Date.now());
    propose();
    const [skill] = stores.workspace.learningSkills(dot.id);
    expect(
      stores.workspace.learningVersions(skill.id).map((row) => row.version),
    ).toEqual([1, 3, 4]);
  });
});

describe('dot and thread learning state', () => {
  it('copies the Dot opt-in into a thread only when that thread is created', () => {
    const path = learningDatabasePath();
    const { workspace } = openLearningStores(path);
    const dot = onlyDot(workspace);
    workspace.bindThread('before-opt-in', dot.id, 'Before');
    const enabled = enableCollection(workspace, dot);
    expect(enabled.learningEnabled).toBe(true);
    workspace.bindThread('after-opt-in', dot.id, 'After');
    const enrolled = Object.fromEntries(
      workspace
        .conversations()
        .map((thread) => [thread.id, thread.localLearningEnrolled]),
    );
    expect(enrolled).toEqual({
      'before-opt-in': false,
      'after-opt-in': true,
    });
  });

  it('bumps the learning revision on collection and permission changes only', () => {
    const path = learningDatabasePath();
    const { workspace } = openLearningStores(path);
    const dot = onlyDot(workspace);
    expect(dot.learningRevision).toBe(0);
    const renamed = workspace.updateDot(dot.id, {
      name: 'Renamed',
      instructions: dot.instructions,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
    });
    expect(renamed.learningRevision).toBe(0);
    const enabled = enableCollection(workspace, renamed);
    expect(enabled.learningRevision).toBe(1);
    const revoked = workspace.updateDot(dot.id, {
      name: enabled.name,
      instructions: enabled.instructions,
      researchAllowed: enabled.researchAllowed,
      memoryAllowed: false,
      learningEnabled: true,
    });
    expect(revoked.learningRevision).toBe(2);
  });

  it('keeps legacy threads opted out across restarts and later Dot changes', () => {
    const path = learningDatabasePath();
    const first = openLearningStores(path);
    const dot = onlyDot(first.workspace);
    first.workspace.bindThread(
      'legacy-thread',
      dot.id,
      'Created before upgrade',
    );
    first.conversations.close();
    first.workspace.close();
    dropLearningColumns(path);

    // The upgrade adds the columns with off defaults; the legacy thread gains nothing.
    const upgraded = openLearningStores(path);
    expect(
      upgraded.workspace
        .conversations()
        .find((thread) => thread.id === 'legacy-thread')?.localLearningEnrolled,
    ).toBe(false);
    enableCollection(upgraded.workspace, onlyDot(upgraded.workspace));
    upgraded.conversations.close();
    upgraded.workspace.close();

    const reopened = openLearningStores(path);
    const legacy = reopened.workspace
      .conversations()
      .find((thread) => thread.id === 'legacy-thread');
    expect(legacy?.localLearningEnrolled).toBe(false);
    expect(reopened.workspace.dot(dot.id)?.learningEnabled).toBe(true);
  });
});
