import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationStore,
  type AdmittedRunSource,
  type ConversationMessage,
  type ConversationRun,
} from '../src/server/conversation-store.js';
import {
  WorkspaceStore,
  type LearningEvidenceRecord,
} from '../src/server/workspace.js';
import type { Dot } from '../src/shared/types.js';

// Shared fixtures for the local learning storage tests. Stores run against a
// real database file so reopen and migration behavior is exercised.

const cleanups: (() => void)[] = [];

export function cleanupLearningFixtures() {
  cleanups.splice(0).forEach((cleanup) => cleanup());
}

// Tests close stores early to simulate restarts; cleanup must tolerate that.
function closeQuietly(close: () => void) {
  try {
    close();
  } catch {
    // Already closed by the test.
  }
}

export function learningDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-learning-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'opendots.sqlite');
}

export function openLearningStores(path: string) {
  const workspace = new WorkspaceStore(path, 'owner');
  const conversations = new ConversationStore(path);
  cleanups.push(() => {
    closeQuietly(() => conversations.close());
    closeQuietly(() => workspace.close());
  });
  return { workspace, conversations };
}

/** Opens the database directly, for storage invariants the stores never expose. */
export function rawDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  cleanups.push(() => closeQuietly(() => db.close()));
  return db;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function onlyDot(workspace: WorkspaceStore): Dot {
  const [dot] = workspace.dots();
  if (!dot) throw new Error('Expected the default Dot.');
  return dot;
}

export function enableCollection(workspace: WorkspaceStore, dot: Dot): Dot {
  return workspace.updateDot(dot.id, {
    name: dot.name,
    instructions: dot.instructions,
    researchAllowed: dot.researchAllowed,
    memoryAllowed: dot.memoryAllowed,
    learningEnabled: true,
  });
}

/** A web-owner turn whose assistant reply is recorded but whose run is still open. */
export function openWebTurn(
  conversations: ConversationStore,
  params: { threadId: string; dotId: string; text: string },
  source: AdmittedRunSource = 'web_owner',
): { run: ConversationRun; message: ConversationMessage } {
  const { run, message } = conversations.admitTurn({
    threadId: params.threadId,
    dotId: params.dotId,
    ownerId: 'owner',
    role: 'user',
    content: { id: randomUUID(), role: 'user', content: params.text },
    source,
  });
  conversations.appendMessage({
    threadId: params.threadId,
    dotId: params.dotId,
    ownerId: 'owner',
    role: 'assistant',
    content: { id: randomUUID(), role: 'assistant', content: 'Noted.' },
    runId: run.id,
  });
  return { run, message };
}

/** A completed web-owner turn with no learning job, usable as canonical evidence. */
export function completedWebTurn(
  conversations: ConversationStore,
  params: { threadId: string; dotId: string; text: string },
): { run: ConversationRun; message: ConversationMessage } {
  const turn = openWebTurn(conversations, params);
  conversations.finishRun(turn.run.id, 'completed');
  return turn;
}

/** The evidence record a server would store for one canonical message. */
export function citeMessage(
  message: ConversationMessage,
  run: ConversationRun,
  signal: LearningEvidenceRecord['signal'] = 'correction',
): LearningEvidenceRecord {
  return {
    threadId: run.threadId,
    runId: run.id,
    messageId: message.id,
    ordinal: message.ordinal,
    role: message.role as LearningEvidenceRecord['role'],
    sha256: sha256(JSON.stringify(message.content)),
    signal,
  };
}

export function payloadFor(slug: string) {
  return {
    name: slug,
    description: 'Review source evidence before saving a research page.',
    triggers: ['review research evidence'],
    steps: ['Check the cited source before drawing the conclusion.'],
    pitfalls: ['Do not present an unverified source as confirmed.'],
    verification: 'Check that each substantive claim has source evidence.',
    requiredTools: ['read_space_page'],
    notFor: ['Authorizing connected-service writes'],
  };
}

/**
 * Recreates a pre-learning database: the columns this feature added are
 * dropped, so the next open must migrate them in with their off defaults.
 */
export function dropLearningColumns(path: string) {
  const db = rawDatabase(path);
  for (const [table, column] of [
    ['dots', 'learningEnabled'],
    ['dots', 'learningRevision'],
    ['thread_bindings', 'localLearningEnrolled'],
    ['conversation_runs', 'source'],
    ['conversation_runs', 'firstOrdinal'],
    ['conversation_runs', 'lastOrdinal'],
  ])
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
