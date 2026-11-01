# Desktop DoD — ручной прогон (не выполнен)

Нужны Linux desktop с Electron, системный Node, pnpm, разрешённые sockets/browser processes и настроенные CLI. Используйте отдельную копию demo repo, без ценных незакоммиченных данных. Не выполняйте запросы к моделям до проверки spec, commands, limits и privacy в нативном диалоге.

- [ ] `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm desktop:build` успешны.
- [ ] `pnpm browser:install` и `pnpm web:pilot` проходят реальный gate 07 с PNG/video/DOM/console/network evidence. Сохранить результат и версии среды в отчёте 07.
- [ ] `pnpm desktop:start` открывает окно без отключения sandbox. При отсутствии Node показана понятная ошибка запуска.
- [ ] Project: выбрать demo Git root нативным picker, отменить повторный picker, проверить branch/HEAD/dirty/worktrees и privacy. Выбор не вызывает модели.
- [ ] Task: создать draft, изменить отдельный многострочный критерий без потери пробелов, выбрать base branch, checks/limits. Перезапустить приложение, выбрать тот же repo и открыть Task ID из hash/истории.
- [ ] Отменить нативный spec dialog: draft остаётся изменяемым. Подтвердить: spec/policy блокируются. Проверить, что фактические команды и ограничения совпадают с preview.
- [ ] Запустить задачу реальными авторизованными CLI; видеть DAG, назначения/причины в events и usage. Проверить Stop на отдельном запуске; потом проверить успешный цикл на новой задаче.
- [ ] Context: проверить свежесть, provenance/source paths, cache hits, bounded artifact viewer; исходные файлы не редактируются в приложении.
- [ ] Verification: required failure и notVerified явно видны и блокируют acceptance. Просмотреть PNG/video и DOM как текст; HTML/скрипты не исполняются.
- [ ] Review: сверить unified diff, изменённые тесты и blocking remarks. Отменить native acceptance: Git не меняется. Принять approved exact snapshot: отдельная acceptance branch/checkout, main сохранён, push не выполняется.
- [ ] На другой задаче отклонить patch с причиной, проверить native cancellation и подтверждённое удаление только managed worktree.
- [ ] Закрыть приложение во время запуска: child получает EOF/cancellation, lock освобождается штатно. Для SIGKILL не снимать leases автоматически; reconciliation остаётся отдельной операцией.
- [ ] Проверить preload: renderer не получает Node/process/host token, `project.open` и произвольные методы отклоняются; subframe/new window/navigation не обходят host gate.

Записать дату, OS/Node/Electron/CLI версии, repo SHA, task/run/review IDs, результаты и evidence refs. До успешных real web + native smoke + полного ручного цикла этап 08 не считается завершённым; 09–10 не начинаются.
