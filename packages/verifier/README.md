# Verifier: commands, API smoke и browser observations

VerifierRunner запускает заданные checks в task worktree. Required failure или notVerified блокирует readyForReview; optional failure сохраняется с предупреждением. Supervisor дополнительно фиксирует committed snapshot до/после checks и требует независимый review. Media не заменяют проверку всех требований.

## Команды и web pipeline

```ts
import { EvidenceStore, VerifierRunner } from '@adw/verifier';

const verifier = new VerifierRunner(new EvidenceStore('/external/data/evidence'));
const run = await verifier.run({
  worktreePath, baseCommit,
  checks: [
    { name: 'typecheck', command: 'pnpm typecheck', blocking: true },
    { name: 'unit', command: 'pnpm test', blocking: true },
  ],
  acceptance: ['Health responds correctly', 'Go shows ready'],
  web: {
    enabled: true,
    server: { command: 'pnpm start:demo', timeoutMs: 10000 },
    apiSmoke: {
      enabled: true,
      requests: [{ title: 'health', path: '/health', jsonShape: { ok: 'boolean' } }],
    },
    playwright: {
      enabled: true,
      scenarios: [{ title: 'click', path: '/', steps: [
        { action: 'click', selector: '#go' },
        { action: 'text', selector: '#status', expected: 'ready' },
      ] }],
    },
    acceptance: [
      { id: 'api.health', acceptanceIndex: 0, required: true, tests: ['health'] },
      { id: 'web.button', acceptanceIndex: 1, required: true, tests: ['click'] },
    ],
  },
});
```

Web config также поддерживается в `AdwConfig.verifier.web`. Вызывающий core явно передаёт её в `Supervisor.run({..., web: config.verifier.web})` или GitVerifierFacade. Supervisor копирует policy до запуска агента; изменённый агентом acceptanceMap не перечитывается поверх утверждённой конфигурации.

Порядок: исходные command checks → managed app health / external HTTP reachability → API smoke → browser → acceptance linkage → independent review. При failed required command приложение и web scenarios не запускаются. Должна существовать хотя бы одна обязательная проверка/критерий: optional-only наблюдения не обходят этот gate. Имена web_environment/api_smoke/playwright_e2e/web_acceptance зарезервированы.

Managed server должен оставаться foreground process и печатать `ADW_READY http://127.0.0.1:<port>` после bind. Demo поддерживает PORT (5179 по умолчанию, 0 — ephemeral); verifier задаёт PORT=0, если caller не передал другой. Readiness poll проверяет /health или server.readyUrl. Non-loopback marker отклоняется. Unexpected exit/timeout/cancellation прекращают web job; finally останавливает процесс. Можно вместо managed server задать baseUrl: тогда сначала проверяется HTTP reachability, конкретные status/schema/UI проверяются отдельными сценариями.

Все URL — HTTP(S) без embedded credentials, scenario paths — same-origin. API использует GET, ожидаемый status (default 200), необязательный flat jsonShape по типам полей. Это не универсальный JSON Schema validator. Redirect автоматически не следует; body ограничен 64 KiB. Credential headers не сохраняются, отражённые значения известных auth/cookie/token headers маскируются; URL query не записывается в metadata/audit.

## Playwright worker и evidence

Изолированный Node worker использует Playwright Core, Chromium и отдельный browser context на scenario. JSON DSL поддерживает click, visible и точный text с ожиданием; произвольный JS из task config не выполняется. Это bounded worker, а не @playwright/test runner / произвольный .spec.ts launcher.

Каждый наблюдённый сценарий сохраняет viewport PNG, DOM HTML, console и network metadata. Для failed scenario сохраняется WebM; success video удаляется. Неуспешная media capture или отсутствие обязательных artifacts дают notVerified. Console errors по умолчанию проваливают сценарий. Обычные browser HTTP requests ограничены base origin, service workers отключены; это не универсальная OS/network sandbox.

