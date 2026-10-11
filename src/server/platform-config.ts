import type { WebConfig } from './parallel.js';
import type { SetupStatus, TelegramStatus } from '../shared/types.js';

/** Telegram connector settings. The bot token is a server-side secret: never log it or send it to the browser. */
export interface TelegramSettings {
  telegramBotToken?: string;
  telegramOwnerId?: string;
  telegramAllowedIds?: string[];
  telegramDotId?: string;
}

export interface PlatformConfig extends WebConfig, TelegramSettings {
  model?: string;
  apiKey?: string;
  baseUrl: string;
  /** A pinned loopback endpoint for local learning extraction. Never the chat provider. */
  learningExtractorUrl?: string;
  learningExtractorModel?: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  runtimeUrl: string;
  ownerToken?: string;
}

/** The optional Exa key. It has no effect unless WEB_SEARCH_PROVIDER=exa selects Exa. */
export function exaApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, ['EXA_API_KEY']);
}

/** A self-hosted SearxNG base URL, or undefined when search is not configured. */
export function searxngUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  const value = firstNonEmptyEnvValue(env, ['SEARXNG_URL']);
  if (!value) return undefined;
  const invalid =
    'SEARXNG_URL must be an http(s) base URL without credentials, query, or fragment.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(invalid);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(invalid);
  return value.replace(/\/$/, '');
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function telegramConfigFromEnv(
  env: Record<string, string | undefined>,
): TelegramSettings {
  return {
    telegramBotToken: trimmedOrUndefined(env.TELEGRAM_BOT_TOKEN),
    telegramOwnerId: trimmedOrUndefined(env.TELEGRAM_OWNER_ID),
    telegramAllowedIds: (env.TELEGRAM_ALLOWED_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    telegramDotId: trimmedOrUndefined(env.TELEGRAM_DOT_ID),
  };
}

function isTelegramUserId(value: string | undefined): value is string {
  return !!value && /^\d+$/.test(value);
}

/** The token, owner id, and every allowed id are present and well formed, so the connector may start. */
export function telegramDeclared(
  config: PlatformConfig,
): config is PlatformConfig & {
  telegramBotToken: string;
  telegramOwnerId: string;
} {
  return (
    !!config.telegramBotToken &&
    isTelegramUserId(config.telegramOwnerId) &&
    (config.telegramAllowedIds ?? []).every(isTelegramUserId)
  );
}

function telegramAnySetting(config: PlatformConfig): boolean {
  return !!(
    config.telegramBotToken ||
    config.telegramOwnerId ||
    config.telegramDotId ||
    config.telegramAllowedIds?.length
  );
}

export function telegramStatus(
  config: PlatformConfig,
  online = false,
  activationFailed = false,
): TelegramStatus {
  if (telegramDeclared(config)) {
    if (activationFailed) return 'activation_failed';
    return online ? 'online' : 'setup_required';
  }
  return telegramAnySetting(config) ? 'setup_required' : 'not_configured';
}

export function setupStatus(
  config: PlatformConfig,
  telegramOnline = false,
  telegramActivationFailed = false,
): SetupStatus {
  const missing = [
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  return {
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    telegram: telegramStatus(config, telegramOnline, telegramActivationFailed),
    missing,
  };
}
