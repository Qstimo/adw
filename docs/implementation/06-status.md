# Этап 06 — Independent Review Engine

Дата: 2026-11-01. Реализован план 06 / §6 Reviewer и §8 ТЗ. Следующий этап — 07: web verification.

## Результат

- Review Engine добавлен в `@adw/supervisor/src/review` — один из вариантов размещения, разрешённых планом. Отдельный package не нужен для текущего последовательного runtime.
- Строгие Zod-контракты ReviewRemark, ReviewResponse, ReviewerSession и ReviewVerdict: categories, severity, path/ranges, evidence, count/status consistency. Approved требует обеих завершённых code/security passes, валидного снимка и отдельных сессий. Reviewer не присваивает своим замечаниям verified.
- Diff collector читает закреплённый HEAD/base и сверяет SHA-256 с прошедшим checks snapshot. Unified diff, rename/binary metadata, test-path flags и исходный binary-capable patch сохраняются в evidence CAS. Git diff во всех сервисах отключает external diff, textconv и color, чтобы конфигурация репозитория не запускала diff helpers и не меняла канонический patch.
- После зелёных checks всех DAG nodes Supervisor входит в reviewing. Code и security запускаются последовательно в новых сессиях без resume, с immutable spec, точным diff, check evidence и актуальным Context Bundle. Предпочитается другой eligible agent, иначе используется новая сессия того же adapter.
- Runtime и provider session IDs проверяются против всех executor sessions и предыдущей review session. Роли, supervisor run ID и обе identity записываются в agent_sessions. Review usage и timeout входят в общий бюджет run.
- CLI reviewer role имеет отдельный проверяемый compatibility profile: Codex `--sandbox read-only`; Claude без built-in tools, с пустым strict MCP config и отключёнными slash commands. Обязательные flags проверяются локальным help. Unknown profile или reviewer resume отклоняются. После каждой сессии дополнительно проверяется committed snapshot.
- Reviewer возвращает только JSON remarks; verdict вычисляет Engine. Malformed JSON, unknown fields, category/path/evidence mismatch, повтор session ID, изменение patch или неполный input → inconclusive. Любое blocking remark → changes_requested. Только полный approved review допускает ready_for_human_review.
- Blocking verdict проходит через fix_needed в needs_human; inconclusive тоже требует ручного разбора. Advisory remarks сохраняются вместе с approved verdict для решения пользователя. Автоматической приёмки нет.
- Core DB v5: immutable review_runs/review_findings, session provenance, review acceptance claim и SQL guard перехода утверждённых supervisor tasks в accepted. Remarks атомарно сохраняются как task findings с inferred/unverified confidence, source provenance и CAS evidence. Продвижения в project facts автоматически нет.
- `acceptReviewedPatch` связывает явный human actor, конкретный approved review, завершённый supervisor run, proof CAS и точный snapshot. Повторная приёмка того же review идемпотентна; stale snapshot, blocking/inconclusive verdict или отсутствие actor блокируются. Создаётся отдельная acceptance-ветка, main не перемещается.
- Пилот обновлён: fake executor → настоящие typecheck/unit → две независимые fake review sessions → ручное решение. Авторизованных запросов к моделям нет.

## Проверки

`pnpm install --offline --frozen-lockfile`, `pnpm typecheck` и `pnpm test`: **227 passed / 2 optional live CLI probes skipped**.

Contracts 18 (+3), CLI adapters 48 (+3), Supervisor 55 (+27), Core 33 (+6); прежние context 50, Git 11, Verifier 11 и demo 1 сохранены. Новая миграция проверена с legacy sessions и rollback всех ALTER/DDL при конфликте v5.

Покрыты exact spec/diff/check evidence в review prompt, security checklist, fresh same-adapter fallback и preference другого adapter, runtime/provider session reuse, blocking/advisory aggregation, malformed/fenced/extra-field JSON, поддельные refs/paths, source mutation, binary changes и lossless limits, mandatory review при ADW_SKIP_REVIEW=1, общий usage budget и timeout reviewer, immutable verdict/finding links, человеческая приёмка, её идемпотентность, блокировки rejected review/stale patch, fencing позднего cleanup после замены acceptance claim и сохранность main.

Diff test проверяет renamed path с tab, binary metadata/test flags и игнорирование настроенного external diff helper. Пилот имеет зелёный сценарий через review и принудительно красный unit, который не доходит до review/готовности. Контрольный `pnpm pilot` завершился exit 0: ready_for_human_review, review approved, mainClean/mainBaseUnchanged=true. Его временный журнал: `/tmp/adw-e2e-pilot-wC4168/journal.jsonl`.

## Границы и отклонения

1. Нет environment bypass ревью, даже для tests: тесты предоставляют явные fake reviewer responses. Optional ADW_SKIP_REVIEW из плана сознательно не добавлен, чтобы результат не зависел от скрытого environment flag.
2. Reviewer — новый session, предпочтительно другой agent. Выбор другой модели внутри одного CLI не реализован; session freshness проверяется по runtime ID и provider ID, когда последний доступен.
3. Review input не усекается: unified diff до 512 KiB, check stdout/stderr суммарно до 256 KiB, prompt до 1 MiB, response до 256 KiB. Слишком большой input даёт inconclusive. Git subprocess output ограничен 4 MiB; сам snapshot capture использует прежний bounded Git helper.
4. Binary changes перечисляются и сохраняются в CAS, но не получают approved без дополнительных независимых evidence. Visual/browser review и его screenshots относятся к этапу 07. Security checklist не является полноценным SAST.
5. CLI read-only policy и snapshot guards защищают путь сертификации patch; они не являются универсальной OS/network/MCP sandbox. Codex read-only относится к native sandbox; пользовательские расширения/интеграции требуют отдельной политики. In-process core API доверенный: approvedBy не является authentication-протоколом; его нельзя предоставлять executor API.
6. Low-level `@adw/git.acceptPatch` остаётся Git-примитивом с snapshot guard. Продуктовая приёмка supervisor tasks должна идти через `acceptReviewedPatch`, который проверяет независимое review и human action. Context API не предоставляет метод принятия patch.
7. Review findings — утверждения reviewer с происхождением, а не автоматически verified facts. Их evidence доказывает, какой diff/check/output был рассмотрен, но не формальную истинность каждого замечания.
8. Review changes_requested/inconclusive эскалируются человеку; автоматический цикл исправлений по review замечаниям не добавлен. Прежние до трёх fix cycles по независимым checks сохранены. Git и SQLite не образуют общую транзакцию: после успешного Git accept и ошибки записи DB claim сохраняется для ручного reconcile, без повторного применения patch.
9. Исторические tasks/runs/sessions сохраняются, но не получают фиктивный approved review при миграции. Старая готовность без review не даёт разрешения через новый acceptance API. Recovery/retention/GC остаются прежними ограничениями.
10. Упомянутые superpowers skills отсутствуют в доступном каталоге; реализация выполнена непосредственно по плану. Коммиты недоступны: `.git` пустая и read-only.

API и ограничения: [Supervisor README](../../packages/supervisor/README.md).
