import { setupInputSchema } from './setup-telemetry.js';
import { pageRoutes } from './page-routes.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import {
  learningContainerIdSchema,
  learningEditSchema,
  learningProposalSchema,
  learningReviewActionSchema,
  validateLegacyLearningContainer,
  type LearningReviewToken,
  type LearningVersionView,
} from '../shared/learning.js';
import {
  learningEvidenceHash,
  LearningReviewError,
  OWNER_PROMPT_VERSION,
  type LearningReviewCode,
  type LearningVersion,
} from './workspace.js';
import { learningExtractionStatus, learningReviewToken } from './learning.js';
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    learningContainerId: learningContainerIdSchema.optional(),
    learningEnabled: z.boolean().optional(),
    skillDeliveryEnabled: z.boolean().optional(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
  })
  .strict();
const LEARNING_FORM_ERROR =
  'Check the lesson: the name must be a lowercase slug, and each field must stay within its length and count limit.';
/** Refusal status per review code. Stale tokens and full caps are conflicts, not server faults. */
const LEARNING_STATUS: Record<LearningReviewCode, 400 | 404 | 409> = {
  invalid: 400,
  not_found: 404,
  state: 409,
  stale_content: 409,
  stale_evidence: 409,
  stale_base: 409,
  stale_active: 409,
  evidence_unverified: 409,
  capacity: 409,
};
function learningVersionView(
  version: LearningVersion,
  slug: string,
): LearningVersionView {
  return {
    id: version.id,
    skillId: version.skillId,
    slug,
    version: version.version,
    baseVersionId: version.baseVersionId,
    state: version.state,
    payload: version.payload,
    contentHash: version.contentHash,
    evidenceHash: learningEvidenceHash(version.evidence),
    evidence: version.evidence,
    createdBy: version.createdBy,
    extractorPromptVersion: version.extractorPromptVersion,
    safetyFindings: version.safetyFindings,
    createdAt: version.createdAt,
    reviewedAt: version.reviewedAt,
    reviewedBy: version.reviewedBy,
    reviewNote: version.reviewNote,
  };
}
/**
 * Maps a learning-store refusal to its status. Store refusals that are plain
 * messages are authored caps or stale-proposal notices, so they are conflicts;
 * SQLite failures carry a driver code and are left to the generic error handler.
 */
