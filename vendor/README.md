# Playwright Core для offline bootstrap

`playwright-core-1.49.1.tgz` — неизменённый npm package archive, взятый из существующего локального npm cache. Npm cache integrity (SHA-512) проверена перед копированием. Источник, указанный в cache metadata: https://registry.npmjs.org/playwright-core/-/playwright-core-1.49.1.tgz

SHA-256: `fc7544a2dbc24341dfc63c4a67c62ce593bc2e7e3257690f2d12d2f7d2b2d636`.

Archive содержит оригинальные LICENSE (Apache-2.0), NOTICE и third-party notices. Root `scripts/prepare-playwright.mjs` проверяет hash, version/name и извлекает package в `.adw/playwright-core` через temporary directory. Незавершённое извлечение не считается готовым. Нужен tar в PATH. Runtime cache игнорируется Git; tarball нужен для воспроизводимого bootstrap без registry и записи в global pnpm store.

Это конкретная доступная в offline cache версия, не рекомендация latest. @playwright/test отсутствовал в cache; реализация использует Core API в bounded worker. Chromium/FFmpeg не входят в archive и устанавливаются отдельно через `pnpm browser:install`. Бинарники, уже имеющиеся на машине, относятся к другим revisions и не подменяются автоматически.

При обновлении нужно заменить archive, version и checksum в bootstrap, затем выполнить typecheck/unit tests и настоящий web:pilot с соответствующими browser binaries. Только после реального E2E можно обновлять статус gate этапа 07.
