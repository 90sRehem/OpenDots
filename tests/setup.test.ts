import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';

const model = {
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
};
const token = '123456:telegram-fixture-secret';
const declared: PlatformConfig = {
  ...model,
  telegramBotToken: token,
  telegramOwnerId: '1001',
  telegramAllowedIds: ['2002'],
};

it('reports Telegram not_configured when no Telegram setting is present', () => {
  expect(setupStatus(model).telegram).toBe('not_configured');
});

it.each([
  ['token only', { telegramBotToken: token }],
  ['owner only', { telegramOwnerId: '1001' }],
  ['Dot only', { telegramDotId: 'dot-1' }],
  ['non-numeric owner id', { ...declared, telegramOwnerId: 'owner' }],
  ['non-numeric allowed id', { ...declared, telegramAllowedIds: ['x'] }],
])(
  'reports setup_required for an incomplete declaration: %s',
  (_name, extra) => {
    expect(setupStatus({ ...model, ...extra }).telegram).toBe('setup_required');
  },
);

it('reports setup_required until the connector is online, then online', () => {
  expect(setupStatus(declared).telegram).toBe('setup_required');
  expect(setupStatus(declared, true).telegram).toBe('online');
});

it('reports activation_failed when a declared connector could not start', () => {
  expect(setupStatus(declared, false, true).telegram).toBe('activation_failed');
});

it('never reports online for an undeclared connector', () => {
  expect(setupStatus(model, true).telegram).toBe('not_configured');
});

it('keeps the bot token out of the status payload', () => {
  expect(JSON.stringify(setupStatus(declared, true))).not.toContain(token);
});

it('requires model setup and disables voice when the model is absent', () => {
  expect(
    setupStatus({
      ...declared,
      apiKey: undefined,
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({
    missing: ['OPENAI_API_KEY'],
    voice: false,
    telegram: 'setup_required',
  });
});

it('does not list Telegram as missing, so its absence blocks nothing else', () => {
  expect(setupStatus(model).missing).toEqual([]);
  expect(setupStatus({ ...model, telegramBotToken: token }).missing).toEqual(
    [],
  );
});
