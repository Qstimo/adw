# Supervisor и Independent Review — этапы 05–06

`@adw/supervisor` управляет утверждённой задачей: spec lock → DAG → маршрутизация → CLI session → независимые checks → исправления → независимые code/security review → ручное решение. Пакет не вызывает модели для планирования: по умолчанию используется один узел с intent задачи, альтернативный DAG задаёт вызывающий core.

## Подключение

Нужны Node.js 22.12+, Git, rg, установленные workspace dependencies и основная DB после `migrate(db)` до v5. Сервисы экспортируют TypeScript для TS-loader/bundler.

```ts
import { confirmSpec, readSpec, specHash } from '@adw/supervisor';
import { createSupervisor } from '@adw/core';

// Покажите пользователю именно этот preview и hash; вызывайте confirm после его утверждения.
const preview = readSpec(db, taskId);
const expectedSpecHash = specHash(preview);
confirmSpec(db, { taskId, expectedSpecHash, approvedBy: 'local-user' });

const supervisor = createSupervisor({
  db, manager, verifier, adapters, dataDir: '/external/workstation-data',
});
const controller = new AbortController();
const result = await supervisor.run({
  taskId,
  checks: [{ name: 'unit', command: 'pnpm test', blocking: true }],
  limits: {
    wallTimeMs: 120_000,
    sessionTimeoutMs: 60_000,
    bundleTokens: 8000,
    maxFixCycles: 3,
  },
  signal: controller.signal,
});
```

DB должна содержать project и draft task. `confirmSpec` проверяет hash текущего spec, сохраняет точные intent/acceptance/outOfScope/base и утверждающего actor, возвращает deep-frozen copy и пишет аудит. SQL triggers блокируют последующую замену утверждённых полей и удаление истории. Повторное подтверждение идентично; старый preview отклоняется. Это API для доверенного core: строка actor не является удалённой authentication-проверкой. Старые locked tasks без supervisor spec автоматически утверждёнными не считаются.

`createSupervisor` связывает ProjectIndexer/ContextFacade с зарегистрированной task worktree. Индекс, bundle CAS, verification evidence и DB находятся вне пользовательского checkout. Агент получает CAS bundlePath; файл не добавляется в Git patch. Перед каждой попыткой обновляется индекс. Рабочая копия и evidence сохраняются при ошибке для диагностики; автоматического удаления пользовательской работы нет.

## Переходы и проверки

Машина состояний — чистый reducer `transition`. `completed` от исполнителя переводит задачу только в `verifying`. Готовность даёт Supervisor после реального VerifierRunner, сравнения чистого committed patch snapshot до/после checks и прохождения всех узлов. После этого обязательны две независимые review sessions. Агент обязан закоммитить изменения: dirty/untracked состояние не проходит capture. Прежний GitVerifierFacade не может захватить задачу с активным supervisor run.

Состояния spec_pending_approval/planning/scheduled/fix_needed существуют в reducer; task.status сохраняет совместимые доменные значения. Итог `ready_for_human_review` отображается в DB как `ready_for_review`. Автоматического accept/merge нет. Reviewer этапа 06 подключён; до ready обязателен approved verdict обеих passes. Web verification (07) подключается опционально через web policy; его реальный gate в текущем sandbox ещё не пройден. Desktop UI (08) ещё не подключён; общий Definition of Done пока не завершён.

DAG: 1..100 уникальных узлов `{id, dependsOn, instruction, agentHint?}`. Циклы, отсутствующие и повторные зависимости отклоняются до запуска. Scheduler использует один узел за раз в общей task worktree: следующие узлы видят результаты предыдущих. Независимые ready nodes отражаются в аудите через `wouldParallelize`; параллельные worktrees/integration относятся к этапу 09. Экземпляр Supervisor выполняет один run, DB claim и unique active-task index защищают от второго процесса. Отозванный run не перезаписывает нового владельца.

Router сначала требует supported headless/cwd/finalStatus/errors/cancel/timeout/processTreeCleanup и JSON/JSONL output. Unknown не считается supported. При заданном maxTokens/maxCost нужны соответствующие usage capabilities. Затем score учитывает нормализованные quality/cost/locality/risk и слабый agentHint; availability — обязательное условие. Все решения/исключения журналируются. По умолчанию metrics нейтральные; это policy estimates, не измеренная история качества или стоимость. Проверенный process-tree cleanup сейчас поддерживается на Linux; неизвестная поддержка других ОС блокирует назначение.

