# Исправления по ревью этапов 00–02

Дата: 2026-10-31. Все четыре замечания воспроизведены регрессионными тестами до изменения production-кода, затем исправлены.

## 1. Приёмка проверенного снимка

Добавлены `PatchSnapshotSchema`, `capturePatchSnapshot` и `samePatchSnapshot`. Снимок содержит taskId, baseCommit, headCommit и SHA-256 binary diff. `acceptPatch` теперь обязательно принимает `expectedSnapshot`: старые вызовы без него отклоняются TypeScript и runtime-валидацией.

Текущая worktree должна быть чистой и совпадать с ожидаемым снимком. Diff читается из закреплённого commit SHA; проверяется его hash, затем Git tree применённого индекса сравнивается с tree исходного commit. Состояние task worktree и drift основной ветки проверяются повторно перед созданием acceptance commit. Если исходная ветка движется после последней проверки, применяемые байты всё равно принадлежат закреплённому проверенному commit.

Facade фиксирует snapshot до checks и сравнивает его после. Изменение HEAD или tracked/untracked dirty state блокирует readiness, помечает результаты notVerified и не выдаёт verifiedSnapshot. У стабильного успешного запуска verifiedSnapshot совпадает со snapshot_json в verification_runs.

Важно: snapshot — идентификатор кода, а не криптографическое удостоверение прохождения тестов. Доверенный вызывающий сервис должен передавать снимок успешной проверки, а не заново снимать его после непроверенных изменений. Независимый review и human approval остаются следующими этапами.

## 2. Атомарный verification-run

Добавлена SQLite-миграция v2: таблица verification_runs, уникальный partial index на один running run для task и nullable FK verification_run_id у check_results. Исторические результаты сохраняются с NULL run ID.

Task claim, создание run ID и audit verification_started выполняются одной IMMEDIATE-транзакцией до первого await. Второй facade/процесс с отдельным DB connection не может запустить ту же задачу параллельно. Перед записью результатов и перед failed-finalization проверяется владение конкретным run ID. Устаревший callback не перезаписывает состояние задачи или replacement run; его собственная незакрытая lease освобождается, событие фиксируется как verification_discarded.

Все verification audit events включают runId; результаты и snapshot связаны с тем же запуском. Crash recovery активного run должен реализовать будущий supervisor; новое поведение не снимает живые locks автоматически.

## 3. Очистка acceptance-ветки

Ветка создаётся отдельно атомарным update-ref create-if-absent внутри try. Владение новой веткой и успешное создание worktree отслеживаются отдельно. Ошибка worktree add удаляет только собственную новую ветку и сохраняет занятый пользовательский каталог. Повторная попытка после освобождения пути работает.

При rollback удаляется только известная собственная worktree. Ref удаляется с проверкой ожидаемого tip и только если он не используется worktree; существующая пользовательская ветка не удаляется. Неудачная очистка возвращает AggregateError вместо сокрытия первичной ошибки. Acceptance commit строится через commit-tree из проверенного tree и обновляется CAS-операцией.

## 4. Собственные source hashes

Проверка sourcePaths использует Object.hasOwn. Hash map валидируется по собственным entries и безопасно пересобирается через Object.fromEntries. Для constructor, toString и __proto__ отсутствие собственного hash отклоняется; корректный собственный hash принимается без изменения прототипа объекта.

## Проверки

- Новые тесты сначала воспроизвели дефекты прежнего кода: stale patch принимался, ветка оставалась, два facade запускали одну задачу и inherited keys проходили без hash.
- Регрессии проверяют обязательный snapshot и его hash, отказ изменённому после успешных checks коду, сохранение чужих файлов, retry acceptance, сохранение существующей ветки, rollback при ошибке commit, конкурентные DB connections, fencing старого owner и сохранение cancelled state.
- Отдельно проверены обновление БД v1 → v2 с данными и историческими check_results, идемпотентность и rollback неудачной миграции v2.
- `pnpm typecheck` и `pnpm test`: PASS, всего 96 обычных тестов; 2 optional CLI probes пропущены. Реальные запросы к моделям для исправлений не запускались.

Git-коммиты по-прежнему недоступны: рабочий .git пуст и смонтирован read-only.
