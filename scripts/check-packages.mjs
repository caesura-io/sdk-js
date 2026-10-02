import process from 'node:process';
// Clean consumer installation: only tarballs and public dependencies are visible.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'caesura-packages-'));
const [openai = '7', ai = '7'] = process.argv.slice(2);
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  for (const pkg of ['core', 'openai', 'ai-sdk']) {
    run(
      'pnpm',
      ['pack', '--pack-destination', temporary],
      resolve(root, 'packages', pkg),
    );
  }
  writeFileSync(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  const archives = readdirSync(temporary)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(temporary, name));
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...archives,
    `openai@${openai}`,
    `ai@${ai}`,
    'typescript@5.9.3',
    '@types/json-schema',
    '@types/node@22',
  ]);
  // Log exact resolutions when matrix selectors such as "5" move forward.
  run('npm', ['ls', '--depth=0']);
  const consumer = readFileSync(
    join(root, 'packages/openai/type-tests/consumer.ts'),
    'utf8',
  ).replace("'../dist/index.js'", "'@caesura-io/openai'");
  const extra = readFileSync(
    join(root, 'scripts/fixtures/consumer.ts'),
    'utf8',
  );
  for (const extension of ['mts', 'cts']) {
    writeFileSync(
      join(temporary, `consumer.${extension}`),
      consumer + '\n' + extra,
    );
    run(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      `consumer.${extension}`,
    ]);
  }
  copyFileSync(
    join(root, 'scripts/fixtures/runtime.mjs'),
    join(temporary, 'runtime.mjs'),
  );
  run(process.execPath, ['runtime.mjs']);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
