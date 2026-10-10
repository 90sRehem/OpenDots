import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { api, ApiError } from './api';
import { payloadDiff, type FieldDiff } from './learning-diff';
import {
  learningPayloadSchema,
  type LearningPayload,
  type LearningReviewToken,
  type LearningVersionView,
} from '../shared/learning';
import type { Dot } from '../shared/types';

// The owner's review screen for one Dot's local lessons. Nothing here is live by
// default: every lesson shows its state, and only the active version can reach a
// conversation, and only while delivery is on.

interface LearningUsage {
  activeSkills: number;
  activeSkillsLimit: number;
  workspaceActiveSkills: number;
  workspaceActiveSkillsLimit: number;
  pendingVersions: number;
  pendingVersionsLimit: number;
  workspacePendingVersions: number;
  workspacePendingVersionsLimit: number;
}
interface LearningSkillView {
  id: string;
  slug: string;
  activeVersionId: string | null;
  revision: number;
  versions: LearningVersionView[];
}
interface LearningList {
  extraction: { available: boolean; reason: string };
  usage: LearningUsage;
  skills: LearningSkillView[];
}
interface LearningDetail {
  version: LearningVersionView;
  replaces: LearningVersionView | null;
  skill: {
    id: string;
    slug: string;
    activeVersionId: string | null;
    revision: number;
  };
  review: LearningReviewToken;
}
interface Row {
  version: LearningVersionView;
  active: boolean;
}
interface DraftFields {
  name: string;
  description: string;
  triggers: string;
  steps: string;
  pitfalls: string;
  verification: string;
  requiredTools: string;
  notFor: string;
}
type Mode = 'view' | 'edit' | 'new';

const GROUPS: { key: string; title: string; match: (row: Row) => boolean }[] = [
  {
    key: 'waiting',
    title: 'Waiting for review',
    match: (row) =>
      !row.active &&
      (row.version.state === 'pending' || row.version.state === 'quarantined'),
  },
  { key: 'active', title: 'Active', match: (row) => row.active },
  {
    key: 'retired',
    title: 'Retired',
    match: (row) => !row.active && row.version.state === 'retired',
  },
  {
    key: 'rejected',
    title: 'Rejected',
    match: (row) => !row.active && row.version.state === 'rejected',
  },
  {
    key: 'replaced',
    title: 'Replaced',
    match: (row) => !row.active && row.version.state === 'superseded',
  },
];

const FORM_ERROR =
  'Check the lesson. Each list needs at least one entry where required, and every field must stay within its length and count limit.';

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not save.';

/** Refusals that a reload of the exact version can resolve; other conflicts cannot. */
const STALE_REVIEW_CODES = new Set([
  'stale_content',
  'stale_evidence',
  'stale_base',
  'stale_active',
]);

const stateText = (row: Row) => {
  if (row.active) return 'Active';
  return (
    {
      pending: 'Waiting for review',
      quarantined: 'Quarantined',
      approved: 'Approved',
      retired: 'Retired',
      rejected: 'Rejected',
      superseded: 'Replaced',
    } as const
  )[row.version.state];
};

const draftFrom = (payload?: LearningPayload): DraftFields => ({
  name: payload?.name ?? '',
  description: payload?.description ?? '',
  triggers: payload?.triggers.join('\n') ?? '',
  steps: payload?.steps.join('\n') ?? '',
  pitfalls: payload?.pitfalls.join('\n') ?? '',
  verification: payload?.verification ?? '',
  requiredTools: payload?.requiredTools.join('\n') ?? '',
  notFor: payload?.notFor.join('\n') ?? '',
});

const linesOf = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function payloadFrom(draft: DraftFields): LearningPayload {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    triggers: linesOf(draft.triggers),
    steps: linesOf(draft.steps),
    pitfalls: linesOf(draft.pitfalls),
    verification: draft.verification.trim(),
    requiredTools: linesOf(draft.requiredTools),
    notFor: linesOf(draft.notFor),
  };
}