function learningFailure(c: Context, error: unknown) {
  if (error instanceof LearningReviewError)
    return c.json(
      { error: error.message, code: error.code },
      LEARNING_STATUS[error.code],
    );
  if (error instanceof Error && !('code' in error))
    return c.json({ error: error.message }, 409);
  throw error;
}
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', pageRoutes(platform));
  app.post('/setup-telemetry', async (c) => {
    const parsed = setupInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: 'Invalid setup event.' }, 400);
    const event = parsed.data;
    if (
      event.kind === 'step_viewed' &&
      event.step !== 'settings' &&
      event.step !==
        (platform.setup().missing.length ? 'setup_required' : 'ready')
    )
      return c.json({ error: 'Setup step does not match server state.' }, 400);
    platform.setupTelemetry.capture(event);
    return c.json({ ok: true });
  });
  app.get('/workspace', (c) =>
    c.json({
      spaces: platform.workspace.spaces(),
      dots: platform.workspace.dots(),
      conversations: platform.workspace.conversations(),
      setup: platform.setup(),
      calls: platform.workspace.calls(),
    }),
  );
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      platform.workspace.createSpace(data.data.name, data.data.description),
      201,
    );
  });
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    try {
      validateLegacyLearningContainer(data.data.learningContainerId ?? null);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(
      platform.workspace.createDot(
        data.data.spaceId,
        data.data.name,
        data.data.instructions,
        data.data.researchAllowed,
        data.data.memoryAllowed,
        data.data.spaceIds,
        data.data.learningContainerId,
        data.data.skillDeliveryEnabled,
        data.data.learningEnabled,
      ),
      201,
    );
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    const current = platform.workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    try {
      validateLegacyLearningContainer(
        data.data.learningContainerId === undefined
          ? (current.learningContainerId ?? null)
          : data.data.learningContainerId,
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Invalid Learning settings.',
        },
        400,
      );
    }
    return c.json(platform.workspace.updateDot(c.req.param('id'), data.data));
  });
  // Owner-scoped learning routes (design report sections 4.4 and 4.6). They sit
  // under the same /api host, origin, content-type and token checks as the Dot
  // routes. Each handler proves the Dot exists, and the store only returns rows
  // owned by this workspace and attached to that Dot.
  app.get('/dots/:id/learning', (c) => {
    const dot = platform.workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    const skills = platform.workspace.learningSkills(dot.id).map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      activeVersionId: skill.activeVersionId,
      revision: skill.revision,
      useCount: skill.useCount,
      lastUsedAt: skill.lastUsedAt,
      blockedUntil: skill.blockedUntil,
      versions: platform.workspace
        .learningVersions(skill.id)
        .map((version) => learningVersionView(version, skill.slug)),
    }));
    return c.json({
      dotId: dot.id,
      extraction: learningExtractionStatus(),
      usage: platform.workspace.learningUsage(dot.id),
      skills,
    });
  });
  app.get('/dots/:id/learning/versions/:versionId', (c) => {
    const dot = platform.workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    const found = platform.workspace.learningVersionFor(
      dot.id,
      c.req.param('versionId'),
    );
    if (!found) return c.json({ error: 'Learning version not found.' }, 404);
    const { version, skill } = found;
    // The version this one would replace, shown for the word-level diff.
    const active =
      skill.activeVersionId && skill.activeVersionId !== version.id
        ? platform.workspace.learningVersion(skill.activeVersionId)
        : undefined;
    return c.json({
      version: learningVersionView(version, skill.slug),
      replaces: active ? learningVersionView(active, skill.slug) : null,
      skill: {
        id: skill.id,
        slug: skill.slug,
        activeVersionId: skill.activeVersionId,
        revision: skill.revision,
      },
      review: learningReviewToken(version, skill.activeVersionId),
    });
  });
  app.post('/dots/:id/learning/proposals', async (c) => {
    const dot = platform.workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    const parsed = learningProposalSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: LEARNING_FORM_ERROR }, 400);
    const slug = parsed.data.payload.name;
    const existing = platform.workspace
      .learningSkills(dot.id)
      .find((skill) => skill.slug === slug);
    try {
      // A new proposal is based on what is active now, so approval refuses it if
      // that changes before the owner reviews it.
      const version = platform.workspace.proposeLearningVersion({
        dotId: dot.id,
        slug,
        payload: parsed.data.payload,
        evidence: [],
        state: 'pending',
        createdBy: 'owner',
        baseVersionId: existing?.activeVersionId ?? null,
        extractorPromptVersion: OWNER_PROMPT_VERSION,
      });
      return c.json(learningVersionView(version, slug), 201);
    } catch (error) {
      return learningFailure(c, error);
    }
  });
  app.post('/dots/:id/learning/versions/:versionId/edit', async (c) => {
    const dot = platform.workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    const versionId = c.req.param('versionId');
    const found = platform.workspace.learningVersionFor(dot.id, versionId);
    if (!found) return c.json({ error: 'Learning version not found.' }, 404);
    const parsed = learningEditSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: LEARNING_FORM_ERROR }, 400);
    if (parsed.data.review.versionId !== versionId)
      return c.json({ error: 'The review names a different version.' }, 400);
    if (parsed.data.payload.name !== found.skill.slug)
      return c.json(
        {
          error:
            'An edit keeps the lesson name. Propose a new lesson to use a different name.',
        },
        400,
      );
    try {
      const edited = platform.workspace.proposeLearningEdit(
        dot.id,
        parsed.data.review,
        parsed.data.payload,
      );
      return c.json(learningVersionView(edited, found.skill.slug), 201);
    } catch (error) {
      return learningFailure(c, error);
    }
  });
  // Each review action names the exact version, content hash, evidence digest
  // and active pointer the owner read. The store refuses any mismatch.
  const reviewActions: Record<
    'approve' | 'reject' | 'retire' | 'restore',
    (token: LearningReviewToken, note: string | null) => LearningVersion
  > = {
    approve: (token, note) =>
      platform.workspace.approveLearningVersion(token, note),
    reject: (token, note) =>
      platform.workspace.rejectLearningVersion(token, note),
    retire: (token, note) =>
      platform.workspace.retireLearningVersion(token, note),
    restore: (token, note) =>
      platform.workspace.restoreLearningVersion(token, note),
  };
  for (const [action, review] of Object.entries(reviewActions)) {
    app.post(`/dots/:id/learning/versions/:versionId/${action}`, async (c) => {
      const dot = platform.workspace.dot(c.req.param('id'));
      if (!dot) return c.json({ error: 'Dot not found.' }, 404);
      const versionId = c.req.param('versionId');
      const found = platform.workspace.learningVersionFor(dot.id, versionId);
      if (!found) return c.json({ error: 'Learning version not found.' }, 404);
      const parsed = learningReviewActionSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        return c.json(
          { error: 'A review must name the exact version it reviewed.' },
          400,
        );
      if (parsed.data.review.versionId !== versionId)
        return c.json({ error: 'The review names a different version.' }, 400);
      try {
        const updated = review(parsed.data.review, parsed.data.note ?? null);
        return c.json(learningVersionView(updated, found.skill.slug));
      } catch (error) {
        return learningFailure(c, error);
      }
    });
  }
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).default('A new thought'),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    return c.json(
      await platform.createConversation(data.data.dotId, data.data.title),
      201,
    );
  });
  app.get('/conversations/:id/capture', (c) =>
    c.json(platform.workspace.capture(c.req.param('id'))),
  );
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string(), sdp: z.string().max(100000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A conversation and audio SDP offer are required.' },
        400,
      );
    return c.json(
      await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal),
      201,
    );
  });
  app.get('/voice/calls/:id', (c) =>
    c.json(platform.workspace.call(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/active', (c) =>
    c.json(voice.activate(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/compute', async (c) => {
    const data = z
      .object({
        toolCallId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(4000),
        transcript: z.string().max(12000).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A bounded compute request and tool call ID are required.' },
        400,
      );
    return c.json({
      text: await voice.compute(
        c.req.param('id'),
        data.data.toolCallId,
        `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
      ),
    });
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({
        transcript: z.string().max(20000),
        anchorMessageId: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Transcript exceeds the 20,000 character limit.' },
        400,
      );
    platform.workspace.anchorCall(c.req.param('id'), data.data.anchorMessageId);
    return c.json(await voice.end(c.req.param('id'), data.data.transcript));
  });
  app.all('/copilotkit/*', (c) => platform.handle(c.req.raw));
  app.onError((error, c) => {
    const text = error.message;
    if (text.startsWith('Space access must include'))
      return c.json({ error: text }, 400);
    const known =
      /^(Setup|Voice setup|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio|Intelligence could not)/.test(
        text,
      );
    // A conversation, call or Dot the caller named that does not exist is a missing resource, not a
    // server fault.
    if (
      /^(Dot not found|Call not found|Conversation does not belong)/.test(text)
    )
      return c.json({ error: text }, 404);
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
