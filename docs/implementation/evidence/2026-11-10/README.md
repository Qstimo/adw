# Реальные проверки 2026-11-10

`green/` и `red/` содержат полные run.log, journal.jsonl, summary.json и CAS blobs с исходными SHA-256 адресами (первые два символа — каталог). Все сохранённые CAS blobs проверены по SHA-256. Green: exit 0, ready_for_human_review, approved. Forced-red: exit 1, needs_human, required browser failure блокирует review. Main чистый и SHA сохранён в обоих случаях.

HTTP/API и Chromium настоящие; executor/reviewer — FakePilotAdapter, модельных запросов нет. Green сохраняет PNG/DOM/console/network, red также failure WebM. Эти артефакты не подтверждают ручной DoD.

Среда: Node 22.12.0, pnpm 10.18.3, Linux 7.0.0-38-generic, Chromium 131.0.6778.33 (Playwright 1148), FFmpeg 1010.

Native Electron 38: adw-native-direct.log фиксирует ненастроенный SUID helper; adw-native-userns.log — отсутствие пригодного namespace sandbox. Окно не открылось, native smoke не пройден. `--no-sandbox` не использовался. Нужна настройка системного runtime администратором, затем ручной DoD.

## Успешный повторный native smoke

Блокировка выше устранена локальной ссылкой runtime helper на существующий `/opt/google/chrome/chrome-sandbox`. Electron 38.8.6 открыл окно с sandbox=true, contextIsolation=true, nodeIntegration=false. process/require в renderer отсутствуют. native-smoke.json и native-smoke.png сохраняют результат. Системные настройки не менялись. Native dialogs и ручной CLI DoD ещё не проверены.
