import type { LearningPayload } from '../shared/learning';

// Pure helpers for the learning review screen: the exact text of each field, and a
// word-level before/after diff against the version a proposal would replace.

export const LEARNING_FIELDS = [
  { key: 'description', label: 'Description', list: false },
  { key: 'triggers', label: 'When it applies', list: true },
  { key: 'steps', label: 'Steps', list: true },
  { key: 'pitfalls', label: 'Pitfalls', list: true },
  { key: 'verification', label: 'Verification', list: false },
  { key: 'requiredTools', label: 'Required tools', list: true },
  { key: 'notFor', label: 'Not for', list: true },
] as const satisfies readonly {
  key: keyof LearningPayload;
  label: string;
  list: boolean;
}[];

export type DiffSegment = { kind: 'same' | 'added' | 'removed'; text: string };

/** A field's text: list fields become one line per entry, so a line change reads as a word change. */
export function fieldText(
  payload: LearningPayload,
  key: keyof LearningPayload,
) {
  const value = payload[key];
  return Array.isArray(value) ? value.join('\n') : String(value);
}

const tokens = (text: string) => text.match(/\s+|\S+/g) ?? [];

/** Longest-common-subsequence diff over words and whitespace, merged into runs. */
export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokens(before);
  const b = tokens(after);
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i++]);
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) push('removed', a[i++]);
    else push('added', b[j++]);
  }
  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);
  return segments;
}

export interface FieldDiff {
  key: keyof LearningPayload;
  label: string;
  changed: boolean;
  segments: DiffSegment[];
}

/** Every lesson field compared with the version it replaces, in display order. */
export function payloadDiff(
  before: LearningPayload,
  after: LearningPayload,
): FieldDiff[] {
  return LEARNING_FIELDS.map((field) => {
    const previous = fieldText(before, field.key);
    const next = fieldText(after, field.key);
    return {
      key: field.key,
      label: field.label,
      changed: previous !== next,
      segments: wordDiff(previous, next),
    };
  });
}
