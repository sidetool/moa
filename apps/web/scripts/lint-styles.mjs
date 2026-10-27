import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compile } from 'sass';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const lintRequire = createRequire(path.join(root, 'tools/design-lint/package.json'));
const directory = await mkdtemp(path.join(tmpdir(), 'moa-style-lint-'));
try {
  // Lint emitted CSS so Sass syntax never bypasses the existing design checks.
  for (const [source, output] of [
    ['apps/web/src/styles/base.scss', 'base.css'],
    ['apps/web/design-system/_document.scss', 'document.css'],
  ]) await writeFile(path.join(directory, output), compile(path.join(root, source), { charset: false }).css);
  await writeFile(path.join(directory, 'lint.json'), await readFile(path.join(root, 'spec/design-system/lint.json')));
  const result = spawnSync(process.execPath, [lintRequire.resolve('tsx/cli'), path.join(root, 'tools/design-lint/design_lint.ts'), '--root', directory, '--config', 'lint.json', '--format', 'json', '--strict'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
