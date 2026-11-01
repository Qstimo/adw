# Этап 07 — API smoke и browser verification

Дата: 2026-11-01. Реализация по плану 07 / §8 ТЗ подготовлена. **Acceptance gate этапа пока не пройден: реальный HTTP/browser E2E блокируется sandbox permissions.** Следующий этап 08 не объявляется разблокированным.

## Реализовано

- Опциональная verifier.web config, строгие WebVerification/Scenario/AcceptanceCoverage contracts, same-origin HTTP(S) и поддерживаемые declarative browser steps.
- Managed foreground server с readiness marker/health poll, external HTTP reachability, timeout/cancellation/cleanup. Неуспешные required commands не запускают приложение/web checks.
- API GET smoke: status и flat JSON field types, bounded response, credential-header redaction, безопасная metadata и явный notVerified для недоступного транспорта/лимита/отмены.
- Playwright Core worker: Chromium contexts, click/visible/exact-text, PNG/DOM/console/network, WebM на failure. Media/manifest сохраняются в CAS вне worktree, с `proves: scenario_observation`. Runtime version metadata входит в browser fingerprint.
- Bounded evidence import, MIME signatures, запрет path traversal/symlinks, проверки целостности файла при чтении; child cleanup учитывает detached descendants Chromium на Linux.
- Acceptance IDs → scenario titles → immutable TaskSpec indices. Required failure/unexecuted scenario/missing map блокируют ready; optional failures остаются warnings/notVerified. Optional-only observations не обходят mandatory-check gate. Timeout учитывает и elapsed time, включая задержку event loop.
- VerifierRunner/Supervisor/GitVerifierFacade integration; Web policy копируется до agent run. Required binding проверяется до запуска, audit copy скрывает credential headers/URL query. Review видит coverage и media manifests, а не утверждение о полной корректности.
- JSON coverage хранится в существующей SQLite колонке, refs — в CAS/artifacts_json; Core DB остаётся v5. Context API отдаёт coverage. Review UI hook отмечает e2e/test/assertion/acceptanceMap/config paths.
- Demo server/page, acceptanceMap и browser scenario; новые web:pilot/browser:install commands. Default pnpm pilot сохраняет headless поведение этапа 06.

## Проверки

`pnpm typecheck`, `pnpm install --offline --frozen-lockfile` и unit/protocol/integration suite: **276 passed, 2 optional CLI probes skipped**. Эти тесты не означают прохождение настоящего browser gate.

Fixture 3 (+2), contracts 21 (+3), CLI adapters 48, context 50, Git 11, Verifier 52 (+41), Supervisor 56 (+1), Core 35 (+2). Synthetic transports/worker artifacts явно обозначены в названиях tests/helper; они проверяют pipeline/evidence/gates, но не имитируют состоявшийся live E2E в отчёте.

Проверены API status/schema/own keys (включая __proto__)/finite numbers/credentials/response limits/timeout, elapsed timeout при блокировке event loop, missing/optional/required coverage и spec binding, mandatory-check enforcement, browser report identity/completeness/nonzero exit, unsafe artifact paths/symlinks/signatures, video retention protocol, process cleanup с detached child, server readiness/exit/timeout/cancellation/non-loopback marker, command→app→API→browser→coverage order, SQLite persistence и запрет review после browser failure.

Также проверен bootstrap при удалённом generated runtime: frozen offline install заново извлекает package из verified vendor archive. Внешний pnpm store остался неизменённым.

## Реальные попытки и оставшийся gate

1. Native Node HTTP server не может выполнить listen на 127.0.0.1: ошибка EPERM.
2. Установленный Chrome был действительно запущен через Playwright. Он завершился на `crashpad ... socket.cc ... setsockopt: Operation not permitted (1)`; результат browser check — exitCode=null, notVerified=true, reason=browser_unavailable. Дополнительно проверен установленный Chromium headless shell: он также останавливается на socket shutdown с Operation not permitted; лог `/tmp/adw-phase07-headless-shell-probe.log`. Никаких настоящих screenshots/video успешного сценария не заявляется.
3. Полный pnpm web:pilot также реально запускался. Он возвращает needs_human, web criteria not_verified и exit 1; independent review/accept не запускаются. Main остаётся чистым и не меняет SHA.

Диагностические артефакты текущей сессии:

- Итоговый `/tmp/adw-phase07-real-web-final.log`, journal `/tmp/adw-e2e-pilot-IwQQii/journal.jsonl`: подтверждён `listen EPERM`, оба web criteria not_verified, review не запущен, mainClean/mainBaseUnchanged=true. Первый run также сохранён: `/tmp/adw-phase07-real-web-pilot.log`, journal `/tmp/adw-e2e-pilot-duFlWD/journal.jsonl`.
- `/tmp/adw-phase07-real-browser-probe.log`, browser CAS `/tmp/adw-phase07-browser-probe-87OqJk/evidence` с реальным launch error.

Для закрытия этапа нужен **успешный pnpm web:pilot вне текущего sandbox**, с разрешёнными loopback sockets/browser processes и установленными matching Chromium/FFmpeg:

```bash
pnpm browser:install
pnpm web:pilot
```

Ожидается exit 0, ready_for_human_review, approved independent review, passed API/browser/required coverage, реальные PNG/DOM/console/network refs, чистый main. Для red run: ADW_DEMO_RED_WEB=1 pnpm web:pilot должен блокировать ready и сохранить failure evidence/video.

## Отклонения и границы

- Registry недоступен (`connect EPERM` к настроенному proxy); global pnpm store read-only (`EROFS`). Использован неизменённый cached npm tarball Playwright Core 1.49.1 (2 MB) с проверенной integrity, local-link bootstrap и сохранёнными лицензиями. Источник/checksum: [vendor README](../../vendor/README.md).
- @playwright/test отсутствует в cache. Использован собственный bounded Core worker и declarative JSON scenario вместо test-runner/spec reporter. Поддерживаются click/visible/text; arbitrary JS .spec.ts и общий JSON Schema resolver не реализованы.
- Наличие установленных Chromium/Chrome не преодолевает syscall restrictions sandbox; сторонние browser revisions не выдаются за проверенную совместимость. Браузеры автоматически при pnpm install не скачиваются.
- Coverage относится только к выбранным mapped scenarios, media — наблюдения, не full correctness. DOM/screenshots/application logs могут содержать данные приложения; tests должны использовать контролируемые данные.
- Процессные/file/output bounds не являются OS memory/CPU/network sandbox. Управляемый server должен оставаться foreground; crash recovery/retention/GC и visual LLM review не добавлены.
- Запросов к моделям и automatic merge/accept не было. Gate нельзя обойти скрытым environment flag.
- Упомянутые superpowers skills отсутствуют; работа выполнена непосредственно по плану. Git commits недоступны: .git пустая/read-only.

API и setup: [Verifier README](../../packages/verifier/README.md).
