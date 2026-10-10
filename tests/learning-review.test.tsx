import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
import { LearningReview } from '../src/client/LearningReview';
import type { Dot } from '../src/shared/types';

// Owner review screen: what it shows, which actions a state allows, and that an
// action sends back the exact token the owner read.

const payload = {
  name: 'review-evidence',
  description: 'Review evidence before saving a research page.',
  triggers: ['review research evidence'],
  steps: ['Check the cited source before drawing the conclusion.'],
  pitfalls: [],
  verification: 'Check that each claim has source evidence.',
  requiredTools: ['read_space_page'],
  notFor: ['Authorizing connected-service writes'],
};
const HASH = 'a'.repeat(64);
const EVIDENCE_HASH = 'b'.repeat(64);

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    skillId: 's1',
    slug: 'review-evidence',
    version: 1,
    baseVersionId: null,
    state: 'pending',
    payload,
    contentHash: HASH,
    evidenceHash: EVIDENCE_HASH,
    evidence: [],
    createdBy: 'owner',
    extractorPromptVersion: 'owner-v1',
    safetyFindings: [],
    createdAt: 0,
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    ...overrides,
  };
}

const usage = {
  activeSkills: 0,
  activeSkillsLimit: 32,
  workspaceActiveSkills: 0,
  workspaceActiveSkillsLimit: 256,
  pendingVersions: 1,
  pendingVersionsLimit: 10,
  workspacePendingVersions: 1,
  workspacePendingVersionsLimit: 100,
};

const dot: Dot = {
  id: 'dot1',
  spaceId: 'space',
  spaceIds: ['space'],
  name: 'Research Dot',
  instructions: 'Research carefully.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
  skillDeliveryEnabled: true,
  learningEnabled: false,
};

/** Serves the list and the detail for one version, whose state the test chooses. */
function serve(
  opts: {
    state?: string;
    active?: boolean;
    replaces?: unknown;
    usage?: Partial<typeof usage>;
    evidence?: unknown[];
    createdBy?: string;
  } = {},
) {
  const current = version({
    state: opts.active ? 'approved' : (opts.state ?? 'pending'),
    evidence: opts.evidence ?? [],
    createdBy: opts.createdBy ?? 'owner',
  });
  const activeVersionId = opts.active ? 'v1' : null;
  const list = {
    extraction: {
      available: false,
      reason:
        'No local extraction model is connected. You can still write, edit, and review lessons yourself.',
    },
    usage: { ...usage, ...opts.usage },
    skills: [
      {
        id: 's1',
        slug: 'review-evidence',
        activeVersionId,
        revision: 0,
        versions: [current],
      },
    ],
  };
  const detail = {
    version: current,
    replaces: opts.replaces ?? null,
    skill: {
      id: 's1',
      slug: 'review-evidence',
      activeVersionId,
      revision: 0,
    },
    review: {
      versionId: 'v1',
      contentHash: HASH,
      evidenceHash: EVIDENCE_HASH,
      expectedActiveVersionId: activeVersionId,
    },
  };
  api.mockImplementation(async (path: string) => {
    if (path === '/dots/dot1/learning') return list;
    if (path === '/dots/dot1/learning/versions/v1') return detail;
    throw new Error(`unexpected request ${path}`);
  });
}

async function render() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <LearningReview dot={dot} memoryAllowed onBack={() => {}} />,
    );
  });
  // Select the lesson so its detail (and its actions) are shown.
  await act(async () => {
    buttonNamed(renderer, 'review-evidence').props.onClick();
  });
  return renderer;
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'children' in node)
    return textOf((node as { children: unknown }).children);
  return '';
}

/** Visible text of a rendered instance, read from the test tree. */
function instanceText(node: ReactTestInstance | string): string {
  return typeof node === 'string'
    ? node
    : node.children.map(instanceText).join('');
}

function buttonsNamed(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (node) =>
      node.type === 'button' &&
      (instanceText(node).includes(label) ||
        node.props['aria-label'] === label),
  );
}

function buttonNamed(renderer: ReactTestRenderer, label: string) {
  const found = buttonsNamed(renderer, label);
  if (found.length === 0) throw new Error(`No button "${label}".`);
  return found[0];
}

const bodyText = (renderer: ReactTestRenderer) => textOf(renderer.toJSON());

