import process from 'node:process';
import assert from 'node:assert/strict';
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
  // Inspect the exact publication boundary before a consumer can hide packaging errors.
  for (const archive of archives) {
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .trim()
      .split('\n');
    for (const name of names)
      assert.match(
        name,
        /^package\/(?:dist\/[^/]+|package\.json|README\.md|LICENSE)$/,
      );
    for (const entry of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts'])
      assert(
        names.includes(`package/dist/${entry}`),
        `Missing packaged entry: ${entry}`,
      );
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', archive, 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    const folder = manifest.name.split('/').at(-1);
    const source = JSON.parse(
      readFileSync(join(root, 'packages', folder, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.version, source.version);
    assert(!JSON.stringify(manifest).includes('workspace:'));
    if (folder !== 'core') {
      const core = JSON.parse(
        readFileSync(join(root, 'packages/core/package.json'), 'utf8'),
      );
      assert.equal(manifest.dependencies['@caesura-io/core'], core.version);
    }
  }
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
  copyFileSync(
    join(root, 'scripts/fixtures/lifecycle.mjs'),
    join(temporary, 'lifecycle.mjs'),
  );
  copyFileSync(
    join(root, 'scripts/fixtures/identity.mjs'),
    join(temporary, 'identity.mjs'),
  );
  copyFileSync(
    join(root, 'scripts/fixtures/review.mjs'),
    join(temporary, 'review.mjs'),
  );
  copyFileSync(
    join(root, 'scripts/fixtures/audit-cancellation.mjs'),
    join(temporary, 'audit-cancellation.mjs'),
  );
  for (const fixture of [
    'skill-prompt.mjs',
    'skill-prompt-contract.mjs',
    'transcript-policy.mjs',
    'participant-role-contract.mjs',
    'failure-policy.mjs',
    'failure-policy-contract.mjs',
  ]) {
    copyFileSync(
      join(root, 'scripts/fixtures', fixture),
      join(temporary, fixture),
    );
  }
  run(process.execPath, ['skill-prompt.mjs']);
  run(process.execPath, ['audit-cancellation.mjs']);
  run(process.execPath, ['transcript-policy.mjs']);
  run(process.execPath, ['failure-policy.mjs']);
  run(process.execPath, ['runtime.mjs']);
  run(process.execPath, ['identity.mjs']);
  run(process.execPath, ['review.mjs']);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
