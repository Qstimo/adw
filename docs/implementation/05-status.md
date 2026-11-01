# Этап 05 — Supervisor и headless pilot

Дата: 2026-10-31. Реализован план 05 / TASK-10 и §6 ТЗ. Следующий этап — 06: независимый Reviewer.

## Результат

- Новый `@adw/supervisor`: чистый reducer и детерминированные переходы, serial DAG scheduler, объяснимый router и ограниченные исправления. Агентский completed только запускает независимую верификацию.
- Spec lock по hash пользовательского preview: точные intent, acceptance, outOfScope и base, deep-frozen copy, actor/audit. Core DB v4 сохраняет snapshot утверждения; SQL triggers запрещают изменение полей утверждённой задачи и удаление истории. Старые задачи без подтверждения не получают неявного разрешения.
- DAG 1..100 nodes с проверкой уникальности/dependencies/cycles. Выполняется один узел за раз; wouldParallelize записывает потенциальный параллелизм. Вся задача использует одну worktree, чтобы зависимости видели изменения предыдущих узлов.
- Router исключает unsupported/unknown обязательные capabilities и unavailable agents до score. Учитываются quality/cost/locality/risk/hint, сохраняются причины выбора и исключений. При token/cost лимитах обязательна соответствующая telemetry capability.
- Core createSupervisor связывает зарегистрированную task worktree с ProjectIndexer/ContextFacade и CAS bundlePath вне Git patch. Agent обязан закоммитить изменения. Проверяются base drift, project ownership и стабильность committed patch до/после checks; hash diff evidence дополнительно сверяется со snapshot.
- Реальные VerifierRunner checks сохраняют check_results, verification_runs, stdout/stderr/metadata, snapshots и diff в evidence CAS. Зелёный результат всех узлов даёт ready_for_human_review (task.status=ready_for_review). Автоматической приёмки и перемещения main нет.
- Feedback для исправления содержит структурированные результаты, fingerprint, точный вывод или ссылки/пути на оригинальные bytes. Максимум три fix cycles после исходной попытки для всего run; повтор одной ошибки дважды либо исчерпание циклов → needs_human.
- Общий deadline, session timeout, caller cancellation и usage budgets останавливают run. AbortSignal проходит через CLI discovery/version/help/session и verification subprocess trees. Per-check timeout/output limit прекращает suite без следующих checks/исправлений.
- Durable run claim, unique active-task index, session journal и аудит; второй Supervisor и прежний GitVerifierFacade не захватывают уже выполняемую задачу. Отозванная lease не перезаписывается поздним результатом.
- Команда `pnpm pilot`: отдельный временный Git repo из demo fixture, FakePilotAdapter с commit, настоящий typecheck и unit, JSON final state и journalPath. SQLite, worktree и evidence остаются для просмотра.

## Проверки

`pnpm install --offline --frozen-lockfile`, `pnpm typecheck` и `pnpm test` проходят: **188 passed, 2 optional live CLI probes skipped**.

Новые проверки: Supervisor 28, core +3 (два пилота и миграция), CLI adapters +2, Verifier +2. Всего core 27, CLI adapters 45, Verifier 11; прежние context 50, contracts 15, Git 11 и demo 1 сохранены.

Проверены незаконные transitions и self-reported success, spec immutability/stale preview, DAG serial/dependencies/cycles, capability hard constraints и routing score, три fix cycles и repeated fingerprint, настоящие bundles/commits/checks, полное feedback, token/cost telemetry, cancellation до запуска и во время subprocess, timeout на probes/session/checks (включая optional check без ложного passed), остановка следующего check, snapshot mutation, concurrent runs и потеря lease ownership.

Pilot test проходит с зелёными typecheck/unit и чистым неизменённым main. `forceRed` запускает реальный demo unit с FAIL_UNIT=1: агент завершён, но результат needs_human, verifiedSnapshot отсутствует. CLI entrypoint отдельно проверен через `pnpm pilot`: exit 0, ready_for_human_review, mainClean=true, mainBaseUnchanged=true; diffRef совпадает с patchHash verifiedSnapshot. Журнал контрольного запуска: `/tmp/adw-e2e-pilot-n5Dafy/journal.jsonl` (временный артефакт). Запросов к реальным моделям нет.

## Границы и отклонения

1. Bundle передаётся из внешнего CAS, не записывается в `.adw/bundle.json` task checkout. Это сохраняет чистый patch и использует готовый CLI adapter bundlePath.
2. Одна task worktree для serial DAG; parallel workers/worktrees/merge относятся к 09. LLM DAG proposal parser не добавлен: caller задаёт проверяемые nodes, default — один intent node.
3. При повторной ошибке выбрана разрешённая планом эскалация needs_human; автоматической смены агента и resume нет. Новая попытка того же агента получает полный feedback и свежий bundle.
4. Ready означает готовность к ручному ревью. Отдельный Reviewer (06), web verification (07), UI (08) и общий DoD gate ещё не завершены. Чистый reducer моделирует accept/reject, но orchestrator не принимает patch автоматически.
5. Token/cost budgets исполняются по доступной telemetry, иногда только после завершения provider turn. Уже потраченные ресурсы не отменяются. При отсутствующей обязательной telemetry готовности нет; usageComplete отмечает неполные счётчики. Router policy metrics пока не являются измеренной историей качества/стоимости.
6. CLI/check subprocesses отменяются AbortSignal. Синхронные AST/SQLite и текущая Git helper операция не прерываются им: завершение ожидается, затем следующий этап запрещён. Жёсткий OS CPU/FS deadline не заявляется. Worktree не sandbox.
7. После process crash активная lease сохраняется; автоматического restart/resume/recovery пока нет. Требуется проверка остановки старых процессов перед ручным восстановлением. История и рабочие копии не удаляются автоматически.
8. Live environment toggle из optional пункта плана не добавлен. Реальные adapters подключаются явно к утверждённой задаче; fake pilot никогда не превращается в запрос к модели через environment variable.
9. Упомянутые superpowers skills отсутствуют среди доступных skills; работа выполнена непосредственно по плану. Git commits недоступны: metadata `.git` пуста и read-only.

API, запуск и лимиты: [Supervisor README](../../packages/supervisor/README.md).