## Исправления, бюджеты и отмена

После красного check формируется immutable feedback JSON с результатами, fingerprint, оригинальными evidence refs и путями stdout/stderr. До 256 KiB исходного вывода включается inline (UTF-8 или lossless base64); большие данные доступны целиком по путям, с явным inlineOmitted. Feedback свыше 512 KiB передаётся ссылкой на полный JSON. Ошибки не пересказываются. Новая сессия того же агента получает feedback и обновлённый bundle; автоматический resume не используется.

Допускается максимум три fix cycles после исходной попытки для всего run. Два одинаковых failure fingerprints или исчерпание циклов дают `needs_human`. Fingerprint включает check name/command/exit/notVerified и stdout/stderr hashes, исключая время и metadata ref. Выбранная стратегия при повторе — эскалация; автоматическая смена агента пока не включена.

Общий deadline включает orchestration, probes, session и checks. AbortSignal передаётся в CLI discovery/help/session и VerifierRunner; активные subprocess trees останавливаются. Per-check timeout/output limit останавливает suite и весь run без новых проверок/попыток. Git helper и синхронные SQLite/AST операции не прерываются AbortSignal: завершение ожидается, затем запрещается следующий этап. Это не жёсткий OS deadline для CPU/FS операций.

`maxTokens`/`maxCost` — необязательные лимиты по telemetry CLI. Usage трактуется как накопительный счётчик сессии, между сессиями суммируется; `usageComplete` отдельно показывает отсутствие token/cost telemetry хотя бы в одной сессии, поэтому счётчик 0 не означает измеренный нулевой расход; при достижении лимита run останавливается. При отсутствии обещанной telemetry результат не проверяется и не объявляется готовым. Провайдеры могут сообщать usage только в конце: уже потраченные токены/стоимость невозможно ограничить заранее или отменить. `bundleTokens` — отдельная приблизительная оценка Context Broker; критерии не усекаются при overBudget.

Run/state/DAG, маршрутизация, события агента, sessions, checks/snapshots, hash-checked diff evidence, feedback refs и финал сохраняются в SQLite/audit. Журнал ограничен 100000 events/16 MiB на session. После аварийного завершения процесса активная lease сохраняется и блокирует повторный запуск; автоматическое восстановление/возобновление не реализовано. Перед ручным восстановлением нужно убедиться, что старые процессы остановлены. Worktree не является OS sandbox.

## Пилот

Из корня workspace:

```bash
pnpm pilot
```

Команда создаёт отдельный временный Git repo из `fixtures/demo-repo`, утверждает только fixture spec, запускает FakePilotAdapter, независимые TypeScript/unit checks и печатает final state, DB path, worktree и `journalPath`. Exit 0 означает `ready_for_human_review`. Артефакты остаются в напечатанном временном каталоге. Зависимости подключаются локальными symlinks, сеть и установленный CLI не используются.

Тест `runPilot({forceRed:true})` запускает настоящий demo unit с `FAIL_UNIT=1` и подтверждает блокировку готовности. Упрощённого environment toggle для live-модели нет: реальные Codex/Claude adapters подключаются явно через `createSupervisor` после утверждения реальной задачи. Никаких авторизованных запросов к моделям в этапе 05 не выполнялось.

## Independent Review

После финальной верификации машина входит в `reviewing`. ReviewEngine (`src/review`) собирает pinned unified diff против base, сведения о rename/binary/test paths и исходный binary-capable patch. SHA-256 должен совпасть с verifiedSnapshot. Git diff helpers/textconv/color отключены; diff и metadata сохраняются в evidence CAS.

Code и security идут последовательно. Для каждой pass создаётся новая reviewer session, предпочтительно на другом eligible adapter. Reviewer никогда не получает resumeSessionId; runtime/provider session identities сравниваются со всеми executor sessions и предыдущим reviewer. `agent_sessions.role` и provenance сохраняются в DB. Budget, timeout и cancellation общие с executor.

