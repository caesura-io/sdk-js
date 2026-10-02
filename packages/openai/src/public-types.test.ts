import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
it('typechecks consumer calls against the built package declarations', () => {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'es2022',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      fileURLToPath(new URL('../type-tests/consumer.ts', import.meta.url)),
    ],
    { encoding: 'utf8' },
  );
  expect(result.stdout + result.stderr).toBe('');
  expect(result.status).toBe(0);
});
