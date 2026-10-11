import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exaSourcesFromResponse,
  searchSources,
  searxngSourcesFromResponse,
  selectedWebSearchProvider,
  webSearchProvider,
  webSearchUnavailableReason,
} from '../src/server/parallel.js';
import {
  exaApiKeyFromEnv,
  searxngUrlFromEnv,
} from '../src/server/platform-config.js';
import { research } from '../src/server/research.js';

const local = 'http://127.0.0.1:8080';
const model = 'https://model.example/v1';
const exaKey = 'exa-test-key-1234567890';
const browser = {
  browserUrl: 'http://browser:4311',
  browserSecret: 'b'.repeat(24),
};
const signal = new AbortController().signal;

const hit = (url = 'https://example.com', content = 'Verified snippet.') => ({
  url,
  title: 'Evidence',
  content,
});
const searxResponse = (...results: unknown[]) =>
  Response.json({ query: 'query', results, unresponsive_engines: [] });
const exaHit = (
  url = 'https://example.com',
  highlight = 'Verified highlight.',
) => ({
  url,
  title: 'Evidence',
  highlights: [highlight],
});
const exaResponse = (...results: unknown[]) =>
  Response.json({ requestId: 'r1', results });
const modelResponse = (content = 'Cited brief.') =>
  Response.json({ choices: [{ message: { content } }] });

afterEach(() => vi.unstubAllGlobals());

describe('web search provider selection', () => {
  it('prefers the local SearxNG provider, then the local browser reader, then disables search', () => {
    expect(
      webSearchProvider(undefined, { searxngUrl: local, ...browser }),
    ).toBe('searxng');
    expect(webSearchProvider(undefined, browser)).toBe('browser');
    expect(
      webSearchProvider(undefined, { browserUrl: browser.browserUrl }),
    ).toBe('disabled');
    expect(webSearchProvider(undefined, {})).toBe('disabled');
  });

  it('never selects Exa by default, even when its key is configured', () => {
    expect(selectedWebSearchProvider({ exaApiKey: exaKey })).toBe('disabled');
    expect(selectedWebSearchProvider({ exaApiKey: exaKey, ...browser })).toBe(
      'browser',
    );
    expect(
      selectedWebSearchProvider({ exaApiKey: exaKey, searxngUrl: local }),
    ).toBe('searxng');
    expect(webSearchUnavailableReason({ exaApiKey: exaKey })).toContain(
      'disabled',
    );
  });

  it('honors explicit providers and rejects removed or unknown values', () => {
    expect(webSearchProvider('searxng')).toBe('searxng');
    expect(webSearchProvider('exa')).toBe('exa');
    expect(webSearchProvider('browser')).toBe('browser');
    expect(webSearchProvider('disabled')).toBe('disabled');
    expect(() => webSearchProvider('parallel')).toThrow('no longer supported');
    expect(() => webSearchProvider('other')).toThrow('WEB_SEARCH_PROVIDER');
  });

  it('reports search unavailable honestly when the selected endpoint or key is missing', () => {
    expect(selectedWebSearchProvider({ searxngUrl: local })).toBe('searxng');
    expect(webSearchUnavailableReason({ searxngUrl: local })).toBeUndefined();
    expect(
      webSearchUnavailableReason({ webSearchProvider: 'searxng' }),
    ).toContain('SEARXNG_URL');
    expect(webSearchUnavailableReason({ webSearchProvider: 'exa' })).toContain(
      'EXA_API_KEY',
    );
    expect(
      webSearchUnavailableReason({
        webSearchProvider: 'exa',
        exaApiKey: exaKey,
      }),
    ).toBeUndefined();
    expect(
      webSearchUnavailableReason({ webSearchProvider: 'browser' }),
    ).toContain('BROWSER_URL');
    expect(webSearchUnavailableReason({})).toContain('disabled');
  });

  it('validates the SearxNG base URL and the Exa key from the environment', () => {
    expect(searxngUrlFromEnv({})).toBeUndefined();
    expect(searxngUrlFromEnv({ SEARXNG_URL: ' http://127.0.0.1:8080/ ' })).toBe(
      local,
    );
    expect(() => searxngUrlFromEnv({ SEARXNG_URL: 'not a url' })).toThrow(
      'SEARXNG_URL',
    );
    expect(() =>
      searxngUrlFromEnv({ SEARXNG_URL: 'ftp://127.0.0.1:8080' }),
    ).toThrow('SEARXNG_URL');
    expect(() =>
      searxngUrlFromEnv({ SEARXNG_URL: 'http://user:pw@127.0.0.1:8080' }),
    ).toThrow('SEARXNG_URL');
    expect(() =>
      searxngUrlFromEnv({ SEARXNG_URL: 'http://127.0.0.1:8080/?q=1' }),
    ).toThrow('SEARXNG_URL');
    expect(exaApiKeyFromEnv({})).toBeUndefined();
    expect(exaApiKeyFromEnv({ EXA_API_KEY: '  ' })).toBeUndefined();
    expect(exaApiKeyFromEnv({ EXA_API_KEY: ` ${exaKey} ` })).toBe(exaKey);
  });
});

