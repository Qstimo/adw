# Agent Development Workstation

Локальная диспетчерская AI-разработки. Исходное ТЗ: `Agent_Development_Workstation_Architecture_v1.docx`.
Порядок реализации: [индекс планов](docs/superpowers/plans/2026-10-31-adw-INDEX.md).

## Подготовка

Нужны Node.js 22+, pnpm 10.18.3 и доступ к npm registry. Для `better-sqlite3` может потребоваться C++ toolchain, если для установленной версии Node нет готового бинарника.

```bash
pnpm install
pnpm typecheck
pnpm test
```

`pnpm-workspace.yaml` разрешает install scripts только для `better-sqlite3` и `esbuild`.

## Этап 00

- `packages/contracts`: строгие Zod-контракты домена, событий и IPC; типы выводятся из схем.
- `packages/core`: headless-загрузчик конфигурации и SQLite (WAL, foreign keys, транзакционная миграция).
- `fixtures/demo-repo`: минимальный React/TypeScript-модуль с детерминированным зелёным/красным тестом. Браузерный сервер появится на этапе web verification.
- `adw.config.example.json`: пример конфигурации; относительный `dataDir` пока сохраняется как задано. Исполнение команд не входит в этап 00.

```ts
import { loadConfig, openDb, migrate } from '@adw/core';

const config = loadConfig('adw.config.example.json');
// Родительский каталог файла БД должен существовать.
const db = openDb('/path/to/adw.sqlite');
try {
  migrate(db);
} finally {
  db.close();
}
```

Пакеты экспортируют TypeScript-исходники для workspace-потребителей с TS-loader/bundler. Сборка для обычного Node и Electron добавляется на соответствующем этапе.

Контракты сохраняют обязательные snapshot SHA и provenance. Verified findings требуют evidence; чек без exit code требует `notVerified`. Неизвестные возможности CLI явно имеют статус `unknown`. Миграция не меняет пользовательские репозитории, отказывается открывать более новую схему и не удаляет данные при повторном запуске.

Gate этапа 00 пройден: зависимости установлены, корневые `typecheck`/`test` прошли. Статус проверок: [отчёт этапа](docs/implementation/00-status.md).

## Этап 01

`@adw/git` создаёт detached task worktree с зафиксированным SHA, возвращает diff и проверяет чистоту основной папки и drift базовой ветки. Принятие создаёт отдельную ветку `adw/accept/<taskId>` и отдельную checkout-папку; основная ветка не перемещается. Для принятия изменения в task worktree должны быть закоммичены. `acceptPatch` требует `expectedSnapshot` (task ID, base SHA, HEAD SHA, SHA-256 diff), полученный от успешной проверки; пропуск или несовпадение снимка блокирует приёмку. Применяется diff закреплённого commit, а итоговое Git tree сверяется с ним. `rejectPatch` удаляет только управляемую task worktree и возвращает структурированную запись отказа.

Все Git-операции асинхронные. `GitWorktreeManager` принимает корень репозитория и внешний каталог данных: он должен находиться вне основной рабочей папки. Untracked-файлы нужно добавить в индекс, чтобы они попали в diff; при принятии untracked/dirty-состояние task checkout отклоняется.

`@adw/verifier` запускает настроенные shell-команды с заданным cwd, ограничением времени и объёма вывода. stdout/stderr и metadata сохраняются в content-addressed evidence store. Required check с ошибкой, таймаутом, сигналом или неполным результатом блокирует `readyForReview`. Отсутствующая optional-команда даёт `notVerified` и предупреждение.

`GitVerifierFacade.verifyTask` связывает зафиксированную задачу, worktree, checks, SQLite и аудит. Зелёные проверки оставляют статус задачи `verifying`: независимое ревью и финальная приёмка будут подключены следующими этапами. Возвращаемый `readyForReview` относится только к результату suite, а не к продуктовой готовности задачи. Facade сравнивает снимки до и после checks; изменение кода даёт `notVerified` и блокирует готовность даже при exit code 0. Только успешный стабильный запуск возвращает `verifiedSnapshot`, который передаётся в `acceptPatch` как `expectedSnapshot`. `capturePatchSnapshot` сам по себе не означает, что проверки пройдены.

