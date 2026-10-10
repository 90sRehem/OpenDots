import { ComputerStore } from './computer-store.js';
import { ConnectionStore } from './connection-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateLearningSettings } from '../shared/learning.js';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';

// Local Automatic Learning storage (design report sections 4.2 and 4.5). The
// tables live in the same database file as the other stores; these helpers
// are shared with conversation-store.ts, which owns job creation.

export const LEARNING_SIGNALS = [
  'explicit',
  'correction',
  'repeated_workflow',
] as const;
export type LearningSignal = (typeof LEARNING_SIGNALS)[number];
export type LearningVersionState =
  | 'pending'
  | 'quarantined'
  | 'approved'
  | 'rejected'
  | 'retired'
  | 'superseded';

const DAY_MS = 86_400_000;
/** Proposed v1 caps. Activation caps (32 per Dot, 256 workspace) belong to the review lifecycle. */
export const LEARNING_LIMITS = {
  payloadBytes: 6 * 1024,
  evidenceBytes: 4 * 1024,
  evidenceRecords: 6,
  safetyBytes: 2 * 1024,
  safetyFindings: 10,
  skillIdentities: 512,
  versionRows: 2048,
  jobRows: 2048,
  pendingVersions: 100,
  pendingVersionsPerDot: 10,
  versionsPerSkill: 8,
  queuedJobs: 20,
  storageBytes: 32 * 1024 * 1024,
  jobRetentionMs: 30 * DAY_MS,
  useRetentionMs: 30 * DAY_MS,
  versionRetentionMs: 90 * DAY_MS,
} as const;

const learningSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const boundedText = (max: number) => z.string().min(1).max(max);

/** Approved payload shape. Extra keys are rejected; `name` must equal the skill slug. */
export const learningPayloadSchema = z
  .object({
    name: learningSlugSchema,
    description: boundedText(160),
    triggers: z.array(boundedText(100)).min(1).max(5),
    steps: z.array(boundedText(300)).min(1).max(8),
    pitfalls: z.array(boundedText(200)).max(5),
    verification: boundedText(300),
    requiredTools: z.array(boundedText(80)).max(8),
    notFor: z.array(boundedText(150)).max(3),
  })
  .strict();
export type LearningPayload = z.infer<typeof learningPayloadSchema>;

/** One canonical message a proposal or job cites. Ids refer to internal records only. */
export const learningEvidenceRecordSchema = z
  .object({
    threadId: boundedText(200),
    runId: boundedText(200),
    messageId: boundedText(200),
    ordinal: z.number().int().min(0),
    role: z.enum(['user', 'assistant', 'tool']),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signal: z.enum(LEARNING_SIGNALS),
  })
  .strict();
export type LearningEvidenceRecord = z.infer<
  typeof learningEvidenceRecordSchema
>;

const safetyFindingSchema = z
  .object({
    code: boundedText(80),
    explanation: z.string().max(300),
  })
  .strict();
export type SafetyFinding = z.infer<typeof safetyFindingSchema>;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable JSON: keys sorted at every level, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
}
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

