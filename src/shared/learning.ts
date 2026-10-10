import { z } from 'zod';

// Local Automatic Learning schemas (design report sections 4.2 and 4.6). The
// server validates every payload and review token with these, so a value is
// checked the same way wherever it enters.

export const LEARNING_SIGNALS = [
  'explicit',
  'correction',
  'repeated_workflow',
] as const;
export type LearningSignal = (typeof LEARNING_SIGNALS)[number];

export const learningSlugSchema = z
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

export const safetyFindingSchema = z
  .object({
    code: boundedText(80),
    explanation: z.string().max(300),
  })
  .strict();
export type SafetyFinding = z.infer<typeof safetyFindingSchema>;

/**
 * The exact version a commander reviewed. Approval, rejection and retirement
 * must present every field; each is compared server-side, and any mismatch
 * refuses the change instead of applying it to whatever is current.
 */
export const learningReviewTokenSchema = z
  .object({
    versionId: z.string().min(1).max(64),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedActiveVersionId: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type LearningReviewToken = z.infer<typeof learningReviewTokenSchema>;

/**
 * Legacy Intelligence container slug. Old rows and clients still validate
 * against it, but nothing uses it for ownership, eligibility, or delivery.
 */
export const learningContainerIdSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use 1–64 lowercase letters, numbers, and single hyphens.',
  )
  .nullable();

export function validateLegacyLearningContainer(containerId: string | null) {
  if (!learningContainerIdSchema.safeParse(containerId).success)
    throw new Error(
      'Dot Learning container ID must use 1–64 lowercase letters, numbers, and single hyphens.',
    );
}
