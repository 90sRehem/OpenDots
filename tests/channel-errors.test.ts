import { afterEach, expect, it, vi } from 'vitest';
import {
  reportChannelFailure,
  safeFailure,
} from '../src/server/channel-errors.js';

afterEach(() => vi.restoreAllMocks());

it('reduces provider failures to safe names and valid HTTP statuses', () => {
  const failure = Object.assign(new Error('secret token'), { status: 503 });
  expect(safeFailure(failure)).toBe('Error (HTTP 503)');
  expect(safeFailure(new Error('secret token'))).toBe('Error');
  expect(safeFailure({ name: 'CredentialError', status: 700 })).toBe('Error');
});

it('preserves channel failure reporting output', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  reportChannelFailure('Shutdown failed', ['Error', 'TimeoutError']);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    'Shutdown failed: Error; TimeoutError',
  );
});