export function applyLearningSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS learning_skills (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      dotId TEXT NOT NULL,
      slug TEXT NOT NULL,
      activeVersionId TEXT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      useCount INTEGER NOT NULL DEFAULT 0,
      lastUsedAt INTEGER NULL,
      blockedUntil INTEGER NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(ownerId, dotId, slug)
    );
    CREATE TABLE IF NOT EXISTS learning_versions (
      id TEXT PRIMARY KEY,
      skillId TEXT NOT NULL REFERENCES learning_skills(id),
      version INTEGER NOT NULL,
      baseVersionId TEXT NULL,
      state TEXT NOT NULL CHECK (state IN
        ('pending','quarantined','approved','rejected','retired','superseded')),
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      contentHash TEXT NOT NULL,
      evidence TEXT NOT NULL CHECK (json_valid(evidence)),
      createdBy TEXT NOT NULL CHECK (createdBy IN ('extractor','owner')),
      jobId TEXT NULL,
      extractorModel TEXT NULL,
      extractorPromptVersion TEXT NOT NULL,
      safetyFindings TEXT NOT NULL CHECK (json_valid(safetyFindings)),
      createdAt INTEGER NOT NULL,
      reviewedAt INTEGER NULL,
      reviewedBy TEXT NULL,
      reviewNote TEXT NULL,
      UNIQUE(skillId, version)
    );
    CREATE TABLE IF NOT EXISTS learning_jobs (
      id TEXT PRIMARY KEY,
      ownerId TEXT NOT NULL,
      dotId TEXT NOT NULL,
      threadId TEXT NOT NULL,
      sourceRunId TEXT NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN
        ('explicit','correction','repeated_workflow')),
      state TEXT NOT NULL CHECK (state IN
        ('queued','running','completed','no_change','failed','interrupted','cancelled')),
      evidence TEXT NOT NULL CHECK (json_valid(evidence)),
      sourceDigest TEXT NOT NULL,
      patternHash TEXT NULL,
      consentRevision INTEGER NOT NULL,
      lease TEXT NULL,
      startedAt INTEGER NULL,
      finishedAt INTEGER NULL,
      reservedInputTokens INTEGER NOT NULL DEFAULT 0,
      reservedOutputTokens INTEGER NOT NULL DEFAULT 0,
      inputTokens INTEGER NULL,
      outputTokens INTEGER NULL,
      errorCode TEXT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(ownerId, sourceRunId)
    );
    CREATE TABLE IF NOT EXISTS learning_uses (
      skillId TEXT NOT NULL REFERENCES learning_skills(id),
      versionId TEXT NOT NULL REFERENCES learning_versions(id),
      sourceRunId TEXT NOT NULL,
      usedAt INTEGER NOT NULL,
      PRIMARY KEY(versionId, sourceRunId)
    );
    CREATE INDEX IF NOT EXISTS learning_versions_state ON learning_versions(state, createdAt);
    CREATE INDEX IF NOT EXISTS learning_jobs_state ON learning_jobs(state, createdAt);
    CREATE INDEX IF NOT EXISTS learning_jobs_budget ON learning_jobs(ownerId, startedAt);
    CREATE INDEX IF NOT EXISTS learning_jobs_patterns ON learning_jobs(ownerId, dotId, patternHash, createdAt);
    CREATE TRIGGER IF NOT EXISTS learning_versions_provenance_immutable
      BEFORE UPDATE OF payload, evidence, contentHash, safetyFindings, skillId, version,
        baseVersionId, createdBy, jobId, extractorModel, extractorPromptVersion, createdAt
      ON learning_versions
    BEGIN
      SELECT RAISE(ABORT, 'Learning version provenance is immutable.');
    END;`);
}

/**
 * Checks each cited record against canonical history: the run must be a
 * completed web-owner run for this Dot, the message must sit inside that run's
 * recorded ordinal bounds, and its stored bytes must match the cited digest.
 * Returns a failure code, or null when every record verifies. A JSON reference
 * alone is never authorization.
 */
export function canonicalEvidenceFailure(
  db: DatabaseSync,
  input: {
    dotId: string;
    signal?: LearningSignal;
    sourceRunId?: string;
    evidence: LearningEvidenceRecord[];
  },
): string | null {
  if (
    input.sourceRunId &&
    !input.evidence.some((record) => record.runId === input.sourceRunId)
  )
    return 'source_run_not_cited';
  for (const record of input.evidence) {
    if (input.signal && record.signal !== input.signal)
      return 'signal_mismatch';
    if (
      (record.signal === 'explicit' || record.signal === 'correction') &&
      record.role !== 'user'
    )
      return 'role_not_direct_owner';
    const run = db
      .prepare(
        `SELECT r.threadId, r.source, r.status, r.firstOrdinal, r.lastOrdinal, tb.dotId
         FROM conversation_runs r JOIN thread_bindings tb ON tb.id = r.threadId
         WHERE r.id = ?`,
      )
      .get(record.runId) as
      | {
          threadId: string;
          source: string;
          status: string;
          firstOrdinal: number | null;
          lastOrdinal: number | null;
          dotId: string;
        }
      | undefined;
    if (!run) return 'run_not_found';
    if (run.threadId !== record.threadId) return 'thread_mismatch';
    if (run.dotId !== input.dotId) return 'dot_mismatch';
    if (run.source !== 'web_owner' || run.status !== 'completed')
      return 'run_not_eligible';
    if (run.firstOrdinal === null || run.lastOrdinal === null)
      return 'run_unbounded';
    if (record.ordinal < run.firstOrdinal || record.ordinal > run.lastOrdinal)
      return 'ordinal_outside_run';
    const message = db
      .prepare(
        'SELECT threadId, ordinal, role, content FROM messages WHERE id = ?',
      )
      .get(record.messageId) as
      | { threadId: string; ordinal: number; role: string; content: string }
      | undefined;
    if (!message) return 'message_not_found';
    if (
      message.threadId !== record.threadId ||
      message.ordinal !== record.ordinal ||
      message.role !== record.role
    )
      return 'message_mismatch';
    if (sha256Hex(message.content) !== record.sha256) return 'digest_mismatch';
  }
  return null;
}

/** Bytes of learning text and evidence already retained across the workspace. */
export function learningStorageBytes(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT
        COALESCE((SELECT SUM(length(CAST(payload AS BLOB)) + length(CAST(evidence AS BLOB))
          + length(CAST(safetyFindings AS BLOB))) FROM learning_versions), 0)
        + COALESCE((SELECT SUM(length(CAST(evidence AS BLOB))) FROM learning_jobs), 0) AS bytes`,
    )
    .get() as { bytes: number };
  return Number(row.bytes);
}

