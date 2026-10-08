import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export interface ConversationMessage {
  id: string;
  threadId: string;
  dotId: string;
  ownerId: string;
  ordinal: number;
  role: MessageRole;
  content: unknown;
  toolCallId: string | null;
  toolResult: unknown;
  metadata: unknown;
  createdAt: number;
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export interface ConversationRun {
  id: string;
  threadId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}
export interface AgUiEvent {
  id: number;
  threadId: string;
  runId: string;
  seq: number;
  payload: unknown;
  createdAt: number;
}
export interface ConnectorInbound {
  id: number;
  platform: string;
  updateId: string;
  offset: number;
  createdAt: number;
}
export type OutboundStatus = 'pending' | 'attempting' | 'delivered' | 'failed';
export interface ConnectorOutbound {
  id: string;
  threadId: string;
  runId: string | null;
  status: OutboundStatus;
  retryCount: number;
  payload: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' &&
    /UNIQUE constraint failed/.test(error.message)
  );
}

type MessageRow = Omit<ConversationMessage, 'content' | 'toolResult' | 'metadata'> & {
  content: string;
  toolResult: string | null;
  metadata: string | null;
};
type EventRow = Omit<AgUiEvent, 'payload'> & { payload: string };
type OutboundRow = Omit<ConnectorOutbound, 'payload'> & { payload: string };

