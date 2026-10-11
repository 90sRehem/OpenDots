import { expect, it } from 'vitest';
import {
  telegramConfigFromEnv,
  telegramDeclared,
} from '../src/server/platform-config.js';

it('reads the four Telegram variables and trims them', () => {
  expect(
    telegramConfigFromEnv({
      TELEGRAM_BOT_TOKEN: '  123456:token  ',
      TELEGRAM_OWNER_ID: ' 1001 ',
      TELEGRAM_ALLOWED_IDS: ' 2002 , 3003 ',
      TELEGRAM_DOT_ID: ' dot-1 ',
    }),
  ).toEqual({
    telegramBotToken: '123456:token',
    telegramOwnerId: '1001',
    telegramAllowedIds: ['2002', '3003'],
    telegramDotId: 'dot-1',
  });
});

it('treats blank values and empty list entries as unset', () => {
  expect(
    telegramConfigFromEnv({
      TELEGRAM_BOT_TOKEN: '   ',
      TELEGRAM_OWNER_ID: '',
      TELEGRAM_ALLOWED_IDS: ' , ,2002,, ',
      TELEGRAM_DOT_ID: '',
    }),
  ).toEqual({
    telegramBotToken: undefined,
    telegramOwnerId: undefined,
    telegramAllowedIds: ['2002'],
    telegramDotId: undefined,
  });
});

it('reads no Telegram setting from an empty environment', () => {
  expect(telegramConfigFromEnv({})).toEqual({
    telegramBotToken: undefined,
    telegramOwnerId: undefined,
    telegramAllowedIds: [],
    telegramDotId: undefined,
  });
});

it('declares the connector only with a token, a numeric owner, and numeric allowed ids', () => {
  const base = { baseUrl: '', runtimeUrl: '', voiceName: 'marin' };
  expect(
    telegramDeclared({
      ...base,
      telegramBotToken: 'token',
      telegramOwnerId: '1001',
      telegramAllowedIds: ['2002'],
    }),
  ).toBe(true);
  expect(telegramDeclared({ ...base, telegramBotToken: 'token' })).toBe(false);
  expect(
    telegramDeclared({
      ...base,
      telegramOwnerId: '1001',
      telegramAllowedIds: [],
    }),
  ).toBe(false);
  expect(
    telegramDeclared({
      ...base,
      telegramBotToken: 'token',
      telegramOwnerId: 'owner',
    }),
  ).toBe(false);
});