describe('SearxNG result mapping', () => {
  it('maps JSON results to sources and skips unsafe, empty and duplicate entries', () => {
    const warn = vi.fn();
    const sources = searxngSourcesFromResponse(
      {
        results: [
          hit('https://example.com', 'First snippet.'),
          hit('https://example.com', 'Duplicate snippet.'),
          hit('javascript:alert(1)', 'Unsafe.'),
          hit('https://empty.example', '   '),
          { bad: true },
        ],
        unresponsive_engines: [['example-engine', 'timeout']],
      },
      warn,
    );
    expect(sources).toEqual([
      {
        title: 'Evidence',
        url: 'https://example.com',
        text: 'First snippet.',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not respond'),
    );
    expect(warn).toHaveBeenCalledWith(
      'Skipped 3 malformed or empty source result(s); coverage is incomplete.',
    );
  });

  it('rejects responses that are not SearxNG JSON', () => {
    expect(() => searxngSourcesFromResponse({ nope: true })).toThrow(
      'invalid response',
    );
  });
});

describe('Exa result mapping', () => {
  it('maps Exa results to the same source shape, preferring highlights over page text', () => {
    const warn = vi.fn();
    const sources = exaSourcesFromResponse(
      {
        requestId: 'r1',
        results: [
          {
            url: 'https://a.example',
            title: 'Alpha',
            highlights: ['Alpha excerpt.'],
          },
          { url: 'https://b.example', text: 'Beta page text.' },
          {
            url: 'https://c.example',
            title: null,
            highlights: ['Gamma excerpt.'],
          },
          { url: 'https://a.example', highlights: ['Duplicate.'] },
          { url: 'https://empty.example', highlights: [] },
          { url: 'ftp://unsafe.example', highlights: ['Unsafe.'] },
          { title: 'No url' },
        ],
      },
      warn,
    );
    expect(sources).toEqual([
      { title: 'Alpha', url: 'https://a.example', text: 'Alpha excerpt.' },
      {
        title: 'https://b.example',
        url: 'https://b.example',
        text: 'Beta page text.',
      },
      {
        title: 'https://c.example',
        url: 'https://c.example',
        text: 'Gamma excerpt.',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Skipped 3 malformed or empty source result(s); coverage is incomplete.',
    );
  });

  it('rejects responses that are not Exa JSON', () => {
    expect(() => exaSourcesFromResponse({ error: 'nope' })).toThrow(
      'Exa returned an invalid response',
    );
  });
});

describe('search engine requests', () => {
  it('queries only the configured local SearxNG instance and returns bounded, de-duplicated sources', async () => {
    const fetch = vi.fn(async (url: string) =>
      new URL(url).searchParams.get('q') === 'alpha topic'
        ? searxResponse(
            hit('https://a.example/1'),
            hit('https://a.example/2'),
            hit('https://a.example/3'),
            hit('https://a.example/4'),
          )
        : searxResponse(
            hit('https://a.example/4'),
            hit('https://b.example/5'),
            hit('https://b.example/6'),
            hit('https://b.example/7'),
          ),
    );
    vi.stubGlobal('fetch', fetch);
    const sources = await searchSources(
      {
        objective: 'Compare topics',
        searchQueries: ['alpha topic', 'beta topic'],
      },
      { webSearchProvider: 'searxng', searxngUrl: local },
      signal,
    );
    expect(sources.map((source) => source.url)).toEqual([
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3',
      'https://a.example/4',
      'https://b.example/5',
    ]);
    expect(fetch.mock.calls[0][0]).toBe(
      `${local}/search?q=alpha+topic&format=json`,
    );
    expect(fetch.mock.calls.map(([url]) => new URL(url).origin)).toEqual([
      local,
      local,
    ]);
  });

  it('sends the Exa key only in the header to the Exa search endpoint', async () => {
    const fetch = vi.fn(async () => exaResponse(exaHit()));
    vi.stubGlobal('fetch', fetch);
    const sources = await searchSources(
      { objective: 'Compare topics' },
      { webSearchProvider: 'exa', exaApiKey: exaKey },
      signal,
    );
    expect(sources).toEqual([
      {
        title: 'Evidence',
        url: 'https://example.com',
        text: 'Verified highlight.',
      },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.exa.ai/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(exaKey);
    expect(JSON.parse(String(init.body)).query).toBe('Compare topics');
    expect(String(init.body)).not.toContain(exaKey);
  });

  it('reports Exa rejection and rate limits without echoing the key', async () => {
    const config = { webSearchProvider: 'exa' as const, exaApiKey: exaKey };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(`bad key ${exaKey}`, { status: 401 })),
    );
    const rejected = await searchSources(
      { objective: 'Research' },
      config,
      signal,
    ).catch((error: Error) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toContain('rejected EXA_API_KEY');
    expect((rejected as Error).message).not.toContain(exaKey);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })),
    );
    await expect(
      searchSources({ objective: 'Research' }, config, signal),
    ).rejects.toThrow('rate limit');
  });

  it('reports an unreachable instance and a refused JSON format honestly', async () => {
    const config = { webSearchProvider: 'searxng' as const, searxngUrl: local };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );
    await expect(
      searchSources({ objective: 'Research' }, config, signal),
    ).rejects.toThrow('unreachable');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })),
    );
    await expect(
      searchSources({ objective: 'Research' }, config, signal),
    ).rejects.toThrow('json format');
  });

  it('fails visibly when the engine finds no usable source', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(searxResponse()));
    await expect(
      searchSources(
        { objective: 'Research' },
        { webSearchProvider: 'searxng', searxngUrl: local },
        signal,
      ),
    ).rejects.toThrow('found no usable sources');
  });

  it('sends no request when cancelled, not a search engine, or unconfigured', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchSources(
        { objective: 'Research' },
        { webSearchProvider: 'searxng', searxngUrl: local },
        controller.signal,
      ),
    ).rejects.toThrow();
    await expect(
      searchSources(
        { objective: 'Research' },
        { webSearchProvider: 'disabled' },
        signal,
      ),
    ).rejects.toThrow('not a search engine');
    await expect(
      searchSources(
        { objective: 'Research' },
        { webSearchProvider: 'searxng' },
        signal,
      ),
    ).rejects.toThrow('SEARXNG_URL');
    await expect(
      searchSources(
        { objective: 'Research' },
        { webSearchProvider: 'exa' },
        signal,
      ),
    ).rejects.toThrow('EXA_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('research with local and optional search', () => {
  const live = {
    mode: 'live' as const,
    apiKey: 'model-key',
    model: 'test-model',
    baseUrl: model,
  };

  it('grounds a topic brief in SearxNG snippets and contacts only local search and the model', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith(local)
        ? searxResponse(hit('https://example.com', 'Verified snippet.'))
        : modelResponse('Cited brief.'),
    );
    vi.stubGlobal('fetch', fetch);
    const output = await research(
      'Compare research methods',
      [],
      { ...live, webSearchProvider: 'searxng', searxngUrl: local },
      signal,
      () => {},
    );
    expect(output.text).toBe('Cited brief.');
    expect(output.sources).toEqual([
      {
        title: 'Evidence',
        url: 'https://example.com',
        excerpt: 'Verified snippet.',
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => new URL(url).origin)).toEqual([
      local,
      'https://model.example',
    ]);
    expect(
      JSON.parse(String(fetch.mock.calls[1][1]?.body)).messages[1].content,
    ).toContain('Verified snippet.');
  });

  it('returns the same research output shape when Exa is explicitly selected', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith('https://api.exa.ai')
        ? exaResponse(exaHit('https://example.com', 'Verified highlight.'))
        : modelResponse('Cited brief.'),
    );
    vi.stubGlobal('fetch', fetch);
    const output = await research(
      'Compare research methods',
      [],
      { ...live, webSearchProvider: 'exa', exaApiKey: exaKey },
      signal,
      () => {},
    );
    expect(output.text).toBe('Cited brief.');
    expect(output.sources).toEqual([
      {
        title: 'Evidence',
        url: 'https://example.com',
        excerpt: 'Verified highlight.',
      },
    ]);
    expect(fetch.mock.calls.map(([url]) => new URL(url).origin)).toEqual([
      'https://api.exa.ai',
      'https://model.example',
    ]);
  });

  it('records that supplied URLs are not read by the search engine', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.startsWith(local)
        ? searxResponse(hit())
        : modelResponse('Topic brief.'),
    );
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    const output = await research(
      'Summarize https://example.com',
      [],
      { ...live, webSearchProvider: 'searxng', searxngUrl: local },
      signal,
      progress,
    );
    expect(output.text).toContain('Supplied URLs were not read');
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining('Supplied URLs were not read'),
    );
  });

  it('reports search unavailable when nothing is configured, without contacting any provider', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      research(
        'Research',
        [],
        { ...live, exaApiKey: exaKey },
        signal,
        () => {},
      ),
    ).rejects.toThrow('Web search is disabled');
    await expect(
      research(
        'Research',
        [],
        { ...live, webSearchProvider: 'disabled' },
        signal,
        () => {},
      ),
    ).rejects.toThrow('Web search is disabled');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('no Parallel search provider', () => {
  it('keeps the former search host and key out of code, configuration and docs', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const extensions = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.md',
      '.yml',
      '.example',
    ]);
    const listFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return listFiles(path);
        return extensions.has(extname(name)) || name === '.env.example'
          ? [path]
          : [];
      });
    const files = [
      ...listFiles(join(root, 'src')),
      ...listFiles(join(root, 'docs')),
      join(root, '.env.example'),
      join(root, 'compose.yml'),
      join(root, 'README.md'),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('parallel.ai');
      expect(text, file).not.toContain('PARALLEL_API_KEY');
    }
  });
});
