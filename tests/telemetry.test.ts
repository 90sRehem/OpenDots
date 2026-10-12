import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const platformUrl = new URL('../src/server/platform.ts', import.meta.url).href;
const storeUrl = new URL('../src/server/store.ts', import.meta.url).href;
const workspaceUrl = new URL('../src/server/workspace.ts', import.meta.url)
  .href;
const conversationStoreUrl = new URL(
  '../src/server/conversation-store.ts',
  import.meta.url,
).href;
const tsxUrl = import.meta.resolve('tsx');

it('keeps runtime chat egress off CopilotKit telemetry hosts', async () => {
  const probe = `
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return new Response('{"ok":true}', { status: 202 });
};
const { Platform } = await import(${JSON.stringify(platformUrl)});
const { Store } = await import(${JSON.stringify(storeUrl)});
const { WorkspaceStore } = await import(${JSON.stringify(workspaceUrl)});
const { ConversationStore } = await import(${JSON.stringify(conversationStoreUrl)});
const store = new Store(':memory:');
const workspace = new WorkspaceStore(':memory:', 'fixture-owner');
const conversationStore = new ConversationStore(':memory:');
try {
  const platform = new Platform(store, workspace, {
    baseUrl: '', runtimeUrl: '', voiceName: 'marin',
  }, conversationStore);
  const dot = workspace.dots()[0];
  workspace.bindThread('fixture-thread', dot.id, 'Fixture');
  await platform.handler.fetch(new Request('http://localhost/api/copilotkit/info'));
  console.log(JSON.stringify(requests));
} finally {
  store.close();
  workspace.close();
  conversationStore.close();
}
`;
  const { stdout } = await run(
    process.execPath,
    ['--import', tsxUrl, '--input-type=module', '--eval', probe],
    { env: { ...process.env, DO_NOT_TRACK: '0' }, timeout: 15000 },
  );
  const requests: string[] = JSON.parse(
    stdout.trim().split('\n').at(-1) ?? '[]',
  );
  expect(requests).toEqual([]);
});
