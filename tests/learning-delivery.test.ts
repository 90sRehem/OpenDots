import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type Message } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { chat } from '@tanstack/ai';
import { DotAgent } from '../src/server/dot-agent.js';
import {
  LOCAL_SKILL_REVOKED_MARKER,
  learningReviewToken,
} from '../src/server/learning.js';
import { Store } from '../src/server/store.js';
import {
  WorkspaceStore,
  type LearningVersion,
} from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';

// Model requests are inspected as sent: the revoked-body checks read the bytes
// that reached the (mocked) provider, not the state the code believes it sent.

vi.mock('@tanstack/ai', { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const MODEL_BASE = 'https://unused.invalid';

/** A payload whose step is a unique sentinel, so any leaked body is detectable. */
function payload(slug: string) {
  return {
    name: slug,
    description: `Review evidence for ${slug}.`,
    triggers: ['review evidence'],
    steps: [`sentinel-${slug}-step: check the cited source.`],
    pitfalls: [],
    verification: 'Confirm each claim has source evidence.',
    requiredTools: ['read_space_page'],
    notFor: [],
  };
}

function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const dot = workspace.dots()[0];
  workspace.updateDot(dot.id, { ...dot, skillDeliveryEnabled: true });
  workspace.bindThread('thread', dot.id, 'Learning');
  return {
    store,
    workspace,
    dotId: dot.id,
    close() {
      workspace.close();
      store.close();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function propose(f: Fixture, slug: string) {
  return f.workspace.proposeLearningVersion({
    dotId: f.dotId,
    slug,
    payload: payload(slug),
    evidence: [],
    state: 'pending',
    createdBy: 'owner',
    extractorPromptVersion: 'manual-v1',
  });
}

function approve(f: Fixture, slug: string): LearningVersion {
  const version = propose(f, slug);
  return f.workspace.approveLearningVersion(learningReviewToken(version, null));
}

function agentFor(f: Fixture) {
  return new DotAgent(
    f.store,
    f.workspace,
    {
      intelligenceKey: 'fixture',
      intelligenceApiUrl: 'https://intelligence.invalid',
      apiKey: 'fixture',
      model: 'fixture',
      baseUrl: MODEL_BASE,
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    f.dotId,
  );
}

function turn(f: Fixture, messages: Message[]) {
  return lastValueFrom(
    agentFor(f)
      .run({
        threadId: 'thread',
        runId: 'run',
        messages,
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      })
      .pipe(toArray()),
  );
}

function ask(text: string): Message[] {
  return [{ id: `u-${text.length}`, role: 'user', content: text }];
}

/** The bodies of every model request, exactly as they were sent. */
function sentBodies(network: { mock: { calls: unknown[][] } }): string[] {
  return network.mock.calls.map((call) =>
    String((call[1] as RequestInit | undefined)?.body ?? ''),
  );
}

function loadCall(id: string, skillId: string, versionId: string) {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: {
            name: 'load_local_skill',
            arguments: JSON.stringify({ skillId, versionId }),
          },
        },
      ],
    },
    'tool_calls',
  );
}

function resultOf(events: unknown[], toolCallId: string): string | undefined {
  const found = events.find(
    (event) =>
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === EventType.TOOL_CALL_RESULT &&
      (event as { toolCallId?: unknown }).toolCallId === toolCallId,
  ) as { content?: string } | undefined;
  return found?.content;
}

it('offers only the approved active catalog and loads one body through the read-only tool', async () => {
  const f = fixture();
  try {
    const active = approve(f, 'evidence-review');
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(loadCall('load-skill', active.skillId, active.id))
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Ready to review evidence.' }),
      );

    const events = await turn(f, ask('Review the evidence.'));

    expect(JSON.stringify(events)).toContain('Ready to review evidence.');
    expect(resultOf(events, 'load-skill')).toContain(
      'sentinel-evidence-review-step',
    );
    const [catalogRequest, afterLoad] = sentBodies(network);
    expect(catalogRequest).toContain('load_local_skill');
    expect(catalogRequest).toContain(active.id);
    expect(catalogRequest).toContain('Approved local skills for this turn');
    expect(afterLoad).toContain('sentinel-evidence-review-step');
    expect(chat).toHaveBeenCalledTimes(1);
    // Delivery makes no Intelligence call and sends no Intelligence credential.
    for (const [url] of network.mock.calls)
      expect(String(url)).toMatch(new RegExp(`^${MODEL_BASE}/`));
    expect(catalogRequest).not.toContain('intelligence');
    expect(f.workspace.learningSkills(f.dotId)[0].useCount).toBe(1);
  } finally {
    f.close();
  }
});