Worktree не является sandbox: команды выполняются с правами процесса. Изоляция ОС и политика доступа относятся к следующим этапам. Process-tree cleanup проверен на Linux; Windows-ветка использует `taskkill`, но на этой машине не проверена. Runtime не запускает агентов и не обращается к удалённым репозиториям. Низкоуровневые accept/reject возвращают записи для вызывающего сервиса; постоянный аудит facade на этом этапе покрывает запуск и результаты verification.

Подробности: [отчёт этапа 01](docs/implementation/01-status.md).

## Этап 02

`@adw/cli-adapters` предоставляет общий `AgentAdapter` и реализации для Codex CLI / Claude Code: discovery/version/help probes, versioned compatibility matrix, headless JSONL-сессии в заданной worktree, явный resume, нормализованные события и usage, cancellation/timeout с остановкой process group и отдельные журналы запусков.

Протоколы закреплены для Codex 0.166.0 и Claude Code 2.1.236; неизвестные версии не запускаются до добавления проверенного профиля. Таймаут распространяется и на version/help subprocesses. Успешный exit без итогового события либо итоговое сообщение с последующим ненулевым exit не дают completed. Это статус сессии агента; независимая приёмка по критериям остаётся за Verifier и review.

Реальные установленные CLI проверены только через version/help; авторизованные запросы к моделям не запускались. Тесты протоколов и lifecycle используют fake CLI. Инструкции запуска, журналов и обновления compatibility matrix: [CLI adapters README](packages/cli-adapters/README.md). Результат этапа: [отчёт 02](docs/implementation/02-status.md).

## Исправления по ревью этапов 00–02

Закрыты четыре подтверждённых замечания: приёмка изменившегося после checks патча, конфликт конкурентных verification-вызовов, оставшаяся acceptance-ветка после ошибки создания worktree и обход provenance-проверки через унаследованные свойства `sourceHashes`.

После исправлений этапов 00–02 база получила схему v2 (этап 04 обновляет её до v3). Перед использованием facade вызовите `migrate(db)`: обновление v1 → v2 сохраняет прежние записи, добавляет `verification_runs`, запрещает два активных запуска одной задачи и связывает новые `check_results` с `runId`. Запоздавший запуск не меняет состояние нового владельца. Если процесс аварийно завершился с активным run, его восстановление остаётся задачей будущего supervisor; автоматическое снятие живого lock не добавлялось.

Подробности: [отчёт исправлений](docs/implementation/2026-10-31-review-fixes.md).

## Этап 03

`@adw/context` добавляет ProjectIndexer: source hashes, карту символов/imports, package/config manifests, команды проверок, FTS5 и ripgrep search. Неизменяемые снимки сохраняются в отдельной SQLite DB; incremental update переиспользует analysis, сохраняет историю и возвращает staleArtifactHints для broker.

Поиск читает bytes выбранного снимка, поэтому live-изменение файла не подменяет его source hash. Ограничения файлов/байтов/facts и gitignore действуют при scan; пропуски видны через warnings/complete. Symbol parser на этом этапе — TypeScript AST 5.9.3: Tree-sitter отсутствует в offline cache. На момент этапа 03 Core DB оставалась версии 2; index DB имеет отдельную собственную схему.

API и ограничения: [Context README](packages/context/README.md). Проверки и отклонения от плана: [отчёт 03](docs/implementation/03-status.md).

## Этап 04

ArtifactStore хранит неизменяемые артефакты и findings с provenance, confidence и evidence в SQLite и SHA-256 CAS вне репозитория. Context Broker собирает JSON bundle с полным текстом критериев приёмки, релевантными исходниками и артефактами; устаревшие данные исключаются относительно выбранного снимка. Проверенные findings можно отдельно продвигать в project context.

