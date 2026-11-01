# Этап 01 — Git worktrees и независимый Verifier

Статус: реализован; acceptance gate пройден на Linux. Этап 00 проверен перед началом: корневые typecheck/test, включая native SQLite, прошли.

## Результат

- `packages/git`: async system-git wrapper, immutable base SHA, create/list/remove управляемых task worktrees, binary diff, drift/dirty guards.
- Принятие — применение snapshot diff в отдельной локальной ветке `adw/accept/<taskId>` и отдельной worktree. Основная ветка не меняется. При ошибке commit новая ветка/worktree удаляются. Существующие acceptance-ветки не заменяются.
- Отказ удаляет только проверенную task worktree и возвращает типизированную запись с причиной.
- `packages/verifier`: pipeline configured shell checks, exit codes, fingerprint Node/OS/lockfile/manifest/environment, stdout/stderr/metadata в SHA-256 evidence store, timeout, process-group cleanup и ограничение объёма логов.
- Required failure/incomplete result блокирует suite readiness. Недоступная optional-команда отмечается notVerified с предупреждением. Empty/optional-only suites отклоняются.
- `packages/core`: facade проверяет locked/queued task и сохранённый base SHA, создаёт worktree, сохраняет check_results и audit_events. Diff сохраняется отдельным evidence ref. Green suite не переводит задачу в продуктовый ready_for_review без будущего reviewer.
- pnpm workspace/lockfile обновлены без загрузки новых внешних пакетов.

## Проверки

`pnpm typecheck` и `pnpm test` проходят в основном рабочем каталоге.

Всего 37 тестов: contracts 9, demo 1, core 10, git 8, verifier 9.

Покрыто реальными временными Git-репозиториями: изоляция и SHA, пути с пробелами, dirty/drift, local acceptance, binary patch, rejection, защита от перезаписи ветки, rollback при ошибке commit, небезопасные task IDs/paths. Основная рабочая папка остаётся чистой.

Verifier запускает настоящие typecheck/unit исходной demo-фикстуры в копии, затем известный красный `FAIL_UNIT=1`. Дополнительно проверены логи/evidence, отсутствие команды, optional notVerified, timeout, ограничение вывода и остановка потомков процесса. SQLite integration проверяет сохранённые результаты и аудит зелёного/красного исхода.

## Границы и решения

- Git переведён на async child_process вместо синхронного примера плана: в этой среде sync spawn возвращает EPERM; async API также не блокирует headless core.
- В stdout-тестах используются детерминированные синхронные записи дочернего процесса, чтобы проверить захват байтов независимо от поведения буферизованного console в хост-среде.
- Проверено на Linux. Windows taskkill-ветка требует отдельной проверки на Windows.
- Каталог данных должен быть вне основной checkout-папки. Все тестовые репозитории находятся в `/tmp`; рабочий проект не инициализировался как Git-репозиторий.
- Git hooks отключены для внутренних операций. Worktree остаётся механизмом Git-изоляции, а не OS sandbox.
- Низкоуровневые accept/reject возвращают типизированный результат. Постоянный аудит facade сейчас покрывает verification; UI/supervisor должны подключить журналирование human approvals и independent review на своих этапах.
- Коммиты в рабочем проекте не созданы: `.git` пуст и доступен только для чтения. Навыки `superpowers`, указанные в планах, отсутствуют в доступной установке.

Следующий этап по порядку — 02 (CLI adapters). Полный DoD первой версии ещё требует этапов 02–08.
