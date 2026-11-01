import { CapabilityManifestSchema, type CapabilityManifest } from '@adw/contracts';
export interface RouteCandidate {
    agentId: string;
    capabilities: CapabilityManifest;
    available: boolean;
    costEstimate: number;
    locality: number;
    risk: number;
    quality: number;
}
export interface RouteRequirements {
    tokens?: boolean;
    cost?: boolean;
    resume?: boolean;
}
export interface RouteResult {
    agentId: string;
    score: number;
    reasons: string[];
    eliminated: {
        agentId: string;
        reasons: string[];
    }[];
}
export function routeAgent(candidates: readonly RouteCandidate[], requirements: RouteRequirements = {}, hint?: string): RouteResult {
    const eligible: {
        agentId: string;
        score: number;
        reasons: string[];
    }[] = [], eliminated: RouteResult['eliminated'] = [];
    const ids = new Set<string>();
    for (const candidate of candidates) {
        const c = CapabilityManifestSchema.parse(candidate.capabilities);
        if (ids.has(candidate.agentId) || candidate.agentId !== c.agentId)
            throw new Error('Duplicate or inconsistent routing agent ID');
        ids.add(candidate.agentId);
        for (const value of [candidate.costEstimate, candidate.locality, candidate.risk, candidate.quality])
            if (!Number.isFinite(value) || value < 0 || value > 1)
                throw new Error('Routing metrics must be normalized to [0,1]');
        const reasons: string[] = [];
        for (const [name, value] of [['headless', c.execution.headless], ['cwd', c.execution.cwd], ['finalStatus', c.output.finalStatus], ['errors', c.output.errors], ['cancel', c.control.cancel], ['timeout', c.control.timeout], ['processTreeCleanup', c.control.processTreeCleanup], ...(requirements.tokens ? [['tokens', c.usage.tokens]] : []), ...(requirements.cost ? [['cost', c.usage.cost]] : []), ...(requirements.resume ? [['resume', c.session.resume]] : [])])
            if (value !== 'supported')
                reasons.push(`${name}: ${value}`);
        if (!['json', 'jsonl'].includes(c.output.format))
            reasons.push('Structured output required');
        if (!candidate.available)
            reasons.push('Unavailable');
        if (reasons.length) {
            eliminated.push({ agentId: candidate.agentId, reasons });
            continue;
        }
        const score = 40 + candidate.quality * 20 + (1 - candidate.costEstimate) * 15 + candidate.locality * 10 + (1 - candidate.risk) * 10 + (candidate.agentId === hint ? 5 : 0);
        eligible.push({ agentId: candidate.agentId, score, reasons: ['Required capabilities supported', 'Available', `quality=${candidate.quality}`, `cost=${candidate.costEstimate}`, `locality=${candidate.locality}`, `risk=${candidate.risk}`, ...(candidate.agentId === hint ? ['Agent hint +5'] : [])] });
    }
    eligible.sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
    if (!eligible[0])
        throw new Error(`No eligible agent: ${JSON.stringify(eliminated)}`);
    return { ...eligible[0], eliminated };
}