function Diff({ diff }: { diff: FieldDiff }) {
  return (
    <>
      <dt>{diff.label}</dt>
      <dd className={diff.changed ? undefined : 'muted'}>
        {diff.changed ? (
          diff.segments.map((segment, index) =>
            segment.kind === 'same' ? (
              <span key={index}>{segment.text}</span>
            ) : segment.kind === 'added' ? (
              <ins key={index}>
                <span className="sr-only">Added: </span>
                {segment.text}
              </ins>
            ) : (
              <del key={index}>
                <span className="sr-only">Removed: </span>
                {segment.text}
              </del>
            ),
          )
        ) : (
          <span>No change.</span>
        )}
      </dd>
    </>
  );
}

export function LearningReview({
  dot,
  memoryAllowed,
  onBack,
}: {
  dot: Dot;
  memoryAllowed: boolean;
  onBack: () => void;
}) {
  const [list, setList] = useState<LearningList | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LearningDetail | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [confirm, setConfirm] = useState<'reject' | 'retire' | null>(null);
  const [draft, setDraft] = useState<DraftFields>(draftFrom());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Delivery reaches a conversation only when every permission is on.
  const delivering =
    dot.skillDeliveryEnabled === true && dot.memoryAllowed && memoryAllowed;
  const liveText = delivering
    ? 'Conversations for this Dot can use it now.'
    : 'It is active, but delivery is off, so no conversation uses it yet.';

  const loadList = useCallback(async () => {
    try {
      setList(await api<LearningList>(`/dots/${dot.id}/learning`));
      setLoadError('');
    } catch (error) {
      setLoadError(messageOf(error));
    }
  }, [dot.id]);

  const openVersion = useCallback(
    async (versionId: string) => {
      try {
        const next = await api<LearningDetail>(
          `/dots/${dot.id}/learning/versions/${versionId}`,
        );
        setSelectedId(versionId);
        setDetail(next);
        setMode('view');
        setConfirm(null);
        // A message describes the lesson it was said about; it does not carry over.
        setMessage('');
      } catch (error) {
        setMessage(messageOf(error));
      }
    },
    [dot.id],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Opening the screen replaces the button that opened it, so move focus here.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const rows: Row[] = (list?.skills ?? []).flatMap((skill) =>
    skill.versions.map((version) => ({
      version,
      active: skill.activeVersionId === version.id,
    })),
  );

  /** Runs one owner action; a stale review reloads the exact version before it is decided again. */
  async function act(
    versionId: string | null,
    path: string,
    body: unknown,
    done: string,
  ) {
    setBusy(true);
    setMessage('');
    try {
      const saved = await api<LearningVersionView>(path, 'POST', body);
      await loadList();
      await openVersion(saved.id);
      setMessage(done);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadList();
        if (versionId) await openVersion(versionId);
        setMessage(
          STALE_REVIEW_CODES.has(error.code ?? '')
            ? `${messageOf(error)} The lesson has been reloaded; review the current version before deciding.`
            : messageOf(error),
        );
      } else setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  function review(
    action: 'approve' | 'reject' | 'retire' | 'restore',
    done: string,
  ) {
    if (!detail) return;
    const id = detail.version.id;
    void act(
      id,
      `/dots/${dot.id}/learning/versions/${id}/${action}`,
      { review: detail.review },
      done,
    );
  }

  function startNew() {
    setSelectedId(null);
    setDetail(null);
    setDraft(draftFrom());
    setConfirm(null);
    setMode('new');
    setMessage('');
  }

  function startEdit() {
    if (!detail) return;
    setDraft(draftFrom(detail.version.payload));
    setConfirm(null);
    setMode('edit');
    setMessage('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const payload = payloadFrom(draft);
    if (!learningPayloadSchema.safeParse(payload).success) {
      setMessage(FORM_ERROR);
      return;
    }
    if (mode === 'new')
      void act(
        null,
        `/dots/${dot.id}/learning/proposals`,
        { payload },
        'Saved as a proposal. It is waiting for your review and is not active.',
      );
    else if (detail)
      void act(
        detail.version.id,
        `/dots/${dot.id}/learning/versions/${detail.version.id}/edit`,
        { review: detail.review, payload },
        'Saved as a new proposal waiting for your review. The active version is unchanged.',
      );
  }

  const usage = list?.usage;
  const pendingFull =
    !!usage && usage.pendingVersions >= usage.pendingVersionsLimit;
  const activeFull = !!usage && usage.activeSkills >= usage.activeSkillsLimit;
  const workspaceActiveFull =
    !!usage && usage.workspaceActiveSkills >= usage.workspaceActiveSkillsLimit;

  function renderDetail() {
    if (mode !== 'view' || !detail) return null;
    const { version, replaces } = detail;
    const state = version.state;
    const active = detail.skill.activeVersionId === version.id;
    // Only a proposal waiting for review can replace the active version.
    const waiting = state === 'pending' || state === 'quarantined';
    const diffs =
      waiting && !active && replaces
        ? payloadDiff(replaces.payload, version.payload)
        : null;
    const pendingNoReplace = waiting && !replaces;
    return (
      <>
        <h4 tabIndex={-1} id="learning-detail-title">
          {version.payload.name}
          <span className="muted"> · version {version.version}</span>
        </h4>
        <p className="learning-state" role="note">
          {active
            ? `Active. ${liveText}`
            : state === 'pending'
              ? 'Waiting for review. It is not active and reaches no conversation until you approve it.'
              : state === 'quarantined'
                ? 'Quarantined. It was held for inspection and cannot be approved. Edit it into a new proposal, or reject it.'
                : state === 'retired'
                  ? 'Retired. It is not live and no conversation uses it. Restore it after review to make it active again.'
                  : state === 'rejected'
                    ? 'Rejected. It is not live. Its name is held back from automatic suggestions for 30 days.'
                    : 'Replaced by a newer approved version. It is not live.'}
        </p>

        <h5>Exact text</h5>
        <dl className="learning-exact">
          <dt>Description</dt>
          <dd>{version.payload.description}</dd>
          <dt>When it applies</dt>
          <dd>
            <ul>
              {version.payload.triggers.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
          <dt>Steps</dt>
          <dd>
            <ol>
              {version.payload.steps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </dd>
          <dt>Pitfalls</dt>
          <dd>
            {version.payload.pitfalls.length ? (
              <ul>
                {version.payload.pitfalls.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <span className="muted">None.</span>
            )}
          </dd>
          <dt>Verification</dt>
          <dd>{version.payload.verification}</dd>
        </dl>

        <h5>Permissions</h5>
        <p className="muted">
          A lesson never grants a tool. Required tools only decide whether it
          applies, and tool access is still checked on every turn.
        </p>
        <dl className="learning-exact">
          <dt>Tools it names</dt>
          <dd>
            {version.payload.requiredTools.length ? (
              version.payload.requiredTools.join(', ')
            ) : (
              <span className="muted">None.</span>
            )}
          </dd>
          <dt>Not for</dt>
          <dd>
            {version.payload.notFor.length ? (
              <ul>
                {version.payload.notFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <span className="muted">Nothing excluded.</span>
            )}
          </dd>
        </dl>

        <h5>Evidence</h5>
        {version.evidence.length ? (
          <ul>
            {version.evidence.map((record) => (
              <li key={`${record.runId}-${record.messageId}`}>
                {record.role} message {record.ordinal}, {record.signal} signal,
                digest {record.sha256.slice(0, 12)}…
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {version.createdBy === 'owner'
              ? 'Written by you. It cites no conversation messages.'
              : 'No conversation messages are cited.'}
          </p>
        )}

        <h5>Safety</h5>
        <p className="muted">
          {version.createdBy === 'owner'
            ? 'Written by you, so no automatic safety check ran on it. Review it as you would any instruction.'
            : version.safetyFindings.length
              ? version.safetyFindings
                  .map((finding) => `${finding.code}: ${finding.explanation}`)
                  .join(' ')
              : 'The safety check recorded no findings.'}
        </p>

        <h5>Changes</h5>
        {diffs ? (
          <dl className="learning-diff">
            {diffs.map((diff) => (
              <Diff key={diff.key} diff={diff} />
            ))}
          </dl>
        ) : pendingNoReplace ? (
          <p className="muted">
            Nothing is active under this name, so approving makes it the first
            active version.
          </p>
        ) : (
          <p className="muted">No replacement to compare.</p>
        )}

        <p className="muted learning-provenance">
          Created {new Date(version.createdAt).toLocaleString()} by{' '}
          {version.createdBy === 'owner' ? 'you' : 'the local extractor'}.
          Content fingerprint {version.contentHash.slice(0, 12)}….
        </p>

        <div className="learning-actions">
          {state === 'pending' && (
            <button
              className="primary"
              // Replacing the active version adds no active lesson, so only a
              // first activation is subject to the active caps.
              disabled={
                busy || (!replaces && (activeFull || workspaceActiveFull))
              }
              onClick={() =>
                review(
                  'approve',
                  `Approved. ${replaces ? 'The previous active version is replaced. ' : ''}${liveText}`,
                )
              }
            >
              {replaces
                ? 'Approve and replace active version'
                : 'Approve and activate'}
            </button>
          )}
          {state === 'retired' && detail.skill.activeVersionId === null && (
            <button
              className="primary"
              disabled={busy || workspaceActiveFull || activeFull}
              onClick={() =>
                review('restore', `Restored and active. ${liveText}`)
              }
            >
              Restore after review
            </button>
          )}
          {state === 'retired' && detail.skill.activeVersionId !== null && (
            // The store refuses a restore while another version is active, so the
            // screen says why instead of offering a button that always fails.
            <p className="muted">
              Another version of this lesson is active. Retire it before
              restoring this one.
            </p>
          )}
          {active && (
            <button disabled={busy} onClick={() => setConfirm('retire')}>
              Retire…
            </button>
          )}
          {(state === 'pending' || state === 'quarantined') && (
            <button disabled={busy} onClick={() => setConfirm('reject')}>
              Reject…
            </button>
          )}
          {state !== 'superseded' && (
            <button disabled={busy} onClick={startEdit}>
              Edit as new proposal
            </button>
          )}
        </div>
        {confirm && (
          <div className="learning-confirm" role="group" aria-label="Confirm">
            <p>
              {confirm === 'retire'
                ? 'Retiring removes this lesson from every conversation at once. Its history is kept, and you can restore it after review.'
                : 'Rejecting leaves the active library unchanged and holds this name back from automatic suggestions for 30 days.'}
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                confirm === 'retire'
                  ? review(
                      'retire',
                      'Retired. It is no longer used in any conversation.',
                    )
                  : review(
                      'reject',
                      'Rejected. The active library is unchanged.',
                    )
              }
            >
              {confirm === 'retire' ? 'Confirm retire' : 'Confirm reject'}
            </button>
            <button disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        )}
      </>
    );
  }

  function renderForm() {
    const isNew = mode === 'new';
    const field = (
      id: keyof DraftFields,
      label: string,
      multiline: boolean,
      hint?: string,
    ) => (
      <>
        <label className="field-label" htmlFor={`learning-${id}`}>
          {label}
        </label>
        {multiline ? (
          <textarea
            id={`learning-${id}`}
            rows={3}
            value={draft[id]}
            aria-describedby={hint ? `learning-${id}-hint` : undefined}
            onChange={(event) =>
              setDraft({ ...draft, [id]: event.target.value })
            }
          />
        ) : (
          <input
            id={`learning-${id}`}
            value={draft[id]}
            readOnly={!isNew && id === 'name'}
            aria-describedby={hint ? `learning-${id}-hint` : undefined}
            onChange={(event) =>
              setDraft({ ...draft, [id]: event.target.value })
            }
          />
        )}
        {hint && (
          <p className="muted" id={`learning-${id}-hint`}>
            {hint}
          </p>
        )}
      </>
    );
    return (
      <form className="learning-form" onSubmit={submit}>
        <h4 tabIndex={-1}>
          {isNew ? 'Write a lesson' : 'Edit as a new proposal'}
        </h4>
        <p className="muted">
          {isNew
            ? 'You write this lesson yourself. Nothing is active until you approve it.'
            : 'Saving creates a new proposal that you must approve. The current text stays as it is until then.'}
        </p>
        {field(
          'name',
          'Lesson name',
          false,
          isNew
            ? 'Lowercase letters, numbers, and single hyphens. A name that already exists adds a new version to that lesson.'
            : 'The name stays the same for an edit.',
        )}
        {field('description', 'Description', true)}
        {field('triggers', 'When it applies', true, 'One per line, 1 to 5.')}
        {field('steps', 'Steps', true, 'One per line, 1 to 8.')}
        {field(
          'pitfalls',
          'Pitfalls',
          true,
          'One per line, up to 5, optional.',
        )}
        {field('verification', 'Verification', true)}
        {field(
          'requiredTools',
          'Tools it names',
          true,
          'One per line, up to 8, optional. Naming a tool never grants it.',
        )}
        {field('notFor', 'Not for', true, 'One per line, up to 3, optional.')}
        <div className="learning-actions">
          <button className="primary" disabled={busy}>
            {isNew ? 'Save proposal' : 'Save as new proposal'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode('view');
              setMessage('');
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <section className="learning-review" aria-labelledby="learning-title">
      <button type="button" onClick={onBack}>
        ← Back to Dot settings
      </button>
      <h3 id="learning-title" ref={titleRef} tabIndex={-1}>
        Lessons for {dot.name}
      </h3>
      <p className="muted">
        Lessons you approve are stored in this OpenDots database and used only
        by this Dot. Nothing is sent to Intelligence.
      </p>
      {loadError && (
        <p role="alert" className="learning-alert">
          Could not load lessons: {loadError}
        </p>
      )}
      {list && (
        <div className="learning-summary">
          <p>
            <strong>
              {list.extraction.available
                ? 'Automatic suggestions are available.'
                : 'Automatic suggestions are unavailable.'}
            </strong>{' '}
            {list.extraction.reason}
          </p>
          <p>
            {delivering
              ? 'Approved lessons are delivered to new turns for this Dot.'
              : `Delivery is off. Approved lessons are not reaching conversations. ${
                  dot.skillDeliveryEnabled
                    ? 'Turn on Use saved memories in Settings and for this Dot.'
                    : 'Turn on Use approved lessons for this Dot.'
                }`}
          </p>
          <p>
            Active lessons: {list.usage.activeSkills} of{' '}
            {list.usage.activeSkillsLimit} for this Dot. Waiting for review:{' '}
            {list.usage.pendingVersions} of {list.usage.pendingVersionsLimit}.
          </p>
          {activeFull && (
            <p role="alert" className="learning-alert">
              Full: this Dot has its maximum active lessons. Retire one before
              approving another. Nothing is removed automatically.
            </p>
          )}
          {workspaceActiveFull && !activeFull && (
            <p role="alert" className="learning-alert">
              Full: the workspace has its maximum active lessons. Retire one
              before approving another.
            </p>
          )}
          {pendingFull && (
            <p role="alert" className="learning-alert">
              Full: this Dot has reached its limit of proposals waiting for
              review. Approve, reject, or retire one before proposing another.
            </p>
          )}
        </div>
      )}
      <div className="learning-layout">
        <div className="learning-list">
          <button className="primary" disabled={busy} onClick={startNew}>
            Write a lesson
          </button>
          {GROUPS.map((group) => {
            const groupRows = rows.filter(group.match);
            return (
              <section key={group.key} aria-labelledby={`lessons-${group.key}`}>
                <h4 id={`lessons-${group.key}`}>
                  {group.title} ({groupRows.length})
                </h4>
                {groupRows.length === 0 ? (
                  <p className="muted">None.</p>
                ) : (
                  <ul>
                    {groupRows.map((row) => (
                      <li key={row.version.id}>
                        <button
                          type="button"
                          aria-current={
                            selectedId === row.version.id ? 'true' : undefined
                          }
                          onClick={() => void openVersion(row.version.id)}
                        >
                          <span>{row.version.payload.name}</span>{' '}
                          <small>
                            v{row.version.version} · {stateText(row)}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <div className="learning-detail" aria-live="polite">
          {mode === 'view' && !detail && (
            <p className="muted">
              Choose a lesson to read its exact text, evidence, permissions and
              changes, or write a new one.
            </p>
          )}
          {mode !== 'view' && renderForm()}
          {renderDetail()}
          {message && (
            <p role="status" className="learning-message">
              {message}
            </p>
          )}
        </div>
      </div>
      {!list && !loadError && <p className="muted">Loading lessons…</p>}
      {list && list.skills.length === 0 && (
        <p className="muted">
          No lessons yet. Write one yourself. Automatic suggestions stay
          unavailable until a local model is connected.
        </p>
      )}
    </section>
  );
}
