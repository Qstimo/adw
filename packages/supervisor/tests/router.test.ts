import { expect, it } from 'vitest';
import { routeAgent, type RouteCandidate } from '../src/router.js';
import { capability } from './helpers.js';
const candidate = (agentId: string): RouteCandidate => ({ agentId, capabilities: capability(agentId), available: true, costEstimate: 0.5, locality: 0.5, risk: 0.5, quality: 0.5 });
it('eliminates unsupported or unknown hard constraints before score and hints', () => {
    const bad = candidate('bad');
    bad.capabilities.execution.headless = 'unknown';
    bad.quality = 1;
    const good = candidate('good');
    const result = routeAgent([bad, good], {}, 'bad');
    expect(result.agentId).toBe('good');
    expect(result.eliminated[0]!.reasons).toContain('headless: unknown');
    good.capabilities.usage.cost = 'unsupported';
    expect(() => routeAgent([good], { cost: true })).toThrow('No eligible');
});
it('scores fit deterministically and exposes every routing factor', () => {
    const a = candidate('a'), b = candidate('b');
    b.locality = 1;
    b.risk = 0;
    b.costEstimate = 0;
    const result = routeAgent([a, b]);
    expect(result.agentId).toBe('b');
    expect(result.reasons.join(' ')).toContain('cost=0');
    expect(routeAgent([candidate('b'), candidate('a')]).agentId).toBe('a');
});
it('refuses unavailable agents and malformed scoring inputs', () => {
    const a = candidate('a');
    a.available = false;
    expect(() => routeAgent([a])).toThrow('Unavailable');
    a.available = true;
    a.risk = NaN;
    expect(() => routeAgent([a])).toThrow('normalized');
});