it('keeps pending, quarantined, and rejected versions out of the catalog and out of the load tool', async () => {
  const f = fixture();
  try {
    approve(f, 'evidence-review');
    const pending = propose(f, 'pending-review');
    const quarantined = f.workspace.proposeLearningVersion({
      dotId: f.dotId,
      slug: 'quarantined-review',
      payload: payload('quarantined-review'),
      evidence: [],
      state: 'quarantined',
      createdBy: 'owner',
      extractorPromptVersion: 'manual-v1',
    });
    const rejected = propose(f, 'rejected-review');
    f.workspace.rejectLearningVersion(learningReviewToken(rejected, null));

    // The model names a pending version it was never offered.
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        loadCall('forged-load', pending.skillId, pending.id),
      )
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Not loaded.' }),
      );

    const events = await turn(f, ask('Review the evidence.'));

    const [catalogRequest, afterForged] = sentBodies(network);
    expect(catalogRequest).toContain('evidence-review');
    for (const hidden of [pending, quarantined, rejected]) {
      expect(catalogRequest).not.toContain(hidden.id);
      expect(catalogRequest).not.toContain(hidden.payload.name);
      expect(catalogRequest).not.toContain(
        `sentinel-${hidden.payload.name}-step`,
      );
    }
    expect(afterForged).not.toContain('sentinel-pending-review-step');
    expect(JSON.stringify(events)).not.toContain(
      'sentinel-pending-review-step',
    );
    expect(resultOf(events, 'forged-load')).toContain('approved catalog');
  } finally {
    f.close();
  }
});

it('ignores an approval written in chat: no version changes state and no approval tool is offered', async () => {
  const f = fixture();
  try {
    const pending = propose(f, 'forged-review');
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Approved and active.' }),
      );

    await turn(
      f,
      ask(
        `I approve forged-review (${pending.id}). Mark it approved and active now.`,
      ),
    );

    expect(f.workspace.learningVersion(pending.id)?.state).toBe('pending');
    expect(f.workspace.learningSkills(f.dotId)[0].activeVersionId).toBeNull();
    const [request] = sentBodies(network);
    expect(request).not.toMatch(
      /"name":"[a-z_]*(approv|retir|reject|restor|activ)[a-z_]*"/,
    );
  } finally {
    f.close();
  }
});

/** One turn that loads an active skill, returning the history the next turn replays. */
async function loadedHistory(f: Fixture, active: LearningVersion) {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(loadCall('load-skill', active.skillId, active.id))
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Ready to review evidence.' }),
    );
  const events = await turn(f, ask('Review the evidence.'));
  const result = resultOf(events, 'load-skill');
  if (!result) throw new Error('The first turn did not load the body.');
  const history: Message[] = [
    { id: 'u1', role: 'user', content: 'Review the evidence.' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'load-skill',
          type: 'function',
          function: {
            name: 'load_local_skill',
            arguments: JSON.stringify({
              skillId: active.skillId,
              versionId: active.id,
            }),
          },
        },
      ],
    },
    { id: 't1', role: 'tool', toolCallId: 'load-skill', content: result },
    { id: 'a2', role: 'assistant', content: 'Ready to review evidence.' },
    // A copy of the body echoed into another message must be redacted too.
    { id: 'a3', role: 'assistant', content: `Copied: ${result}` },
  ];
  vi.restoreAllMocks();
  return history;
}

