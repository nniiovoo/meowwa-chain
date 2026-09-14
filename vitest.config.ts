import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `@meowwa/chain-domain` is a workspace package whose published entry point is its build output.
 * Pointing the alias at the TypeScript source keeps `npm test` from silently exercising a stale
 * `dist/` — or failing outright before the first build.
 */
const chainDomain = fileURLToPath(new URL('./packages/chain-domain/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@meowwa/chain-domain': chainDomain },
  },
  test: {
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Matches the private application's API suite. The migration-convergence tests spawn real
    // subprocesses against a shared SQLite file, which does not fit in the 5s default.
    testTimeout: 20_000,
  },
});