Evidence хранится вне task worktree в SHA-256 CAS. CheckResult содержит kind, command, exitCode, duration, environmentFingerprint, artifactRefs, coverage/notVerified и evidenceManifestRef. Первые три refs остаются stdout/stderr/metadata для обратной совместимости; четвёртый у web checks — manifest. JSON manifest содержит `proves: "scenario_observation"`, MIME/role/scenario каждого artifact и observed outcomes. Это не full_correctness proof. Runtime metadata сохраняет Playwright/browser version и executable path, когда они доступны; fingerprint browser check включает runtime.

Collector принимает только bounded regular files внутри своего временного каталога, отклоняет symlinks/traversal и проверяет PNG/WebM signatures. Limits: report 1 MiB, artifact 16 MiB, суммарно 32 MiB/check; DOM 1 MiB; console/network до 500 records и 64 KiB вместе. При превышении наблюдение не сертифицируется. Profile/video/output каталоги находятся вне Git patch и удаляются после CAS import.

Worker/server processes ограничены timeout/output budget. Linux cleanup учитывает descendants с отдельной process group (так запускается Chromium). Это проверено на собственных тестовых процессах; OS RAM/CPU isolation и daemon recovery остаются отдельной политикой. HTTP/browser failures не превращаются в passed из-за отсутствующего браузера, encoder или sandbox permissions.

DOM, screenshots и application logs сохраняют наблюдаемое приложение: используйте контролируемые тестовые данные. Сетевые evidence не включают auth headers, cookies или request bodies; это не обещание автоматического удаления любых секретов с экрана приложения.

## Acceptance linkage

`acceptanceMap.json` связывает уникальный criterion id с точными test titles и при необходимости индексом в immutable TaskSpec.acceptance. При переданном spec required criterion обязан иметь допустимый acceptanceIndex; исходную acceptance clause нельзя перевести в optional. Дополнительные optional observations не получают индекс исходного обязательного требования.

Missing map, пустой tests[] и отсутствующий/неисполненный scenario дают notVerified. Известный required failure блокирует ready; optional остаётся failed/notVerified в coverage и warnings. Runtime interruption также блокирует общий gate. Карта описывает выбранные сценарии; она не доказывает семантическую полноту всех natural-language требований. Остальные clauses проверяются другими checks и independent review.

Coverage сохраняется как JSON в существующий check_results.coverage; manifest refs — в artifacts_json. Core DB остаётся v5. Context getTestHistory возвращает coverage для будущей matrix UI. `listChangedTestPaths`/review diff отмечают tests/e2e, assertions, acceptanceMap и Playwright config.

## Установка и настоящий demo E2E

В ограниченном окружении registry и global pnpm store недоступны. В repo включён неизменённый npm archive Playwright Core 1.49.1; root postinstall проверяет SHA-256 и атомарно извлекает runtime в игнорируемую .adw. Workspace dependency — local link. Браузеры не скачиваются автоматически. Лицензии/происхождение: [vendor README](../../vendor/README.md).

В обычном терминале/CI, где разрешены local sockets и browser processes:

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm web:pilot
```

Нужны Node.js 22.12+, Git, rg, tar и системные зависимости Chromium. browser:install использует CLI закреплённого runtime и устанавливает соответствующие Chromium/FFmpeg. ADW_CHROMIUM_EXECUTABLE позволяет явно выбрать executable; соответствующий video encoder всё равно необходим. Текущая совместимость с другим browser binary здесь не подтверждена.

web:pilot создаёт отдельный временный demo repo: настоящий typecheck/unit → управляемый HTTP server → API/schema → browser click/assertions/media → independent fake code/security sessions. Печатает state, webChecks/coverage, diagnostic excerpts, evidence/journal paths. Exit 0 только после полного configured gate и review. ADW_DEMO_RED_WEB=1 включает заведомо неправильный demo status для красного сценария. Никаких модельных запросов и automatic accept нет.

В текущем sandbox native `listen` и Chromium `setsockopt` возвращают EPERM. Поэтому настоящий web gate пока не пройден; зелёные unit/protocol tests с synthetic transports его не заменяют. `pnpm pilot` остаётся отдельным headless pilot этапа 06 без web gate.
