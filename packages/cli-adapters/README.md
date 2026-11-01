# CLI adapters — этап 02

`@adw/cli-adapters` экспортирует `AgentAdapter`, `CodexAdapter`, `ClaudeCodeAdapter`, `ProcessRunner`, discovery и loader матрицы совместимости. Ядро и UI подключат этот API на своих этапах; здесь нет маршрутизатора или вызовов модели в тестах по умолчанию.

## Запуск

CLI должна быть установлена и заранее авторизована штатным способом. Адаптер использует её собственную конфигурацию/окружение; файлы авторизации он не читает и токены не извлекает. Подписка или API billing определяются настройками самой CLI. API-ключи для использования адаптера не требуются самим адаптером.

```ts
import { CodexAdapter } from '@adw/cli-adapters';

const adapter = new CodexAdapter({ logDir: '/path/to/workstation-data/agent-runs' });
const { version } = await adapter.discover();
const capabilities = await adapter.probeCapabilities(version);

for await (const event of adapter.startSession({
  worktreePath: '/path/to/task-worktree',
  prompt: 'Implement the approved task. Preserve the acceptance criteria.',
  timeoutMs: 120_000,
})) {
  // event.sessionId is the workstation run ID, used by adapter.cancel().
  // event.providerSessionId, when present, is the CLI ID used for resume.
  console.log(event);
}
```

Путь ищется через PATH. `ADW_CODEX_PATH` и `ADW_CLAUDE_PATH` задают один исполняемый файл, не shell-команду. `binaryPath` в конструкторе имеет приоритет. Отсутствующий явный override не заменяется случайным бинарником из PATH. `env` позволяет передать окружение дочернему процессу без изменения глобального `process.env`.

Вызов идёт через `spawn` с `shell: false` и заданным cwd. Prompt передаётся в stdin, сохраняя пробелы и переводы строк; он не интерпретируется как флаги или shell-код. Не используются флаги обхода approvals/sandbox. Codex получает `workspace-write`; Claude сохраняет штатные настройки разрешений. `--bare` не добавляется: он меняет источники авторизации Claude.

`bundlePath`, если передан, должен содержать валидный `ContextBundle`, адресованный этому адаптеру (максимум 1 MiB). JSON добавляется к prompt без резюмирования критериев приёмки. Соответствие bundle текущему Git snapshot должен проверять будущий broker/supervisor.

## События и завершение

Схема `AgentEvent` находится в `@adw/contracts`. Типы: `session_started`, `log`, `tool_call`, `tool_result`, `usage`, `heartbeat`, `completed`, `failed`.

- `heartbeat` создаётся runner: он означает, что локальный процесс ещё работает, а не подтверждает прогресс модели.
- `sessionId` — неизменный ID локального запуска. `await adapter.cancel(sessionId)` останавливает активный запуск; повторная отмена безопасна.
- `providerSessionId` появляется после соответствующего события CLI. Для продолжения передайте его как `resumeSessionId` (UUID). `--last` и интерактивный выбор сессии не используются.
- `completed` появляется только после итогового события протокола и успешного завершения процесса. Это завершение агента, а не подтверждение acceptance: независимый Verifier остаётся обязательным.
- Ошибка провайдера сохраняет причину даже при ненулевом exit code. Повреждённый JSON, отсутствие итогового события, signal, timeout, отмена, переполнение вывода/очереди дают `failed` с типизированным `code`.
- Неизвестные JSON-события сохраняются как logs. ANSI не используется как протокол. Счётчики usage публикуются только при наличии данных; cache counters сохраняются отдельно с учётом различий провайдеров. Cost не оценивается по прайс-листу.

Закрытие потребителем async iterator останавливает процесс и пишет cancelled в журнал. Таймаут охватывает подготовку/проверку CLI и выполнение. Версия/справка дополнительно ограничены пятью секундами на команду.

## Журналы и ограничения

`logDir/<sessionId>/` содержит `stdout.log`, `stderr.log`, `events.jsonl`, `metadata.json`. Без `logDir` используется каталог `adw-cli-sessions` в системном temp. Файлы содержат фактический вывод CLI; срок хранения и redaction будут политикой workstation. Metadata сохраняет версию, cwd, provider ID, exit/signal и итог. SQLite integration с `agent_sessions` относится к supervisor.

По умолчанию: heartbeat 1000 ms, суммарный stdout/stderr 16 MiB, JSONL line 1 MiB, очередь 4096 событий. Превышение лимита останавливает процесс и блокирует completed. `heartbeatMs`, `maxOutputBytes`, `maxQueuedEvents` настраиваются в конструкторе.

Остановка проверена на Linux для потомков в той же process group. Новый detached process, удалённые MCP jobs и внешние серверы не принадлежат этой группе; полноценный OS sandbox остаётся отдельным требованием. Windows taskkill-ветка не проверена, capability cleanup там `unknown`. Discovery/fake executable fixtures проверены на Linux.

## Матрица совместимости

| CLI | Версия | Протокол | Проверено |
| --- | --- | --- | --- |
| Codex | 0.166.0 | JSONL exec | Локальная справка + fake CLI |
| Claude Code | 2.1.236 | print/stream-json | Локальная справка + fake CLI |
| Остальные | default | unknown | Запуск запрещён до добавления профиля |

`compat/<agent>/<version>.json` содержит точную версию, args для start/resume, проверяемые флаги help и CapabilityManifest. Это baseline совместимости, а не подтверждение реальной авторизованной сессии. У неизвестной версии возможности остаются unknown; адаптер не предполагает, что JSON-протокол не изменился.

Обновление матрицы:

1. Сверить `--version`, `--help` и официальные документы нужной версии.
2. Добавить точный профиль с источниками, args и capability fields; не расширять диапазон без проверки.
3. Добавить/обновить fixtures событий и compatibility-тесты, включая ошибки и resume.
4. Запустить тесты и read-only live probe. Реальный авторизованный pilot фиксировать отдельным видом проверки в профиле, если он был выполнен.

```bash
pnpm --filter @adw/cli-adapters test
ADW_LIVE_CLI=1 pnpm --filter @adw/cli-adapters exec vitest run tests/live.probe.test.ts
```

Live probe вызывает только version/help. По умолчанию пропущен; при явном включении отсутствие CLI пропускает только её тест. Ошибка установленной CLI не скрывается.

Официальные источники, сверены 2026-10-31: [OpenAI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [OpenAI developer commands](https://learn.chatgpt.com/docs/developer-commands), [Claude headless](https://code.claude.com/docs/en/headless), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Claude event types](https://code.claude.com/docs/en/agent-sdk/typescript).

## Reviewer role (этап 06)

`startSession({...input, role:'reviewer'})` запрещает resume и использует отдельный profile.arguments.review, проверенный дополнительным help probe. Для Codex 0.166.0 это `exec --json --sandbox read-only -`; для Claude Code 2.1.236 — print/JSONL без built-in tools (`--tools ""`), с пустым strict MCP config и `--disable-slash-commands`. Unknown policy/version отклоняется. Flags проверены на установленном CLI через help и на fake CLI; запросов к моделям не было.

Роль не меняет протокол events/cancellation/usage. Supervisor отдельно проверяет session independence, snapshot и structured response. Native read-only policy не является общей OS/network sandbox; особенно настройки/интеграции Codex требуют собственной политики. Модель не получает API приёмки patch.
