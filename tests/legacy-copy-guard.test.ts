import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Dead hosted-service residue must not return to shipped copy, docs, SQL, source or
// compose files. Tests are not scanned: legacy-absence checks name the old key on purpose.
const root = fileURLToPath(new URL('..', import.meta.url));
const topLevel = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  '.env.example',
  'Dockerfile',
  'compose.yml',
  'compose.computers.yml',
  'compose.computers-app.yml',
];
const directories = ['docs', 'deployment', 'src'];
const textFile =
  /\.(md|sql|ts|tsx|js|json|ya?ml|html|css|txt)$|\.example$|^Dockerfile$/;

async function textFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? textFilesUnder(path)
        : textFile.test(entry.name)
          ? [path]
          : [];
    }),
  );
  return nested.flat();
}

it('keeps the hosted-service name out of shipped copy, docs, SQL, source and compose files', async () => {
  const paths = [
    ...topLevel.map((name) => join(root, name)),
    ...(
      await Promise.all(
        directories.map((name) => textFilesUnder(join(root, name))),
      )
    ).flat(),
  ];
  const offenders: string[] = [];
  for (const path of paths) {
    try {
      if (/intelligence/i.test(await readFile(path, 'utf8')))
        offenders.push(relative(root, path));
    } catch (error) {
      // A top-level file that does not exist in this checkout is not residue.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  expect(offenders).toEqual([]);
});
