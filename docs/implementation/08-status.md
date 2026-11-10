# Этап 08 — Electron/React реализованы, native DoD открыт

Дата: 2026-11-01. Реализованы typed contracts, core handlers, отдельный Node process, Electron shell и пять React-экранов. **Этап 08 не завершён: real web gate 07, настоящий Electron smoke и ручной DoD не пройдены.** Подготовка интерфейса не закрывает зависимость от 07.

## Реализовано

- Zod contracts запросов/ответов: project status/privacy, draft/edit/lock/start/cancel, durable events, Context Map/decisions/artifact, verification matrix/coverage/evidence, review/diff/accept/reject.
- DesktopCoreService поверх существующих GitWorktreeManager, ContextFacade, Supervisor, Verifier и reviewed acceptance. Один выбранный проект и один активный запуск; cross-project task access и stale run cancellation запрещены. Параллельные IPC-запросы последовательно применяются, чтобы смена проекта не подменяла scope незавершённой операции.
- Миграция Core DB v5 → v6: execution policy отдельно от spec, immutable после утверждения; privacy settings и durable rejection claims. История старых задач сохраняется без автоматического разрешения desktop execution. Индекс остаётся v1.
- Spec/acceptance сохраняются дословно. Подтверждение проверяет два хеша и атомарно фиксирует spec + checks/limits/web/privacy policy. Команды можно менять только в draft; web policy загружается из project config, DTO скрывает credential headers.
- Human methods требуют host capability. CLI получает секрет сессии через env, удаляет переменную до создания adapters и не отдаёт её в ответах. Это основа для нативного подтверждения, host/preload теперь реализуют нативное подтверждение; фактическое окно ещё не запускалось.
- Ограниченные JSONL frames через stdin/stdout без HTTP server. Ввод читается через fs stream унаследованного fd: стандартный process.stdin превращал Node socketpair в net.Socket и закрывался в этой sandbox без ответа. Реальный parent Node → child Node обмен после исправления проверен.
- `desktop:core:build` создаёт ESM bundle для системного Node с SQL, index schema, compatibility profiles и pinned Playwright resources. Native SQLite и TypeScript остаются внешними workspace dependencies. Headless запуск не импортирует Electron и не требует его ABI.
- Bounded audit polling, context/diff truncation с флагом, task-bound CAS chunks с hash verification. Приёмка использует прежний exact snapshot/review gate и сохраняет main; отказ удаляет только managed task worktree. Если Git-удаление завершилось, а финальная DB-запись не удалась, claim остаётся для reconciliation вместо ложного ready.

## Проверки

Проверяются реальные Git/SQLite/index/check commands и compiled Node subprocess; агенты в lifecycle-тестах — FakeAdapter, запросов к моделям нет. Покрыты raw acceptance, stale previews, DB immutability/rollback, privacy, scope, concurrency, cancellation, context provenance, evidence chunks, review acceptance/rejection, failure/reconciliation, malformed/oversized frames, host secret и EOF cleanup.

`pnpm install --offline --frozen-lockfile`, `pnpm typecheck`, `pnpm desktop:core:build` и полный `pnpm test` прошли. **298 passed, 2 optional live CLI probes skipped** (предыдущий этап: 276 passed). Core: **57 passed**, включая 18 desktop handlers/transport, 3 compiled subprocess и 11 migration checks. Отдельный compiled-process набор: **3/3** — health без Electron, реальный обмен с lock/index/EOF, отказ при неверном формате session token.

Распределение: fixture 3, contracts 21, CLI adapters 48 (+2 skipped), context 50, Git 11, Verifier 52, Supervisor 56, Core 57. Новые 22 теста проверяют headless основу, не запуск Electron и не browser E2E.

## Что осталось

1. Закрыть реальный HTTP/Chromium gate 07 на машине с разрешёнными sockets/browser processes.
2. Проверить реализованные Electron main/preload и native folder/approval dialogs в настоящем Linux runtime. Sandbox/contextIsolation/CSP, preload allowlist и sender/main frame checks покрыты тестами с doubles.
3. Пройти ручной цикл в реализованных пяти React-экранах: Project, Task, Context, Verification/media, Review. DOM-тесты проверяют действия и безопасное отображение HTML/DOM evidence как текста.
4. Native Linux Electron smoke и ручной сквозной DoD на реальном repo/CLI. В текущем cache найден только Windows Electron zip, Linux runtime не установлен. Native window не запускалось.
5. Crash/forced-kill reconciliation остаётся явной будущей операцией; автоматического снятия чужих leases нет. 09/10 не начинаются до DoD.