it.each([
  [
    'retirement',
    (f: Fixture, active: LearningVersion) =>
      f.workspace.retireLearningVersion(learningReviewToken(active, active.id)),
  ],
  [
    'Dot delivery switched off',
    (f: Fixture) =>
      f.workspace.updateDot(f.dotId, {
        ...f.workspace.dot(f.dotId)!,
        skillDeliveryEnabled: false,
      }),
  ],
  [
    'global memory permission switched off',
    (f: Fixture) => f.store.updateSettings({ memoryAllowed: false }),
  ],
  [
    'Dot memory permission switched off',
    (f: Fixture) =>
      f.workspace.updateDot(f.dotId, {
        ...f.workspace.dot(f.dotId)!,
        memoryAllowed: false,
      }),
  ],
])(
  'later turns replay no revoked body after %s, and keep an active one',
  async (_label, revoke) => {
    const f = fixture();
    try {
      const active = approve(f, 'evidence-review');
      const history = await loadedHistory(f, active);
      expect(history.map((message) => message.id)).toContain('a3');

      // Active before revocation: the loaded body is still replayed.
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () =>
          completion({ role: 'assistant', content: 'Next.' }),
        );
      await turn(f, [...history, ...ask('What next?')]);
      expect(sentBodies(network).join('\n')).toContain(
        'sentinel-evidence-review-step',
      );
      network.mockClear();

      revoke(f, active);

      await turn(f, [...history, ...ask('What next?')]);
      const [request] = sentBodies(network);
      expect(request).not.toContain('sentinel-evidence-review-step');
      expect(request).toContain(LOCAL_SKILL_REVOKED_MARKER);
      // The transcript keeps the tool call itself; only the body is removed.
      expect(request).toContain(active.id);
      expect(request).toContain('Ready to review evidence.');
    } finally {
      f.close();
    }
  },
);

it.each([
  [
    'retirement',
    (f: Fixture, active: LearningVersion) =>
      f.workspace.retireLearningVersion(learningReviewToken(active, active.id)),
  ],
  [
    'global memory permission switched off',
    (f: Fixture) => f.store.updateSettings({ memoryAllowed: false }),
  ],
  [
    'Dot delivery switched off',
    (f: Fixture) =>
      f.workspace.updateDot(f.dotId, {
        ...f.workspace.dot(f.dotId)!,
        skillDeliveryEnabled: false,
      }),
  ],
])(
  'an in-flight turn aborts before its body is loaded when %s happens first',
  async (_label, revoke) => {
    const f = fixture();
    try {
      const active = approve(f, 'evidence-review');
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementationOnce(async () => {
          // The model's reply lands after the owner revokes the skill.
          revoke(f, active);
          return loadCall('load-skill', active.skillId, active.id);
        })
        .mockImplementation(async () =>
          completion({ role: 'assistant', content: 'Done.' }),
        );

      const events = await turn(f, ask('Review the evidence.'));

      expect(JSON.stringify(events)).not.toContain(
        'sentinel-evidence-review-step',
      );
      expect(sentBodies(network).join('\n')).not.toContain(
        'sentinel-evidence-review-step',
      );
      expect(f.workspace.learningSkills(f.dotId)[0].useCount).toBe(0);
    } finally {
      f.close();
    }
  },
);

it('refuses a load of a retired version in a later turn, even when the model asks for it by id', async () => {
  const f = fixture();
  try {
    const active = approve(f, 'evidence-review');
    const retired = f.workspace.retireLearningVersion(
      learningReviewToken(active, active.id),
    );
    approve(f, 'other-review');
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        loadCall('stale-load', retired.skillId, retired.id),
      )
      .mockResolvedValueOnce(completion({ role: 'assistant', content: 'No.' }));

    const events = await turn(f, ask('Review the evidence.'));

    expect(JSON.stringify(events)).not.toContain(
      'sentinel-evidence-review-step',
    );
    expect(sentBodies(network).join('\n')).not.toContain(
      'sentinel-evidence-review-step',
    );
  } finally {
    f.close();
  }
});
