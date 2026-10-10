import { expect, it } from 'vitest';
import { payloadDiff, wordDiff } from '../src/client/learning-diff';
import type { LearningPayload } from '../src/shared/learning';

const payload: LearningPayload = {
  name: 'review-evidence',
  description: 'Review evidence before saving.',
  triggers: ['review research evidence'],
  steps: ['Check the cited source.', 'Compare the claim.'],
  pitfalls: [],
  verification: 'Check each claim has source evidence.',
  requiredTools: ['read_space_page'],
  notFor: [],
};

/** Joins a diff back into the text it shows: removed and added runs both appear. */
const shown = (segments: { kind: string; text: string }[]) =>
  segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text)
    .join('');
const before = (segments: { kind: string; text: string }[]) =>
  segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text)
    .join('');

it('marks only the words that changed', () => {
  const segments = wordDiff(
    'Check each claim has source evidence.',
    'Check that each claim has source evidence.',
  );
  expect(segments).toContainEqual({ kind: 'added', text: 'that ' });
  expect(segments.filter((segment) => segment.kind === 'removed')).toEqual([]);
  expect(shown(segments)).toBe('Check that each claim has source evidence.');
  expect(before(segments)).toBe('Check each claim has source evidence.');
});

it('reports a replaced word as a removal and an addition', () => {
  const segments = wordDiff('Verify the source.', 'Confirm the source.');
  expect(segments).toContainEqual({ kind: 'removed', text: 'Verify' });
  expect(segments).toContainEqual({ kind: 'added', text: 'Confirm' });
  expect(before(segments)).toBe('Verify the source.');
  expect(shown(segments)).toBe('Confirm the source.');
});

it('compares each field and reports unchanged fields as unchanged', () => {
  const next: LearningPayload = {
    ...payload,
    verification: 'Check two independent sources.',
  };
  const diff = payloadDiff(payload, next);
  const changed = diff
    .filter((field) => field.changed)
    .map((field) => field.key);
  expect(changed).toEqual(['verification']);
  const verification = diff.find((field) => field.key === 'verification');
  expect(shown(verification!.segments)).toBe('Check two independent sources.');
});

it('treats a list field as one line per entry, so a removed step is shown', () => {
  const next: LearningPayload = {
    ...payload,
    steps: ['Check the cited source.'],
  };
  const steps = payloadDiff(payload, next).find(
    (field) => field.key === 'steps',
  );
  expect(steps?.changed).toBe(true);
  expect(steps?.segments.some((segment) => segment.kind === 'removed')).toBe(
    true,
  );
});