Запуск и подробности протокола: [Core IPC README](../../packages/core/src/ipc/README.md). Запись `.git` workspace блокируется sandbox; публикация Git обрабатывается отдельно.

## Desktop shell и UI — 2026-11-01

- `apps/desktop`: sandboxed Electron window, CSP, запрет навигации/новых окон, проверка sender/main frame, strict Zod allowlist. Системный Node child с ограниченными frames, таймаутами и EOF cleanup; token остаётся в main/core.
- Нативные folder/approval dialogs. Подтверждение использует данные core, сверяет spec/policy hashes или review ID; отмена не выдаёт host capability. Во время диалога смена проекта блокируется.
- Project: native picker, ветки, dirty/worktrees/privacy, история задач. Task: draft/edit/lock, точные acceptance clauses, команды/лимиты, start/stop, DAG, бюджет, durable cursor polling. Context: provenance/freshness/cache hits и read-only artifact. Verification: matrix/coverage/notVerified, bounded CAS viewer, PNG/video через blob, HTML/SVG как текст. Review: escaped diff, remarks/blocking, exact review acceptance и отказ с причиной.
- Навигация и Task ID hash для повторного открытия после выбора проекта. Optional Open in IDE не реализован. Назначения агентов/причины доступны через события; dedicated assignment DTO core не предоставляет. Установщик и автономная упаковка вне этой сборки.
- 19 новых тестов: 7 DOM сценариев пяти экранов, 7 host approval/sender сценариев с doubles, 4 allowlist/evidence проверки, 1 настоящий compiled Node core обмен на временном Git repo. Эти проверки не заменяют настоящий Electron smoke.
- `pnpm desktop:build`, общий `pnpm typecheck` и `pnpm test` прошли: **317 passed, 2 optional live CLI probes skipped** (298 прежних + 19 desktop). Native Electron runtime отсутствует; окно и ручной DoD не проверены.

## Обновление — 2026-11-10

Реальный web gate 07 закрыт, повторные typecheck/test/desktop:build прошли (317 passed, 2 optional skipped). Установлен Linux Electron 38 в `/tmp/adw-electron`. Native smoke выполнен попыткой настоящего запуска, но окно не открылось: SUID helper не настроен (ожидаются root ownership и 4755); попытка namespace sandbox с `--disable-setuid-sandbox` завершилась `No usable sandbox`. `--no-sandbox` не использовался. Логи: [evidence](evidence/2026-11-10/README.md).

Следующий шаг требует настроенного системного Electron sandbox администратором либо подходящего Linux runtime. Затем повторить native smoke и ручной DoD с реальными CLI. Этап 08 открыт, 09/10 не начаты.

## Native smoke пройден — 2026-11-10

Electron 38.8.6 запустил настоящее окно в текущей Linux desktop session. Визуально проверен экран выбора проекта. Core health выполнен до создания окна. Проверены фактические webPreferences: sandbox=true, contextIsolation=true, nodeIntegration=false, webSecurity=true; renderer не имеет process/require, preload bridge window.adw доступен. Приложение штатно закрыто после smoke. Это проверка старта, не ручной DoD и не проверка нативных подтверждений.

Причина первоначальной ошибки устранена в установленном `/tmp/adw-electron` runtime: локальный chrome-sandbox сохранён как chrome-sandbox.original и заменён символической ссылкой на существующий root-owned `/opt/google/chrome/chrome-sandbox` (4755). Переменная CHROME_DEVEL_SANDBOX этой сборкой не учитывалась. Настройки AppArmor/sysctl и системные файлы не менялись; sandbox не отключался. Runtime в /tmp временный, после его удаления потребуется повторная установка/настройка.

Результат: [native-smoke.json](evidence/2026-11-10/native-smoke.json), [снимок окна](evidence/2026-11-10/native-smoke.png). Следующий gate — полный ручной цикл с настоящими CLI, выбором проекта и native approval dialogs.
