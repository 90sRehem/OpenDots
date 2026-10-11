import { z } from 'zod';

// Public-web search providers: a self-hosted SearxNG instance, an optional Exa key chosen explicitly, or the isolated read-only browser worker.
export type WebSearchProvider = 'searxng' | 'exa' | 'browser' | 'disabled';
export interface WebConfig {
  webSearchProvider?: WebSearchProvider;
  /** Base URL of a self-hosted SearxNG instance, for example http://127.0.0.1:8080. */
  searxngUrl?: string;
  /** Exa API key. Exa is used only when WEB_SEARCH_PROVIDER=exa selects it; it is never a default. */
  exaApiKey?: string;
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
const exaSearchUrl = 'https://api.exa.ai/search';

export function webSearchProvider(
  value?: string,
  endpoints: Pick<
    WebConfig,
    'searxngUrl' | 'browserUrl' | 'browserSecret'
  > = {},
): WebSearchProvider {
  if (!value) {
    // Only local providers are ever selected automatically; Exa requires an explicit choice.
    if (endpoints.searxngUrl) return 'searxng';
    if (endpoints.browserUrl && endpoints.browserSecret) return 'browser';
    return 'disabled';
  }
  if (
    value === 'searxng' ||
    value === 'exa' ||
    value === 'browser' ||
    value === 'disabled'
  )
    return value;
  if (value === 'parallel')
    throw new Error(
      'WEB_SEARCH_PROVIDER=parallel is no longer supported. Use searxng with a self-hosted SEARXNG_URL, exa with EXA_API_KEY, browser, or disabled.',
    );
  throw new Error(
    'WEB_SEARCH_PROVIDER must be searxng, exa, browser, or disabled.',
  );
}

export function selectedWebSearchProvider(
  config: WebConfig,
): WebSearchProvider {
  return config.webSearchProvider ?? webSearchProvider(undefined, config);
}

/** True when the selected provider returns search results (as opposed to reading one page). */
export function isSearchEngine(
  provider: WebSearchProvider,
): provider is 'searxng' | 'exa' {
  return provider === 'searxng' || provider === 'exa';
}

export function searchEngineLabel(provider: 'searxng' | 'exa'): string {
  return provider === 'searxng' ? 'SearxNG' : 'Exa';
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
  if (provider === 'exa')
    return config.exaApiKey
      ? undefined
      : 'WEB_SEARCH_PROVIDER=exa needs EXA_API_KEY.';
  if (provider === 'browser')
    return config.browserUrl && config.browserSecret
      ? undefined
      : 'The browser reader needs BROWSER_URL and BROWSER_SECRET.';
  return 'Web search is disabled. Set SEARXNG_URL to a self-hosted SearxNG instance to enable it, or choose exa with EXA_API_KEY.';
}

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

interface Candidate {
  url: string;
  title?: string | null;
  text?: string | null;
}

/** Shared normalization for every provider: unsafe or empty results are discarded, duplicates merged. */
function citableSources(
  items: unknown[],
  toCandidate: (item: unknown) => Candidate | undefined,
  warn: (message: string) => void,
): WebSource[] {
  let discarded = 0;
  const seen = new Set<string>();
  const sources: WebSource[] = [];
  for (const item of items) {
    const candidate = toCandidate(item);
    const text = candidate?.text?.trim();
    if (!candidate || !citableHttpUrl(candidate.url) || !text) {
      discarded++;
      continue;
    }
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    sources.push({
      title: candidate.title?.trim() || candidate.url,
      url: candidate.url,
      text: text.slice(0, maxSourceText),
    });
  }
  if (discarded)
    warn(
      `Skipped ${discarded} malformed or empty source result(s); coverage is incomplete.`,
    );
  return sources;
}

const searxngResponse = z.object({
  results: z.array(z.unknown()),
  unresponsive_engines: z.array(z.unknown()).nullable().optional(),
});
const searxngResult = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
});

