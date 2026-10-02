import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Exercise the pnpm -> npm handoff used by Changesets, including its pnpm-only
// flag. Dry-run avoids uploading; the loopback registry adds an independent guard.
for (const name of ['core', 'openai', 'ai-sdk']) {
  execFileSync(
    'pnpm',
    [
      'publish',
      '--dry-run',
      '--no-git-checks',
      '--access',
      'public',
      '--tag',
      'latest',
      '--registry',
      'http://127.0.0.1:9',
    ],
    {
      cwd: fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)),
      stdio: 'inherit',
      // Recent npm versions check package metadata even during a dry-run.
      env: { ...process.env, npm_config_fetch_retries: '0' },
    },
  );
}
