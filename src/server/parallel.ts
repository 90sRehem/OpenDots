import { z } from 'zod';

// Public-web search providers are local only: a self-hosted SearxNG instance or the isolated read-only browser worker.
export type WebSearchProvider = 'searxng' | 'browser' | 'disabled';
export interface WebConfig {
  webSearchProvider?: WebSearchProvider;
  /** Base URL of a self-hosted SearxNG instance, for example http://127.0.0.1:8080. */
  searxngUrl?: string;
  browserUrl?: string;
  browserSecret?: string;
}
export interface WebSource {
  title: string;
  url: string;
  text: string;
}

const maxSources = 5;
const maxQueries = 3;
const maxQueryLength = 200;
const maxSourceText = 6000;
const requestTimeoutMs = 60_000;

export function webSearchProvider(
  value?: string,
  endpoints: Pick<
    WebConfig,
    'searxngUrl' | 'browserUrl' | 'browserSecret'
  > = {},
): WebSearchProvider {
  if (!value) {
    // Prefer the self-hosted search engine, then the local page reader; otherwise search is honestly disabled.
    if (endpoints.searxngUrl) return 'searxng';
    if (endpoints.browserUrl && endpoints.browserSecret) return 'browser';
    return 'disabled';
  }
  if (value === 'searxng' || value === 'browser' || value === 'disabled')
    return value;
  if (value === 'parallel')
    throw new Error(
      'WEB_SEARCH_PROVIDER=parallel is no longer supported. Use searxng with a self-hosted SEARXNG_URL, browser, or disabled.',
    );
  throw new Error('WEB_SEARCH_PROVIDER must be searxng, browser, or disabled.');
}

export function selectedWebSearchProvider(
  config: WebConfig,
): WebSearchProvider {
  return config.webSearchProvider ?? webSearchProvider(undefined, config);
}

/** Returns why public-web search cannot run, or undefined when the selected provider is ready. */
export function webSearchUnavailableReason(
  config: WebConfig,
): string | undefined {
  const provider = selectedWebSearchProvider(config);
  if (provider === 'searxng')
    return config.searxngUrl
      ? undefined
      : 'WEB_SEARCH_PROVIDER=searxng needs SEARXNG_URL pointing at a self-hosted SearxNG instance.';
  if (provider === 'browser')
    return config.browserUrl && config.browserSecret
      ? undefined
      : 'The browser reader needs BROWSER_URL and BROWSER_SECRET.';
  return 'Web search is disabled. Set SEARXNG_URL to a self-hosted SearxNG instance to enable it.';
}

const searchResponse = z.object({
  results: z.array(z.unknown()),
  unresponsive_engines: z.array(z.unknown()).nullable().optional(),
});
const searchResult = z.object({
  url: z.string().url(),
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
});

function citableHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Maps one SearxNG JSON response (format=json) to sources. Snippets are the excerpts; pages are not fetched. */
export function searxngSourcesFromResponse(
  data: unknown,
  warn: (message: string) => void = () => {},
): WebSource[] {
  const parsed = searchResponse.safeParse(data);
  if (!parsed.success)
    throw new Error('The local search engine returned an invalid response.');
  const unresponsive = parsed.data.unresponsive_engines?.length ?? 0;
  if (unresponsive)
    warn(
      `${unresponsive} search engine(s) did not respond; coverage is incomplete.`,
    );
  let discarded = 0;
  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const item of parsed.data.results) {
    const result = searchResult.safeParse(item);
    if (!result.success || !citableHttpUrl(result.data.url)) {
      discarded++;
      continue;
    }
    const text = result.data.content?.trim();
    if (!text) {
      discarded++;
      continue;
    }
    if (seen.has(result.data.url)) continue;
    seen.add(result.data.url);
    sources.push({
      title: result.data.title?.trim() || result.data.url,
      url: result.data.url,
      text: text.slice(0, maxSourceText),
    });
  }
  if (discarded)
    warn(
      `Skipped ${discarded} malformed or empty source result(s); coverage is incomplete.`,
    );
  return sources;
}

async function searxngSearch(
  query: string,
  searxngUrl: string,
  signal: AbortSignal,
  warn: (message: string) => void,
): Promise<WebSource[]> {
  const endpoint = `${searxngUrl.replace(/\/$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(requestTimeoutMs),
  ]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: boundedSignal,
    });
  } catch {
    boundedSignal.throwIfAborted();
    throw new Error(
      'The local search engine is unreachable. Check that SearxNG is running and SEARXNG_URL is correct.',
    );
  }
  if (!response.ok) {
    if (response.status === 403)
      throw new Error(
        'The local search engine refused the JSON request. Enable the json format under search.formats in its SearxNG settings.',
      );
    throw new Error(
      `The local search engine returned HTTP ${response.status}. Check its configuration.`,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    boundedSignal.throwIfAborted();
    throw new Error('The local search engine returned an invalid response.');
  }
  return searxngSourcesFromResponse(data, warn);
}

export async function searxngSources(
  request: {
    objective: string;
    searchQueries?: string[];
    onWarning?: (message: string) => void;
  },
  config: WebConfig,
  signal: AbortSignal,
): Promise<WebSource[]> {
  signal.throwIfAborted();
  const provider = selectedWebSearchProvider(config);
  if (provider !== 'searxng')
    throw new Error(`Web search provider is ${provider}, not searxng.`);
  if (!config.searxngUrl) throw new Error(webSearchUnavailableReason(config));
  const queries = (
    request.searchQueries?.length ? request.searchQueries : [request.objective]
  )
    .slice(0, maxQueries)
    .map((query) => query.trim().slice(0, maxQueryLength))
    .filter(Boolean);
  if (!queries.length) throw new Error('Web search needs a query.');
  const warnings = new Set<string>();
  const warn = (message: string) => {
    if (warnings.has(message)) return;
    warnings.add(message);
    request.onWarning?.(message);
  };
  // Send only the requested queries to the local engine, never memories or the full transcript.
  const batches = await Promise.all(
    queries.map((query) =>
      searxngSearch(query, config.searxngUrl!, signal, warn),
    ),
  );
  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const source of batches.flat()) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  signal.throwIfAborted();
  if (!sources.length)
    throw new Error(
      'The local search engine found no usable sources. Try a more specific research request.',
    );
  return sources.slice(0, maxSources);
}