/**
 * Retention from section 4.5, applied at write time. Current-day job budget
 * rows, queued or running jobs, pending or quarantined versions, the active
 * version, the newest approved predecessor, the highest version of each skill
 * (so numbers are never reused), and any version a use row references are all
 * kept. Version numbers therefore stay monotonic even after old rows are pruned.
 */
export function pruneLearning(db: DatabaseSync, now = Date.now()) {
  const today = new Date(now);
  const utcDayStart = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  db.prepare(
    `DELETE FROM learning_jobs
     WHERE state IN ('completed','no_change','failed','interrupted','cancelled')
       AND COALESCE(finishedAt, createdAt) < ?
       AND (startedAt IS NULL OR startedAt < ?)`,
  ).run(now - LEARNING_LIMITS.jobRetentionMs, utcDayStart);
  db.prepare('DELETE FROM learning_uses WHERE usedAt < ?').run(
    now - LEARNING_LIMITS.useRetentionMs,
  );
  db.prepare(
    `DELETE FROM learning_versions
     WHERE state IN ('rejected','superseded','retired')
       AND COALESCE(reviewedAt, createdAt) < ?
       AND id NOT IN (SELECT activeVersionId FROM learning_skills WHERE activeVersionId IS NOT NULL)
       AND id NOT IN (SELECT versionId FROM learning_uses)
       AND id NOT IN (
         SELECT newest.id FROM learning_versions AS newest
         WHERE newest.version = (SELECT MAX(same.version) FROM learning_versions AS same
           WHERE same.skillId = newest.skillId))
       AND id NOT IN (
         SELECT rollback.id FROM learning_versions AS rollback
         WHERE rollback.state = 'superseded'
           AND rollback.version = (SELECT MAX(other.version) FROM learning_versions AS other
             WHERE other.skillId = rollback.skillId AND other.state = 'superseded'))`,
  ).run(now - LEARNING_LIMITS.versionRetentionMs);
}