`ContextFacade` связывает задачи, индекс, evidence и разделённые read/write API; task worktree требует проверенной регистрации Git. Core DB обновляется через `migrate(db)` до v3, индекс остаётся v1. Оценка бюджета приблизительная; обязательные критерии сохраняются даже при превышении с явным `overBudget`.

API: [Context README](packages/context/README.md). Проверки и ограничения: [отчёт 04](docs/implementation/04-status.md). Следующий этап — Supervisor.

## Этап 05

`@adw/supervisor` добавляет неизменяемое утверждение spec по hash, serial DAG, объяснимую маршрутизацию CLI и ограниченные циклы исправлений. `createSupervisor` соединяет task worktree, Context Broker и независимый Verifier. Событие `completed` агента не подтверждает тесты: готовность к ручному ревью требует зелёных checks и неизменившегося committed snapshot. Core DB обновляется до v4.

```bash
pnpm pilot
```

Пилот работает на отдельной временной копии demo repo с fake executor и настоящими typecheck/unit checks; печатает финальный статус и путь к журналу. Модели не вызываются, patch не принимается автоматически. Подробности API, ограничений budget/timeout и восстановления: [Supervisor README](packages/supervisor/README.md). Результат: [отчёт 05](docs/implementation/05-status.md). Следующий этап — независимое ревью (06).

## Этап 06

Независимый Review Engine запускает отдельные code/security sessions после зелёных checks, предпочитает другого агента и сохраняет structured verdict/remarks с evidence. Blocking, неполный ответ или изменение snapshot блокируют готовность к приёмке. Reviewer работает с отдельной read-only CLI policy; собственное утверждение агента о проверках не заменяет gates.

Core DB обновляется до v5. `acceptReviewedPatch` требует явное действие человека, approved review и тот же verified snapshot; main не перемещается. `pnpm pilot` включает независимые fake review sessions без запросов к моделям. API: [Supervisor README](packages/supervisor/README.md). Проверки и границы: [отчёт 06](docs/implementation/06-status.md). Следующий этап — web verification (07).

## Этап 07 — реализация подготовлена, real web gate ожидает прогона

Verifier получил API smoke/schema, Playwright worker с PNG/video/DOM/console/network evidence и привязку сценариев к утверждённым acceptance clauses. Required failure/notVerified блокирует независимое review и приёмку; media подтверждают только наблюдённый сценарий.

```bash
pnpm browser:install
pnpm web:pilot
```

Команды полного web-пилота нужно выполнять в обычном терминале/CI с разрешёнными loopback sockets и browser processes. В текущей sandbox-сессии Node listen и Chromium setsockopt возвращают EPERM: реальный gate не пройден, переход к этапу 08 пока не подтверждён. `pnpm pilot` остаётся headless-проверкой этапа 06.

Root install извлекает pinned Playwright Core из проверенного vendored archive в .adw; браузеры автоматически не скачиваются. API/setup: [Verifier README](packages/verifier/README.md). Реализация, тесты и фактические блокировки: [отчёт 07](docs/implementation/07-status.md).


## Этап 08 — Electron и React, нативный DoD ожидает проверки

Добавлены Electron main/preload и пять React-экранов: Project, Task, Context, Verification и Review. Core работает отдельным системным Node-процессом с SQLite v6. Выбор проекта и утверждение spec/accept/reject проходят через нативные диалоги; renderer не получает host token или произвольные файловые методы.

```bash
pnpm desktop:build
# При отдельно установленном Electron в PATH:
pnpm desktop:start
```

Это workspace build, не установщик. Electron runtime отсутствует в offline cache этой машины и не устанавливается автоматически. Нативное окно, реальный web gate 07 и ручной сквозной DoD пока не проверены. Детали запуска: [Desktop README](apps/desktop/README.md), [отчёт 08](docs/implementation/08-status.md), [ручной checklist](docs/superpowers/plans/dod-manual-checklist.md).
# adw