function toMessage(row: MessageRow): ConversationMessage {
  return {
    ...row,
    content: JSON.parse(row.content),
    toolResult: row.toolResult ? JSON.parse(row.toolResult) : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}
function toEvent(row: EventRow): AgUiEvent {
  return { ...row, payload: JSON.parse(row.payload) };
}
function toOutbound(row: OutboundRow): ConnectorOutbound {
  return { ...row, payload: JSON.parse(row.payload) };
}

// Sibling to Store (store.ts) and WorkspaceStore (workspace.ts): same WAL +
// BEGIN IMMEDIATE/COMMIT transaction pattern, kept independent so this
// transcript schema has no dependency on either.
export class ConversationStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, toolCallId TEXT, toolResult TEXT, createdAt INTEGER NOT NULL, UNIQUE(threadId, ordinal));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS ag_ui_events(id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(runId, seq));
      CREATE TABLE IF NOT EXISTS connector_inbound(id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, updateId TEXT NOT NULL, offset INTEGER NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(platform, updateId));
      CREATE TABLE IF NOT EXISTS connector_outbound(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, runId TEXT, status TEXT NOT NULL, payload TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(threadId, ordinal);
      CREATE INDEX IF NOT EXISTS runs_thread ON runs(threadId, startedAt);
      CREATE INDEX IF NOT EXISTS ag_ui_events_run ON ag_ui_events(runId, seq);
      CREATE INDEX IF NOT EXISTS connector_inbound_offset ON connector_inbound(platform, offset);
      CREATE INDEX IF NOT EXISTS connector_outbound_status ON connector_outbound(threadId, status);`);
    // Additive forward compatibility: new columns arrive via ALTER TABLE ADD
    // COLUMN, never a destructive rewrite, mirroring workspace.ts's pattern.
    for (const [table, column, definition] of [
      ['messages', 'metadata', 'TEXT'],
      ['connector_outbound', 'retryCount', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private insertMessage(params: {
    threadId: string;
    dotId: string;
    ownerId: string;
    role: MessageRole;
    content: unknown;
    toolCallId?: string | null;
    toolResult?: unknown;
    metadata?: unknown;
  }): ConversationMessage {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM messages WHERE threadId=?')
      .get(params.threadId) as { ordinal: number };
    const message: ConversationMessage = {
      id: randomUUID(),
      threadId: params.threadId,
      dotId: params.dotId,
      ownerId: params.ownerId,
      ordinal: next.ordinal,
      role: params.role,
      content: params.content,
      toolCallId: params.toolCallId ?? null,
      toolResult: params.toolResult ?? null,
      metadata: params.metadata ?? null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO messages (id, threadId, dotId, ownerId, ordinal, role, content, toolCallId, toolResult, createdAt, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        message.id,
        message.threadId,
        message.dotId,
        message.ownerId,
        message.ordinal,
        message.role,
        JSON.stringify(message.content),
        message.toolCallId,
        message.toolResult === null ? null : JSON.stringify(message.toolResult),
        message.createdAt,
        message.metadata === null ? null : JSON.stringify(message.metadata),
      );
    return message;
  }
  private insertRun(threadId: string): ConversationRun {
    const run: ConversationRun = {
      id: randomUUID(),
      threadId,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this.db
      .prepare("INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL)")
      .run(run.id, run.threadId, run.startedAt);
    return run;
  }
  private insertEvent(threadId: string, runId: string, payload: unknown): AgUiEvent {
    const next = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM ag_ui_events WHERE runId=?')
      .get(runId) as { seq: number };
    const createdAt = Date.now();
    const result = this.db
      .prepare('INSERT INTO ag_ui_events (threadId, runId, seq, payload, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(threadId, runId, next.seq, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      threadId,
      runId,
      seq: next.seq,
      payload,
      createdAt,
    };
  }
  // Admits one turn: the inbound message, its run, and the run-started event
  // all commit together, so no partially-committed turn is ever observable.
  admitTurn(params: {
    threadId: string;
    dotId: string;
    ownerId: string;
    role: MessageRole;
    content: unknown;
    toolCallId?: string | null;
    toolResult?: unknown;
    metadata?: unknown;
  }): { message: ConversationMessage; run: ConversationRun } {
    return this.transaction(() => {
      const message = this.insertMessage(params);
      const run = this.insertRun(params.threadId);
      this.insertEvent(run.threadId, run.id, {
        type: 'RUN_STARTED',
        messageId: message.id,
      });
      return { message, run };
    });
  }
  appendMessage(params: {
    threadId: string;
    dotId: string;
    ownerId: string;
    role: MessageRole;
    content: unknown;
    toolCallId?: string | null;
    toolResult?: unknown;
    metadata?: unknown;
  }): ConversationMessage {
    return this.transaction(() => this.insertMessage(params));
  }
  messages(threadId: string): ConversationMessage[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE threadId=? ORDER BY ordinal')
        .all(threadId) as unknown as MessageRow[]
    ).map(toMessage);
  }
  run(id: string): ConversationRun | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as
      | ConversationRun
      | undefined;
  }
  runs(threadId: string): ConversationRun[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE threadId=? ORDER BY startedAt')
      .all(threadId) as unknown as ConversationRun[];
  }
  finishRun(id: string, status: RunStatus, error: string | null = null): ConversationRun {
    return this.transaction(() => {
      const now = Date.now();
      this.db
        .prepare('UPDATE runs SET status=?, finishedAt=?, error=? WHERE id=?')
        .run(status, now, error, id);
      const run = this.run(id);
      if (!run) throw new Error('Run not found.');
      this.insertEvent(run.threadId, run.id, {
        type: status === 'completed' ? 'RUN_FINISHED' : 'RUN_ERROR',
        error,
      });
      return run;
    });
  }
  recordEvent(threadId: string, runId: string, payload: unknown): AgUiEvent {
    return this.transaction(() => this.insertEvent(threadId, runId, payload));
  }
  events(runId: string): AgUiEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM ag_ui_events WHERE runId=? ORDER BY seq')
        .all(runId) as unknown as EventRow[]
    ).map(toEvent);
  }
  // Durable dedup for redelivered platform updates: the (platform, updateId)
  // uniqueness constraint rejects the duplicate, not an application-level check.
  admitInbound(platform: string, updateId: string, offset: number): boolean {
    try {
      this.db
        .prepare('INSERT INTO connector_inbound (platform, updateId, offset, createdAt) VALUES (?, ?, ?, ?)')
        .run(platform, updateId, offset, Date.now());
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
  highWaterOffset(platform: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(offset) AS offset FROM connector_inbound WHERE platform=?')
      .get(platform) as { offset: number | null };
    return row.offset;
  }
  queueOutbound(threadId: string, runId: string | null, payload: unknown): ConnectorOutbound {
    const now = Date.now();
    const outbound: ConnectorOutbound = {
      id: randomUUID(),
      threadId,
      runId,
      status: 'pending',
      retryCount: 0,
      payload,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO connector_outbound (id, threadId, runId, status, payload, error, createdAt, updatedAt, retryCount) VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, 0)",
      )
      .run(outbound.id, threadId, runId, JSON.stringify(payload), now, now);
    return outbound;
  }
  outbound(id: string): ConnectorOutbound | undefined {
    const row = this.db.prepare('SELECT * FROM connector_outbound WHERE id=?').get(id) as
      | OutboundRow
      | undefined;
    return row ? toOutbound(row) : undefined;
  }
  pendingOutbound(threadId?: string): ConnectorOutbound[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM connector_outbound WHERE status IN ('pending', 'attempting') ${threadId ? 'AND threadId=?' : ''} ORDER BY createdAt`,
        )
        .all(...(threadId ? [threadId] : [])) as unknown as OutboundRow[]
    ).map(toOutbound);
  }
  markOutbound(id: string, status: OutboundStatus, error: string | null = null): ConnectorOutbound {
    return this.transaction(() => {
      const current = this.outbound(id);
      if (!current) throw new Error('Outbound delivery not found.');
      const retryCount = status === 'failed' ? current.retryCount + 1 : current.retryCount;
      this.db
        .prepare('UPDATE connector_outbound SET status=?, error=?, retryCount=?, updatedAt=? WHERE id=?')
        .run(status, error, retryCount, Date.now(), id);
      return this.outbound(id)!;
    });
  }
}
