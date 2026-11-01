# Этап 02 — CLI Agent Adapters

Дата: 2026-10-31. Реализованы TASK-04/05/06 по плану 02 и §5 ТЗ. Acceptance gate для fake-CLI тестов пройден на Linux; реальный авторизованный pilot ещё не выполнялся.

## Реализовано

- Пакет `@adw/cli-adapters`, общий интерфейс AgentAdapter, CodexAdapter и ClaudeCodeAdapter.
- Поиск исполняемого файла, явные overrides ADW_CODEX_PATH / ADW_CLAUDE_PATH, проверка формата версии и help-флагов, load/validation versioned compatibility matrix. Неизвестная версия сохраняет unknown capabilities и получает unsupported_version при попытке запуска.
- Матрица: Codex 0.166.0 (`exec --json`) и Claude Code 2.1.236 (`--print --output-format stream-json --verbose`). Args start/resume берутся из профилей и проверяются независимыми assertions в тестах.
- Запуск без shell с cwd worktree и передачей prompt в stdin. ContextBundle валидируется и добавляется без резюмирования acceptance.
- Общий ProcessRunner: heartbeat, общий timeout, ограничения вывода/очереди/строки, UTF-8 chunk decoding, process-group cleanup. Discovery/help используют тот же runner, поэтому их потомки также останавливаются при таймауте.
- Нормализация provider events: log, tool_call/result, usage и final status. Финальное completed откладывается до exit 0 и корректного терминального события. Ошибки провайдера, exit/signal, malformed JSON, timeout, отмена и переполнение лимитов не дают ложного успеха.
- AgentEvent дополнен необязательными providerSessionId, failure code и usage breakdown; существующие события остаются валидными. Локальный run ID не меняется, provider ID используется только для resume.
- stdout/stderr, events.jsonl и metadata в отдельном каталоге запуска. Начальная версия/cwd записываются до spawn; итог хранит exit/signal и normalized result. Закрытие consumer iterator останавливает процесс и сохраняет cancelled.
- Документация будущих Ollama/Cursor adapters; они не реализованы и не заявлены как готовые.

## Проверки

- `pnpm install --offline --frozen-lockfile` — PASS; новые внешние зависимости не потребовались.
- `pnpm typecheck` — PASS во всём workspace.
- `pnpm test` — PASS: 80 тестов; 2 optional live probes пропущены по умолчанию.
- `@adw/cli-adapters`: 43 обычных теста PASS. Проверены discovery, exact argv/cwd/stdin, start/resume, bundles, typed events, журналы, invalid/unknown versions, provider errors, ненулевой и поздний exit, отсутствующий final event, malformed JSON, permissions, output/queue limits, UTF-8/no-newline, spawn failure, timeout/consumer cancellation и остановка потомков.
- Отдельно `ADW_LIVE_CLI=1 ... tests/live.probe.test.ts` — 2 теста PASS на установленных Codex 0.166.0 и Claude Code 2.1.236. Выполнялись только version/help, без запросов к моделям или изменения авторизации.

## Границы подтверждения

Матрица фиксирует проверенную справку и fixtures протокола, а не прохождение реальной задачи с подпиской. Реальные сессии, resume у провайдера, доступность MCP и фактические квоты требуют отдельного pilot на пользовательском окружении. Capability описывает поддерживаемую CLI возможность, а не её настройку или доступность аккаунта.

`heartbeat` синтетический: подтверждает работу локального runner. Отсутствующие usage/cost не выдумываются. Codex cached input сохраняется как подмножество input; Claude cache read/creation считаются отдельно. Передаваемый CLI cost не считается подтверждённым счётом пользователя.

Linux process-group cleanup проверен на основном процессе и потомках, включая version/help timeout. Потомки, создавшие отдельную session/group, и remote jobs не покрываются этим механизмом. Windows taskkill-ветка не проверена; cleanup capability там unknown. Полноценный OS sandbox остаётся отдельным компонентом.

CLI авторизуется штатно. Адаптер не читает credential-файлы и не добавляет обход sandbox/approvals. Конфигурация CLI и её авторизация не изменялись. В fixtures используются синхронные stdin/stdout операции для детерминированных проверок в этой хост-среде.

SQLite agent_sessions и UI подключаются в следующих этапах. Коммиты недоступны: workspace `.git` пуст и смонтирован read-only. Упомянутые планом superpowers skills отсутствуют в доступной установке; этап реализован непосредственно по плану без их вызова.

Официальные источники и инструкция по обновлению профилей: [package README](../../packages/cli-adapters/README.md). Следующий этап — 03, Context Index. Общий продуктовый DoD остаётся открытым до последующих этапов.