export interface LearningSkill {
  id: string;
  ownerId: string;
  dotId: string;
  slug: string;
  activeVersionId: string | null;
  revision: number;
  useCount: number;
  lastUsedAt: number | null;
  blockedUntil: number | null;
  createdAt: number;
}
export interface LearningVersion {
  id: string;
  skillId: string;
  version: number;
  baseVersionId: string | null;
  state: LearningVersionState;
  payload: LearningPayload;
  contentHash: string;
  evidence: LearningEvidenceRecord[];
  createdBy: 'extractor' | 'owner';
  jobId: string | null;
  extractorModel: string | null;
  extractorPromptVersion: string;
  safetyFindings: SafetyFinding[];
  createdAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}
type LearningVersionRow = Omit<
  LearningVersion,
  'payload' | 'evidence' | 'safetyFindings'
> & { payload: string; evidence: string; safetyFindings: string };
function toLearningVersion(row: LearningVersionRow): LearningVersion {
  return {
    ...row,
    payload: JSON.parse(row.payload) as LearningPayload,
    evidence: JSON.parse(row.evidence) as LearningEvidenceRecord[],
    safetyFindings: JSON.parse(row.safetyFindings) as SafetyFinding[],
  };
}

export interface ProposeLearningVersionInput {
  dotId: string;
  slug: string;
  payload: unknown;
  evidence: unknown[];
  safetyFindings?: unknown[];
  state: 'pending' | 'quarantined';
  createdBy: 'extractor' | 'owner';
  jobId?: string | null;
  baseVersionId?: string | null;
  extractorModel?: string | null;
  extractorPromptVersion: string;
}

