# Этап 04 — ArtifactStore и Context Broker

Дата: 2026-10-31. Реализован план 04 / TASK-08/09 и §4.2–4.6 ТЗ. Следующий этап — 05: Supervisor.

## Результат

- Append-only ArtifactStore: SQLite metadata, content-addressed SHA-256 blobs, provenance, confidence, evidence, expiry, session/task/project scopes. Проверка hash при чтении, запрет symlink traversal, атомарная публикация CAS и ограничение объёмов.
- Core DB v3: транзакционная миграция с сохранением прежних artifacts/findings, immutable triggers, отдельные invalidations, связи findings/promotions, bundles и аудит. Index DB остаётся v1.
- Findings публикуются атомарно в namespace задачи. Продвижение требует verified, существующих evidence refs и свежих источников; создаёт новый project artifact без изменения оригинала. Повторная promotion идемпотентна.
- Freshness вычисляется по конкретному immutable snapshot: base mismatch, source change/deletion, expiry, manual invalidation. Изменения private worktree не отзывают globally артефакт, актуальный для другого снимка. Ручная invalidation сохраняется; stale content доступен для истории.
- Context Broker: relevance/confidence/cost ranking, полные acceptance/intent/outOfScope, inline artifact bodies/provenance и source excerpts с точными hashes/ranges. Бюджет учитывает весь JSON; обязательные критерии сохраняются с overBudget/warning. Итоговый JSON неизменяем, сохраняется в CAS и передаётся CLI через bundlePath.
- Дедупликация refs и ограниченный кэш кандидатов; два agent IDs используют общую подборку с собственными bundle metadata. Ключ учитывает namespace, snapshot/hashes, запрос и scoped metadata. Для research допускается явно заданный summary с сохранением refs оригинала; decisions автоматически не пересказываются.
- Разделённые read/write in-process API, неизменяемые task/session permissions; обычный агент не присваивает verified и не продвигает findings. Legacy finding без provenance отмечается missing_provenance.
- ContextFacade связывает DB/index/task/evidence, обновляет индекс перед build и объединяет конкурентные refresh. Для task worktree проверяет Git registration, receipt/base и принадлежность задачи. Успешные check evidence импортируются только для той же task/base.

## Проверки

`pnpm install --offline --frozen-lockfile`, `pnpm typecheck`, `pnpm test`: 153 passed, 2 optional live CLI probes skipped по умолчанию.

Первый recursive прогон с параллельными пакетами завершился ошибкой cli-adapters без assertion output. Прямой общий `vitest run --maxWorkers=4 --minWorkers=1 --reporter=verbose` прошёл: 153 passed / 2 skipped. Корневая команда `pnpm test` теперь запускает пакеты последовательно (`--workspace-concurrency=1`), чтобы не умножать worker pools нескольких Vitest процессов; assertions и таймауты не менялись.

Context: 50 тестов (24 прежних и 26 новых); core: 24 теста. Покрыты CAS corruption/symlink, происхождение/evidence, неизменяемость, task/session isolation и role spoofing, expiry/base/source freshness, snapshot-relative history, promotion/idempotency, rollback атомарной finding-публикации, полные критерии при малом бюджете и подсчёт всего JSON, source/provenance sections, research summary refs, кэш двух агентов, смена source hashes, superseded decisions и неизменяемость старых bundles.

Core проверяет обновление v2→v3 с legacy данными, refresh/evidence integration, отказ для чужого base/неуспешного check, registered task worktree и task binding. Дополнительный интеграционный тест передаёт реальный broker bundle в fake Codex CLI и проверяет поступившие acceptance, inline content и snapshot. Авторизованные запросы к моделям не запускались.

## Границы и отклонения

1. CAS расположен вне repository и task worktree, а не в проектной `.adw/artifacts`: данные сервиса не попадают в patch/index. Namespace общий для одного project root, freshness зависит от выбранного source snapshot.
2. Оценка токенов — UTF-8 bytes/4, не tokenizer модели и не гарантия provider context limit. При превышении обязательным текстом 1 MiB возвращается ошибка без усечения. Optional sections выбираются целиком.
3. Иерархическое semantic summarization не запускается: поддерживается явный research summary и ссылка на оригинал. Проценты экономии токенов не заявляются; доступна статистика cache hits.
4. Проверка evidence подтверждает существование, hash, ownership/base успешного check, но не доказывает автоматически смысл произвольного утверждения. Trusted writer конфигурирует core; это не удалённая auth/MCP граница.
5. Resource bounds и freshness checks не заменяют OS sandbox или атомарный snapshot живой файловой системы. GC/retention, MCP transport, Supervisor и UI пока отсутствуют.
6. Упомянутые superpowers skills отсутствуют в установленном каталоге; реализация выполнена непосредственно по плану. Git-коммиты недоступны: `.git` пустой и read-only.

Подробное API и ограничения: [Context README](../../packages/context/README.md).
