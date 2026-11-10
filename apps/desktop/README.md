# ADW Desktop

Рабочая Electron + React оболочка для workspace core. Native Linux startup smoke пройден 2026-11-10 с Electron 38.8.6 и включённым sandbox; полный stage 08 DoD остаётся открытым.

```bash
pnpm install --frozen-lockfile
pnpm desktop:build
pnpm desktop:start
```

Для последней команды нужен отдельно установленный Electron (38+ как минимальная целевая версия) в PATH. В offline cache нет npm-пакета Electron и Linux runtime, поэтому зависимость не включена в обязательный install. На машине с сетью можно установить runtime вне workspace, например `npm install --prefix /tmp/adw-electron --no-save electron@38`, и запустить `/tmp/adw-electron/node_modules/.bin/electron apps/desktop`. Версия 38 — целевая для проверки, реальная совместимость пока не подтверждена. Не отключайте Electron sandbox для smoke.

Main запускает `node` из PATH; `ADW_NODE_BINARY=/absolute/path/to/node` позволяет выбрать системный Node >=22.12. SQLite использует ABI этого Node, а не Electron. Данные хранятся в Electron userData/core вне repo. Сборка зависит от текущего workspace и node_modules; перенос одного dist не поддерживается.

Выберите Git root через нативный диалог. В Project отображаются status/worktrees/privacy; на Task создайте draft, проверьте checks/limits и утвердите их через диалог ОС. Утверждение блокирует поля. Запуск агентов требует отдельной кнопки «Запустить» и заранее настроенных/авторизованных CLI. Открытие проекта не запускает моделей.

Context, Verification и Review доступны после выбора задачи. Task ID в hash можно открыть после выбора соответствующего repo. Остановка использует текущий run ID. Review acceptance создаёт управляемую acceptance branch и не выполняет push. Отказ удаляет managed task worktree после подтверждения. Если IPC истёк по времени, обновите состояние до повторного действия.

Evidence viewer ограничен 16 MiB, читает CAS refs только текущей задачи. Изображения PNG/JPEG/WebP/GIF и видео WebM/MP4 отображаются через blob URL; всё остальное, включая HTML/SVG, — текст. Произвольные пути, shell, source editor и Node API renderer не доступны.

```bash
pnpm --filter @adw/desktop test
pnpm --filter @adw/desktop typecheck
```

DOM тесты используют JSDOM; host-тесты проверяют native dialog flow с doubles. Отдельный тест подключается к реальному собранному core и Git/SQLite. Ручная проверка: [DoD checklist](../../docs/superpowers/plans/dod-manual-checklist.md).

## Проверенный запуск в текущем окружении

```bash
/tmp/adw-electron/node_modules/electron/dist/electron apps/desktop
```

Electron runtime установлен в `/tmp` и использует ссылку `dist/chrome-sandbox` на существующий системный `/opt/google/chrome/chrome-sandbox` (root, 4755). Исходный helper сохранён как `dist/chrome-sandbox.original`. Настройки ОС не изменялись. Runtime временный; этот путь не является переносимой установкой приложения.

Результат native startup smoke: [отчёт](../../docs/implementation/evidence/2026-11-10/native-smoke.json). Проверка полного цикла с реальным CLI остаётся открытой.