beforeEach(() => {
  api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

it('shows the exact text, permissions, evidence, and that automatic suggestions are unavailable', async () => {
  serve();
  const renderer = await render();
  const text = bodyText(renderer);
  expect(text).toContain('Automatic suggestions are unavailable');
  expect(text).toContain('Review evidence before saving a research page.');
  expect(text).toContain(
    'Check the cited source before drawing the conclusion.',
  );
  expect(text).toContain('read_space_page');
  expect(text).toContain('Authorizing connected-service writes');
  expect(text).toContain('Written by you. It cites no conversation messages.');
  expect(text).toContain('Waiting for review. It is not active');
  expect(text).toContain('Nothing is sent to Intelligence');
});

it('approves with the exact token the owner read, and offers approval only for a pending lesson', async () => {
  serve();
  const renderer = await render();
  expect(buttonsNamed(renderer, 'Approve and activate')).toHaveLength(1);
  // Only the approval is answered here; reads keep serving the served fixture.
  const reads = api.getMockImplementation()!;
  api.mockClear();
  api.mockImplementation(async (path: string, method?: string) =>
    path.endsWith('/approve')
      ? version({ state: 'approved' })
      : reads(path, method),
  );
  await act(async () => {
    buttonNamed(renderer, 'Approve and activate').props.onClick();
  });
  expect(api).toHaveBeenCalledWith(
    '/dots/dot1/learning/versions/v1/approve',
    'POST',
    {
      review: {
        versionId: 'v1',
        contentHash: HASH,
        evidenceHash: EVIDENCE_HASH,
        expectedActiveVersionId: null,
      },
    },
  );
});

it('never offers approval for a quarantined lesson and says it cannot be approved', async () => {
  serve({ state: 'quarantined' });
  const renderer = await render();
  expect(buttonsNamed(renderer, 'Approve and activate')).toHaveLength(0);
  expect(bodyText(renderer)).toContain('cannot be approved');
  expect(bodyText(renderer)).toContain('Quarantined');
});

it('shows an active lesson as live only when delivery is on, and asks before retiring', async () => {
  serve({ active: true });
  const renderer = await render();
  expect(bodyText(renderer)).toContain(
    'Conversations for this Dot can use it now.',
  );
  expect(buttonsNamed(renderer, 'Approve and activate')).toHaveLength(0);
  await act(async () => {
    buttonNamed(renderer, 'Retire…').props.onClick();
  });
  expect(bodyText(renderer)).toContain('Retiring removes this lesson');
  expect(buttonsNamed(renderer, 'Confirm retire')).toHaveLength(1);
});

it('says the active lesson is not reaching conversations while delivery is off', async () => {
  serve({ active: true });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <LearningReview
        dot={{ ...dot, skillDeliveryEnabled: false }}
        memoryAllowed
        onBack={() => {}}
      />,
    );
  });
  await act(async () => {
    buttonNamed(renderer, 'review-evidence').props.onClick();
  });
  expect(bodyText(renderer)).toContain('Delivery is off');
  expect(bodyText(renderer)).toContain('no conversation uses it yet');
});

it('states plainly when the Dot is at its proposal limit', async () => {
  serve({ usage: { pendingVersions: 10 } });
  const renderer = await render();
  expect(bodyText(renderer)).toContain(
    'Full: this Dot has reached its limit of proposals waiting for review.',
  );
});

it('shows the replacement diff against the active version', async () => {
  const replaced = version({
    id: 'v0',
    state: 'approved',
    payload: { ...payload, verification: 'Check each claim.' },
  });
  serve({ replaces: replaced });
  const renderer = await render();
  const text = bodyText(renderer);
  expect(text).toContain('Changes');
  expect(text).toContain('Added: ');
  expect(text).toContain('Removed: ');
  expect(
    buttonsNamed(renderer, 'Approve and replace active version'),
  ).toHaveLength(1);
});

it('states that a lesson written by the extractor cites its messages', async () => {
  serve({
    createdBy: 'extractor',
    evidence: [
      {
        threadId: 't1',
        runId: 'r1',
        messageId: 'm1',
        ordinal: 4,
        role: 'user',
        sha256: 'c'.repeat(64),
        signal: 'correction',
      },
    ],
  });
  const renderer = await render();
  expect(bodyText(renderer)).toContain('user message 4, correction signal');
});
