import { z } from 'zod';
const httpUrl = z.string().url().refine(value => {
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    }
    catch {
        return false;
    }
}, 'Expected an HTTP(S) URL without embedded credentials');
const name = z.string().trim().min(1).max(200);
const timeout = z.number().int().min(1).max(2147483647);
const path = z.string().startsWith('/').max(2048).refine(value => !value.startsWith('//') && !value.includes('\\') && !value.includes('\0'), 'Expected a same-origin path');
export const AcceptanceCriterionSchema = z.object({ id: name, acceptanceIndex: z.number().int().nonnegative().optional(), required: z.boolean().default(true), tests: z.array(name).max(100) }).strict();
export const AcceptanceCoverageSchema = z.object({ id: name, acceptanceIndex: z.number().int().nonnegative().optional(), required: z.boolean(), status: z.enum(['passed', 'failed', 'not_verified']), notVerified: z.boolean(), tests: z.array(name), reason: z.string().optional() }).strict();
const jsonShape=z.custom<Record<string,unknown>>(value=>value!==null&&typeof value==='object'&&!Array.isArray(value)).transform(value=>Object.entries(value)).pipe(z.array(z.tuple([z.string().max(1024),z.enum(['string','number','boolean','object','array','null'])])).max(1000)).transform(entries=>Object.fromEntries(entries));
export const ApiRequestSchema = z.object({ title: name, path, expectedStatus: z.number().int().min(100).max(599).default(200), headers: z.record(z.string().max(8192)).default({}), jsonShape: jsonShape.optional() }).strict();
export const BrowserStepSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('click'), selector: z.string().min(1).max(2000) }).strict(),
    z.object({ action: z.literal('text'), selector: z.string().min(1).max(2000), expected: z.string().max(64000) }).strict(),
    z.object({ action: z.literal('visible'), selector: z.string().min(1).max(2000) }).strict(),
]);
export const BrowserScenarioSchema = z.object({ title: name, path, steps: z.array(BrowserStepSchema).min(1).max(100) }).strict();
export const WebVerificationSchema = z.object({
    enabled: z.boolean().default(false), baseUrl: httpUrl.optional(), timeoutMs: timeout.default(60000),
    server: z.object({ command: z.string().trim().min(1).max(64000), readyUrl: httpUrl.optional(), timeoutMs: timeout.default(10000) }).strict().optional(),
    apiSmoke: z.object({ enabled: z.boolean().default(false), blocking: z.boolean().default(true), requests: z.array(ApiRequestSchema).max(100), timeoutMs: timeout.default(10000) }).strict().optional(),
    playwright: z.object({ enabled: z.boolean().default(false), blocking: z.boolean().default(true), scenarios: z.array(BrowserScenarioSchema).max(100), timeoutMs: timeout.default(30000), browserExecutable: z.string().min(1).optional(), failOnConsoleError: z.boolean().default(true) }).strict().optional(),
    acceptance: z.array(AcceptanceCriterionSchema).max(100).default([]),
}).strict().superRefine((value, ctx) => {
    if (!value.enabled)
        return;
    if (!value.baseUrl && !value.server)
        ctx.addIssue({ code: 'custom', message: 'Web checks require a base URL or managed server' });
    if (!value.apiSmoke?.enabled && !value.playwright?.enabled)
        ctx.addIssue({ code: 'custom', message: 'Enable at least one web check' });
    if (value.apiSmoke?.enabled && !value.apiSmoke.requests.length || value.playwright?.enabled && !value.playwright.scenarios.length)
        ctx.addIssue({ code: 'custom', message: 'Enabled checks require scenarios' });
    const titles = [...(value.apiSmoke?.requests.map(request => request.title) ?? []), ...(value.playwright?.scenarios.map(scenario => scenario.title) ?? [])];
    if (new Set(titles).size !== titles.length || new Set(value.acceptance.map(criterion => criterion.id)).size !== value.acceptance.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate test titles or acceptance IDs' });
    for (const criterion of value.acceptance)
        if (criterion.acceptanceIndex !== undefined && !criterion.required)
            ctx.addIssue({ code: 'custom', message: 'A locked acceptance clause cannot be made optional' });
});
export type WebVerification = z.infer<typeof WebVerificationSchema>;
export type WebVerificationInput = z.input<typeof WebVerificationSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type AcceptanceCoverage = z.infer<typeof AcceptanceCoverageSchema>;
export type ApiRequest = z.infer<typeof ApiRequestSchema>;
export type BrowserScenario = z.infer<typeof BrowserScenarioSchema>;
