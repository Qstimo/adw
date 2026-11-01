# Этап 03 — L1 Project Index

Дата: 2026-10-31. Реализован ProjectIndexer по плану 03 / TASK-07 и §4.1, §4.3, §4.5 ТЗ. Следующий этап — 04: ArtifactStore и Context Broker.

## Результат

- `@adw/context` и общие Zod-контракты ProjectMap/limits/files/symbols/imports/manifests.
- Детерминированный walk через rg с gitignore, пропуском metadata/dependencies/credentials и запретом обхода симлинков. Hash полных UTF-8 bytes, включая BOM; binary/invalid/oversized файлы не усекались.
- TS/TSX/JS/JSX AST symbols, строки declarations, imports/exports и literal require/dynamic imports; ограниченное разрешение относительных module refs. Никаких eval, require проекта или исполнения package scripts.
- package.json/scripts и tsconfig/jsconfig JSONC; invalid manifests/синтаксис видны в warnings.
- Отдельная SQLite WAL/FTS5 DB с project/snapshot namespace. Base SHA, parser revision и source hashes участвуют в identity; старые снимки не заменяются. Повторное открытие persistent DB переиспользует analysis. Core DB v2 не менялась.
- Copy-on-write content/FTS по SHA-256; metadata/facts неизменённых файлов копируются SQL без повторного AST analysis. Изменения, удаления, ignore changes и base drift дают staleArtifactHints. Изменившийся fact budget инвалидирует зависимый analysis.
- Project map, readonly getSource и scope-aware FTS/ripgrep search. Оба поиска возвращают байты выбранного снимка. Ripgrep работает через stdin, без shell/rg config и без зависимости от оставшейся live-копии репозитория.
- Bounds на files, file bytes, total I/O bytes, listing, AST facts, query/output, время внешних команд. Пропуски отражаются в warnings и complete; незавершённый scan не публикуется.

## Проверки

`pnpm install --offline --frozen-lockfile`, `pnpm typecheck` и `pnpm test` проходят. Всего 120 обычных тестов; 2 optional CLI probes пропущены по умолчанию.

Контрольный прямой запуск `pnpm exec vitest run --reporter=verbose --maxWorkers=4 --minWorkers=1` также прошёл: 120 passed / 2 skipped.

В первом одновременном запуске typecheck/test/install pnpm сообщил failure в старом пакете cli-adapters без текста assertion. Повторный обычный recursive test и прямой общий Vitest прошли. Точную причину единичного сбоя установить не удалось; возможная чувствительность коротких timing-тестов к общей нагрузке остаётся наблюдением. CLI production-код и его тесты в этапе 03 не изменялись.

Новый пакет: 24 теста — demo index 1, AST symbols 3, incremental/history 4, FTS/ripgrep/search isolation 5, scope/resource/storage policies 11.

Проверены реальные SQLite FTS5 и rg 15.2.0, demo fixture с React/TypeScript, SHA-256, scripts, source ranges, relative imports, ignore/symlink/secret exclusions, binary/invalid UTF-8/BOM, byte/fact budgets, сохранение чужой DB, отсутствие rg, rollback при превышении listing budget, неизменяемая история, новые base namespaces, reopen/dedup, update timestamps, отсутствие cross-project reads и стабильность поиска при изменении чужого FTS corpus. Ripgrep-поиск проверен после изменения и удаления live repo.

## Отклонения и границы

1. Tree-sitter и TS grammar отсутствуют в доступных node_modules/offline cache. Для полезной работающей symbol map применён уже установленный TypeScript 5.9.3 AST. Это отражено в parser metadata; symbol tests не пропускались. Смена backend потребует отдельной проверки и parser revision.
2. BaseCommit — строгий 40-hex anchor от вызывающего Git-сервиса; WORK_TREE sentinel не поддерживается. Indexer не проверяет Git ancestry/существование commit и не объявляет live working tree атомарным Git snapshot: observed source hashes задают точное содержимое прочитанных файлов.
3. DB выделена отдельно и должна лежать вне repository. Без dbPath storage временный и удаляется при close. Неизвестная/чужая схема отклоняется.
4. FTS выдаёт deterministic path order; broker ranking относится к этапу 04. Ripgrep ищет literal строки в stored bytes, а не regexp по live FS. Limit у FTS означает paths, у rg — lines.
5. Source content и FTS deduplicated, но snapshot metadata/facts занимают место на каждый снимок. Retention/GC пока нет. Одновременные scans одного экземпляра отклоняются; immutable snapshots не заменяют OS sandbox или глобальную блокировку live FS.
6. Сканирование ограничено byte/file/fact budgets и проверками deadline. Синхронные AST/SQLite operations не прерываются как отдельный OS-процесс. Политики содержат явную неполноту, а не ложное утверждение о полном индексе.
7. Никаких запросов к моделям, embeddings, semantic summaries, MCP или ArtifactStore в этапе 03 нет. Происхождение/freshness артефактов будет проверять broker.

Упомянутые в плане superpowers skills отсутствуют в доступной установке; реализация выполнена непосредственно по шагам плана. Git-коммиты недоступны из-за пустого read-only .git.

Подробное API и defaults: [package README](../../packages/context/README.md).
