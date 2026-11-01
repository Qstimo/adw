import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AdwConfigSchema } from '@adw/contracts';
import { loadConfig } from '../src/config.js';
it('loads the example config', () => {
 const config = loadConfig(fileURLToPath(new URL('../../../adw.config.example.json', import.meta.url)));
 expect(config.agents).toEqual(['codex', 'claude-code']);
 expect(config.dataDir).toBe('.adw');
});
it('rejects unknown keys, invalid privacy mode and empty verifier', () => {
 const config = { dataDir: '.adw', agents: ['codex'], verifier: { commands: { unit: 'pnpm test' } }, privacyMode: 'cli-subscription' };
 for (const change of [{ unsafe: true }, { privacyMode: 'anything' }, { verifier: { commands: {} } }, { agents: [] }]) expect(AdwConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
});
