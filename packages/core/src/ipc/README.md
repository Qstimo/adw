# Desktop core IPC (этап 08, первый шаг)

Это headless core для Electron-клиента в `apps/desktop`. Main/preload и пять React-экранов реализованы; нативный запуск ещё не подтверждён. Реальный web gate этапа 07 и ручной DoD остаются открыты.

```bash
pnpm install --offline --frozen-lockfile
pnpm desktop:core:build
node packages/core/dist/desktop-core.mjs --data-dir /tmp/adw-desktop-data --health
```

Последняя команда возвращает `{"status":"ok"}` и закрывает DB. Запуск без `--health` принимает JSON Lines через stdin и отвечает через stdout. Для подключения из другого Node-процесса используйте прямой `spawn(process.execPath, [binary, '--data-dir', externalDirectory], {stdio:['pipe','pipe','pipe']})`. Рантайм — системный Node >=22.12, поэтому SQLite не зависит от Electron ABI. Сборка включает SQL, CLI compatibility profiles и pinned Playwright Core; better-sqlite3 и TypeScript загружаются из установленных workspace dependencies. Это сборка для текущего workspace, не автономный установщик.

Пример одного запроса:

```json
{"id":"f8730398-5c13-4ba8-9ac5-e94258c95420","method":"core.health","params":{}}
```

Ответ: `{"id":"…","ok":true,"result":{"status":"ok"}}`. Ошибка: `{"id":"…","ok":false,"error":{"code":"request_failed","message":"…"}}`. UUID сопоставляет запрос и ответ; для неразбираемого envelope генерируется новый UUID с `invalid_frame`. Лимит строки/ответа 2 MiB. Ввод UTF-8, фрагменты до newline собираются без потери символов, oversized frame закрывает транспорт. EOF/SIGTERM отменяют запущенную этим процессом задачу и закрывают DB. Принудительный SIGKILL оставляет durable lease: автоматического снятия lock чужого/аварийного run нет.

Контракты методов, параметров и результатов: `@adw/contracts`, `desktop.ts`. Обработчик последовательно обслуживает запросы; `task.start` сразу возвращает runId, Supervisor работает независимо. Один активный запуск на desktop-сессию. Открытие проекта, индексирование и просмотр ничего не запускают у моделей. Исполнение использует реальные CLI adapters только после утверждённого spec/policy и явного `task.start`; тесты подставляют FakeAdapter.

`project.open` — только для host: выбранный Git root и data directory должны быть разделены. Renderer получает `project.pick`, реализуемый нативным folder dialog; headless core его отклоняет. В рамках сессии taskId разрешён только для выбранного проекта. `adw.config.json` читается при открытии: команды, agents, web policy и privacy mode; указанный там dataDir игнорируется в пользу внешнего каталога приложения. Команды/лимиты можно менять в draft. Web policy берётся из config, secrets в DTO скрыты. Spec и фактическая execution policy утверждаются по двум хешам и сохраняются неизменяемыми в SQLite v6. Критерии сохраняются дословно, включая пробелы и переводы строк. Старые задачи сохраняются при миграции, но автоматически не получают desktop execution policy/разрешение на запуск.

`task.confirmSpec`, `review.acceptPatch`, `review.rejectPatch` требуют host authorization. Main генерирует секрет сессии (32–256 символов), передаёт дочернему core через `ADW_DESKTOP_SESSION_TOKEN` и добавляет `authorization` в envelope **только после нативного подтверждения человеком**. Renderer не должен получать секрет или выбирать actor. CLI удаляет переменную до создания adapters, чтобы она не наследовалась агентами. Без секрета защищённые операции недоступны. Это capability между локальными процессами; владелец Node/DB остаётся доверенным. Нативные диалоги, preload allowlist и sender/frame checks реализованы и покрыты host-тестами с test doubles; реальная Electron-интеграция пока не проверена.

`task.subscribeEvents` — polling durable audit cursor, а не push: до 100 событий за запрос, payload до 16k символов с явным `truncated`. UI должен продолжать с полученного cursor. `context.getProjectMap` / `getDecisions` отдают bounded provenance/freshness; `cacheHits` — счётчик текущего facade, не процент эффективности. `context.getArtifact` — текстовый read-only viewer до 128k символов. В активной задаче индекс привязан к зарегистрированному task worktree.

`verification.getMatrix` отдаёт проверки, coverage и CAS refs. `evidence.read` разрешён только для refs этой задачи, проверяет CAS hash и возвращает base64 chunks до 64 KiB (viewer limit 16 MiB). Cache ограничен 8 refs / 64 MiB. Произвольных файловых путей renderer не получает; mediaType не разрешает выполнять HTML/скрипты. Diff ограничен 512k символов, усечение явно отмечается. `review.acceptPatch` использует существующий reviewed-acceptance gate с точным snapshot, не переносит main и не делает push. `review.rejectPatch` использует durable claim; при успешном удалении worktree и неудаче записи DB оставляет claim на reconciliation вместо ложного возврата в ready.

Worktree и JSON IPC не создают OS sandbox. Electron host включает strict BrowserWindow/CSP/preload/sender проверки и native confirmations. DOM-тесты и реальный Node child IPC проходят; запуск настоящего Electron и ручной DoD остаются открыты.
