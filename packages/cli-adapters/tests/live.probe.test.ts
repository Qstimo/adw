import { expect, it } from 'vitest';
import { CodexAdapter, ClaudeCodeAdapter } from '../src/index.js';
for (const Adapter of [CodexAdapter, ClaudeCodeAdapter]) {
  const adapter = new Adapter();
  it.runIf(process.env.ADW_LIVE_CLI === '1')(`${adapter.id}: local version/help capability probe (no model request)`, async context => {
    let found;
    try { found = await adapter.discover(); }
    catch (error) {
      if (String(error).includes('Executable not found')) { context.skip(); return; }
      throw error;
    }
    const capabilities = await adapter.probeCapabilities(found.version);
    expect(capabilities.agentId).toBe(adapter.id);
    console.log(JSON.stringify({ ...found, capabilities }));
  }, 20_000);
}
