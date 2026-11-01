# Demo fixture

Минимальный React/TypeScript-модуль для последующих Git/verifier-пилотов.

```bash
pnpm --filter @adw/demo-repo typecheck
pnpm --filter @adw/demo-repo test
FAIL_UNIT=1 pnpm --filter @adw/demo-repo test
```

Последняя команда должна завершиться ненулевым кодом: она включает известный красный тест без правки исходников. Переменная среды приведена для Linux/macOS.

`lint` временно запускает только TypeScript typecheck, как разрешено планом 00; полноценные lint-правила ещё не настроены. Это не browser E2E. Будущие проверки worktree должны копировать фикстуру и создавать временный Git-репозиторий, оставляя эту папку неизменной.