/** Maps one SearxNG JSON response (format=json) to sources. Snippets are the excerpts; pages are not fetched. */
export function searxngSourcesFromResponse(
  data: unknown,
  warn: (message: string) => void = () => {},
): WebSource[] {
  const parsed = searxngResponse.safeParse(data);
  if (!parsed.success)
    throw new Error('The local search engine returned an invalid response.');
  const unresponsive = parsed.data.unresponsive_engines?.length ?? 0;
  if (unresponsive)
    warn(
      `${unresponsive} search engine(s) did not respond; coverage is incomplete.`,
    );
  return citableSources(
    parsed.data.results,
    (item) => {
      const result = searxngResult.safeParse(item);
      return result.success
        ? {
            url: result.data.url,
            title: result.data.title,
            text: result.data.content,
          }
        : undefined;
    },
    warn,
  );
}

const exaResponse = z.object({ results: z.array(z.unknown()) });
const exaResult = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  highlights: z.array(z.string()).nullable().optional(),
});

/** Maps one Exa search response to the same sources; highlights are the excerpts, page text is the fallback. */
export function exaSourcesFromResponse(
  data: unknown,
  warn: (message: string) => void = () => {},
): WebSource[] {
  const parsed = exaResponse.safeParse(data);
  if (!parsed.success) throw new Error('Exa returned an invalid response.');
  return citableSources(
    parsed.data.results,
    (item) => {
      const result = exaResult.safeParse(item);
      if (!result.success) return undefined;
      const highlights = (result.data.highlights ?? [])
        .map((text) => text.trim())
        .filter(Boolean)
        .join('\n');
      return {
        url: result.data.url,
        title: result.data.title,
        text: highlights || result.data.text,
      };
    },
    warn,
  );
}

async function boundedRequest(
  signal: AbortSignal,
  request: (signal: AbortSignal) => Promise<Response>,
  unreachable: string,
): Promise<Response> {
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(requestTimeoutMs),
  ]);
  try {
    return await request(boundedSignal);
  } catch {
    boundedSignal.throwIfAborted();
    throw new Error(unreachable);
  }
}

async function searxngSearch(
  query: string,
  searxngUrl: string,
  signal: AbortSignal,
  warn: (message: string) => void,
): Promise<WebSource[]> {
  const endpoint = `${searxngUrl.replace(/\/$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  const response = await boundedRequest(
    signal,
    (requestSignal) =>
      fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal: requestSignal,
      }),
    'The local search engine is unreachable. Check that SearxNG is running and SEARXNG_URL is correct.',
  );
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
    signal.throwIfAborted();
    throw new Error('The local search engine returned an invalid response.');
  }
  return searxngSourcesFromResponse(data, warn);
}

async function exaSearch(
  query: string,
  apiKey: string,
  signal: AbortSignal,
  warn: (message: string) => void,
): Promise<WebSource[]> {
  const response = await boundedRequest(
    signal,
    (requestSignal) =>
      fetch(exaSearchUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query,
          numResults: maxSources,
          contents: { highlights: { maxCharacters: 2000 } },
        }),
        signal: requestSignal,
      }),
    'Exa is unreachable. Check the network connection and try again.',
  );
  if (!response.ok) {
    // Never echo the key or the provider's body into errors.
    if (response.status === 401 || response.status === 403)
      throw new Error('Exa rejected EXA_API_KEY. Check the key on the server.');
    if (response.status === 429)
      throw new Error('Exa rate limit reached. Retry later.');
    throw new Error(`Exa returned HTTP ${response.status}.`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    signal.throwIfAborted();
    throw new Error('Exa returned an invalid response.');
  }
  return exaSourcesFromResponse(data, warn);
}

/** Runs the selected search engine (SearxNG or Exa) and returns the same WebSource shape for either. */
export async function searchSources(
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
  if (!isSearchEngine(provider))
    throw new Error(`Web search provider is ${provider}, not a search engine.`);
  const unavailable = webSearchUnavailableReason(config);
  if (unavailable) throw new Error(unavailable);
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
  // Send only the requested queries to the engine, never memories or the full transcript.
  const batches = await Promise.all(
    queries.map((query) =>
      provider === 'searxng'
        ? searxngSearch(query, config.searxngUrl!, signal, warn)
        : exaSearch(query, config.exaApiKey!, signal, warn),
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
      `The ${searchEngineLabel(provider)} search engine found no usable sources. Try a more specific research request.`,
    );
  return sources.slice(0, maxSources);
}