Prompt содержит полный immutable spec, diff, точные check outputs (base64), evidence refs, актуальный context bundle и baseline security checklist. Репозиторий/вывод обозначены как недоверенные данные. Ответ — строго `{category:"code"|"security", remarks:[...]}`; markdown fences, лишние поля и собственный verdict не принимаются. Remark: id/category/severity/message, optional relative changed path/range, evidenceRefs и confidence inferred/unverified. Выдуманные refs/paths отклоняются.

`ReviewVerdict` вычисляет framework: blocking → changes_requested; неполная/некорректная review или изменившийся patch → inconclusive; обе полные passes без blocking и с неизменным snapshot → approved. Approved с advisory remarks допускает готовность к решению пользователя. Changes requested проходит через fix_needed в needs_human; inconclusive также эскалируется. Автоматических исправлений по review пока нет. Env-переменная ADW_SKIP_REVIEW не действует.

Review runs и связи замечаний с task findings неизменяемы. Findings сохраняются атомарно с verdict, provenance и refs на review/diff/check evidence. Они не становятся verified или project facts автоматически. Visual category предусмотрена контрактом; browser/visual evidence относится к 07.

Lossless limits: unified diff 512 KiB, check outputs вместе 256 KiB, prompt 1 MiB, response 256 KiB; Git output 4 MiB. Превышение даёт inconclusive без частичного approved. Binary changes перечисляются и сохраняются, но пока требуют дополнительного evidence и блокируют clean approval.

Reviewer role в CLI использует отдельно проверяемые arguments: Codex native read-only sandbox, Claude без built-in tools/MCP/slash commands. Snapshot проверяется до и после каждой pass. Это не универсальная OS/network sandbox или гарантия качества модели; Codex custom integrations требуют собственной политики.

## Ручная приёмка reviewed patch

После показа конкретного approved review и snapshot доверенный core по отдельному действию пользователя вызывает:

```ts
import { acceptReviewedPatch } from '@adw/core';

const receipt = await acceptReviewedPatch({
  db, manager, evidenceStore: verifier.evidenceStore,
  taskId, reviewId: shownReviewId, approvedBy: 'local-user', worktree,
});
```

Функция проверяет completed run, latest approved verdict, CAS proof, session independence и совпадение snapshots. Без явного actor, при blocking/inconclusive или после изменения patch принятие отклоняется. DB claim защищает от конкурентной приёмки; повтор успешного вызова того же review возвращает receipt. Main остаётся на месте, результат — отдельная acceptance-ветка.

`approvedBy` — параметр доверенного приложения, а не authentication-протокол; accept нельзя экспортировать исполнителю. Низкоуровневый `@adw/git.acceptPatch` остаётся Git-примитивом. Продуктовый путь для supervisor tasks использует review-aware facade и SQL guard. Git/SQLite не атомарны вместе: ошибка DB после успешной Git-приёмки оставляет claim для ручного reconcile. Старые runs не получают фиктивный review при миграции.

`pnpm pilot` теперь включает две свежие fake review sessions и approved verdict после настоящих checks; модели не вызываются. Отчёт: [этап 06](../../docs/implementation/06-status.md).

## Web verification policy

`Supervisor.run` принимает `web` (тот же shape, что `AdwConfig.verifier.web`). Policy копируется до запуска агента; required web criterion обязан ссылаться на допустимый индекс locked acceptance, исходную mandatory clause нельзя сделать optional. Передайте только выбранную и проверенную trusted core policy; не перечитывайте её из изменённого worktree поверх утверждённой конфигурации.

После command checks идут app health / HTTP reachability, API smoke, Playwright worker и acceptance linkage; только затем code/security review. Required failed/notVerified web result не даёт review/ready. Web evidence refs и coverage сохраняются в check_results и audit; credentials из web headers/query в audit не попадают. Browser manifests имеют `proves: scenario_observation`, а не full_correctness.

Для полного demo: `pnpm browser:install`, затем `pnpm web:pilot` вне ограничивающего sockets sandbox. SIGINT/SIGTERM CLI передаются в AbortSignal для cleanup foreground server/browser worker. Детали и ограничения: [Verifier README](../verifier/README.md), [gate этапа 07](../../docs/implementation/07-status.md).