export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  readonly connections: ConnectionStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      // Defaults are off: existing threads never gain collection consent.
      ['dots', 'learningEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'learningRevision', 'INTEGER NOT NULL DEFAULT 0'],
      [
        'thread_bindings',
        'localLearningEnrolled',
        'INTEGER NOT NULL DEFAULT 0',
      ],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    applyLearningSchema(this.db);
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.connections = new ConnectionStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
        learningEnabled: !!row.learningEnabled,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
    learningEnabled = false,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      learningContainerId,
      skillDeliveryEnabled,
      learningEnabled,
      learningRevision: 0,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled, learningEnabled, learningRevision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
          +learningEnabled,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
      learningEnabled?: boolean;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    const learningEnabled =
      patch.learningEnabled ?? current.learningEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    // Any collection, delivery, or permission change revokes what an in-flight
    // run may still use, so it bumps the revision that run is checked against.
    const sameSpaces =
      [...spaceIds].sort().join('\n') ===
      [...current.spaceIds].sort().join('\n');
    const revoking =
      learningEnabled !== (current.learningEnabled ?? false) ||
      skillDeliveryEnabled !== (current.skillDeliveryEnabled ?? false) ||
      patch.memoryAllowed !== current.memoryAllowed ||
      patch.researchAllowed !== current.researchAllowed ||
      defaultSpace !== current.spaceId ||
      !sameSpaces;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=?, learningEnabled=?, learningRevision=learningRevision+? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          +learningEnabled,
          revoking ? 1 : 0,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
      )
      .all(this.ownerId)
      .map((row) => ({
        ...row,
        localLearningEnrolled: !!row.localLearningEnrolled,
      })) as unknown as Conversation[];
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    // Copied once, at creation. Later Dot changes never enroll existing threads.
    const enrolled = dot.learningEnabled === true;
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
      localLearningEnrolled: enrolled,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, localLearningEnrolled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
        +enrolled,
      );
    return value;
  }
  /**
   * Stores a new pending or quarantined version. Writes are refused, never
   * overwritten, when a cap from section 4.5 would be exceeded. Evidence is
   * verified against canonical history in this same transaction.
   */
  proposeLearningVersion(input: ProposeLearningVersionInput): LearningVersion {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = this.insertLearningVersion(input);
      this.db.exec('COMMIT');
      return version;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  learningSkills(dotId: string): LearningSkill[] {
    return this.db
      .prepare(
        'SELECT * FROM learning_skills WHERE ownerId=? AND dotId=? ORDER BY slug',
      )
      .all(this.ownerId, dotId) as unknown as LearningSkill[];
  }
  learningVersions(skillId: string): LearningVersion[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM learning_versions WHERE skillId=? ORDER BY version',
        )
        .all(skillId) as unknown as LearningVersionRow[]
    ).map(toLearningVersion);
  }
  learningVersion(id: string): LearningVersion | undefined {
    const row = this.db
      .prepare('SELECT * FROM learning_versions WHERE id=?')
      .get(id) as unknown as LearningVersionRow | undefined;
    return row ? toLearningVersion(row) : undefined;
  }
  private insertLearningVersion(
    input: ProposeLearningVersionInput,
  ): LearningVersion {
    const dot = this.dot(input.dotId);
    if (!dot) throw new Error('Dot not found.');
    if (input.state !== 'pending' && input.state !== 'quarantined')
      throw new Error('New learning versions start pending or quarantined.');
    const payloadParsed = learningPayloadSchema.safeParse(input.payload);
    const slug = learningSlugSchema.safeParse(input.slug);
    if (
      !payloadParsed.success ||
      !slug.success ||
      payloadParsed.data.name !== slug.data
    )
      throw new Error('Learning payload does not match its reviewed schema.');
    const payload = canonicalJson(payloadParsed.data);
    if (byteLength(payload) > LEARNING_LIMITS.payloadBytes)
      throw new Error('Learning payload exceeds its size limit.');
    const evidenceParsed = z
      .array(learningEvidenceRecordSchema)
      .max(LEARNING_LIMITS.evidenceRecords)
      .safeParse(input.evidence);
    if (!evidenceParsed.success)
      throw new Error('Learning evidence does not match its schema.');
    if (input.createdBy === 'extractor' && evidenceParsed.data.length === 0)
      throw new Error('Extracted learning must cite canonical evidence.');
    const evidence = canonicalJson(evidenceParsed.data);
    if (byteLength(evidence) > LEARNING_LIMITS.evidenceBytes)
      throw new Error('Learning evidence exceeds its size limit.');
    const failure = canonicalEvidenceFailure(this.db, {
      dotId: input.dotId,
      evidence: evidenceParsed.data,
    });
    if (failure)
      throw new Error(`Learning evidence was not verified (${failure}).`);
    const safetyParsed = z
      .array(safetyFindingSchema)
      .max(LEARNING_LIMITS.safetyFindings)
      .safeParse(input.safetyFindings ?? []);
    if (!safetyParsed.success)
      throw new Error('Learning safety findings do not match their schema.');
    const safety = canonicalJson(safetyParsed.data);
    if (byteLength(safety) > LEARNING_LIMITS.safetyBytes)
      throw new Error('Learning safety findings exceed their size limit.');
    if (input.createdBy === 'owner' && input.jobId)
      throw new Error('Owner-authored learning has no extraction job.');
    if (input.createdBy === 'extractor') {
      const job = input.jobId
        ? (this.db
            .prepare('SELECT dotId FROM learning_jobs WHERE id=? AND ownerId=?')
            .get(input.jobId, this.ownerId) as { dotId: string } | undefined)
        : undefined;
      if (!job || job.dotId !== input.dotId)
        throw new Error('Extracted learning must name its own Dot job.');
    }

    pruneLearning(this.db);
    let skill = this.db
      .prepare(
        'SELECT * FROM learning_skills WHERE ownerId=? AND dotId=? AND slug=?',
      )
      .get(this.ownerId, input.dotId, slug.data) as unknown as
      LearningSkill | undefined;
    if (!skill) {
      this.assertCapacity(
        'SELECT COUNT(*) AS n FROM learning_skills',
        LEARNING_LIMITS.skillIdentities,
        'Learning skill capacity is full; retire or export existing skills first.',
      );
      skill = {
        id: randomUUID(),
        ownerId: this.ownerId,
        dotId: input.dotId,
        slug: slug.data,
        activeVersionId: null,
        revision: 0,
        useCount: 0,
        lastUsedAt: null,
        blockedUntil: null,
        createdAt: Date.now(),
      };
      this.db
        .prepare(
          'INSERT INTO learning_skills (id, ownerId, dotId, slug, activeVersionId, revision, useCount, lastUsedAt, blockedUntil, createdAt) VALUES (?, ?, ?, ?, NULL, 0, 0, NULL, NULL, ?)',
        )
        .run(skill.id, skill.ownerId, skill.dotId, skill.slug, skill.createdAt);
    }
    if (input.baseVersionId) {
      const base = this.db
        .prepare('SELECT skillId FROM learning_versions WHERE id=?')
        .get(input.baseVersionId) as { skillId: string } | undefined;
      if (!base || base.skillId !== skill.id)
        throw new Error('Learning base version belongs to another skill.');
    }
    this.assertCapacity(
      'SELECT COUNT(*) AS n FROM learning_versions',
      LEARNING_LIMITS.versionRows,
      'Learning version capacity is full; retire or export versions first.',
    );
    this.assertCapacity(
      "SELECT COUNT(*) AS n FROM learning_versions WHERE state IN ('pending','quarantined')",
      LEARNING_LIMITS.pendingVersions,
      'Too many learning proposals await review workspace-wide.',
    );
    const perDot = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM learning_versions v JOIN learning_skills s ON s.id = v.skillId WHERE s.dotId=? AND v.state IN ('pending','quarantined')",
      )
      .get(input.dotId) as { n: number };
    if (Number(perDot.n) >= LEARNING_LIMITS.pendingVersionsPerDot)
      throw new Error('This Dot already has proposals awaiting review.');
    const perSkill = this.db
      .prepare('SELECT COUNT(*) AS n FROM learning_versions WHERE skillId=?')
      .get(skill.id) as { n: number };
    if (Number(perSkill.n) >= LEARNING_LIMITS.versionsPerSkill)
      throw new Error(
        'This skill has its maximum versions; retire or export one before proposing another.',
      );
    const used = learningStorageBytes(this.db);
    const added =
      byteLength(payload) + byteLength(evidence) + byteLength(safety);
    if (used + added > LEARNING_LIMITS.storageBytes)
      throw new Error(
        'Learning storage is full; retire or export old learning first.',
      );

    const highest = this.db
      .prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM learning_versions WHERE skillId=?',
      )
      .get(skill.id) as { version: number };
    const version: LearningVersion = {
      id: randomUUID(),
      skillId: skill.id,
      version: Number(highest.version) + 1,
      baseVersionId: input.baseVersionId ?? null,
      state: input.state,
      payload: payloadParsed.data,
      contentHash: sha256Hex(payload),
      evidence: evidenceParsed.data,
      createdBy: input.createdBy,
      jobId: input.jobId ?? null,
      extractorModel: input.extractorModel ?? null,
      extractorPromptVersion: input.extractorPromptVersion,
      safetyFindings: safetyParsed.data,
      createdAt: Date.now(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    };
    this.db
      .prepare(
        'INSERT INTO learning_versions (id, skillId, version, baseVersionId, state, payload, contentHash, evidence, createdBy, jobId, extractorModel, extractorPromptVersion, safetyFindings, createdAt, reviewedAt, reviewedBy, reviewNote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)',
      )
      .run(
        version.id,
        version.skillId,
        version.version,
        version.baseVersionId,
        version.state,
        payload,
        version.contentHash,
        evidence,
        version.createdBy,
        version.jobId,
        version.extractorModel,
        version.extractorPromptVersion,
        safety,
        version.createdAt,
      );
    return version;
  }
  private assertCapacity(sql: string, limit: number, message: string) {
    const row = this.db.prepare(sql).get() as { n: number };
    if (Number(row.n) >= limit) throw new Error(message);
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}
