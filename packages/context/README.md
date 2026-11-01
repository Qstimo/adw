# Context Engine — этапы 03–04

`@adw/context` предоставляет L1 Project Index без LLM/embeddings. Он хранит карту файлов, SHA-256, символы, imports, manifests и найденные scripts, поддерживает FTS5 и literal ripgrep search по сохранённым снимкам.

## Использование

Нужны Node.js 22.12+, `rg` в PATH и `better-sqlite3` с FTS5. Зависимости устанавливаются из корня workspace.

```ts
import { ProjectIndexer } from '@adw/context';

const index = await ProjectIndexer.build({
  projectId: 'proj_demo',
  repoPath: '/path/to/repository-or-task-worktree',
  baseCommit: '<40 lowercase hex characters from the Git service>',
  dbPath: '/path/to/workstation-data/index.sqlite',
});
try {
  const map = index.getProjectMap();
  const result = await index.searchCode({ query: 'function add', scope: 'src' });
  const literal = await index.searchCode({ query: '[a+b]', scope: 'src', engine: 'ripgrep' });
  const update = await index.reindexChanged();
  console.log(update.changedPaths, update.deletedPaths, update.staleArtifactHints);
  const source = index.getSource('src/add.ts', map.snapshotId);
} finally {
  index.close();
}
```

`baseCommit` — валидный SHA, переданный Git-сервисом; `WORK_TREE` не принимается. Indexer не разрешает ветки и не проверяет существование commit: он фиксирует наблюдаемые байты рабочей папки относительно переданного anchor. Dirty/untracked-файлы могут входить в снимок; их точные content hashes отличают его от других состояний с тем же base SHA. Согласованность base с задачей контролирует вызывающий core/supervisor.

`dbPath` задаёт отдельную index DB, а не основную БД core. Файл должен находиться вне репозитория; симлинк в репозиторий также отклоняется. БД с чужими таблицами или неподдерживаемой версией не переиспользуется. Без dbPath создаётся приватная временная БД, удаляемая при close; `:memory:` также поддерживается. close идемпотентен, но во время reindex нужно сначала дождаться его завершения.

## Снимки и incremental update

Snapshot ID зависит от project ID, канонического repo path, base SHA, parser version, limits, путей/хэшей файлов и предупреждений. Снимки не переписываются. `getProjectMap(snapshotId)`, `getSource(path,snapshotId)` и searchCode с snapshotId доступны для истории того же проекта. Чужой project snapshot не читается.

`reindexChanged({baseCommit?})` повторно перечисляет/хэширует допустимые файлы. У неизменённых полностью переиспользуемых файлов сохраняется updatedAt и копируются готовые facts; AST/manifest analysis выполняется для изменённых или зависимых от изменившегося resource budget данных. Новые/удалённые/исключённые пути попадают в staleArtifactHints. Смена base создаёт отдельный snapshot и даёт hints для всех старых/новых путей.

Source content и FTS документы дедуплицируются по SHA-256; metadata/facts копируются в новый snapshot. Старые записи не удаляются автоматически. Это сохраняет историю, но размер БД растёт; retention/GC в этапе 03 не реализован. Переоткрытие persistent DB переиспользует последние facts. Перекрывающиеся обновления одного экземпляра отклоняются; публикация выполняется одной SQLite-транзакцией после scan. Файловая система не блокируется на всё время scan: snapshot описывает прочитанные bytes, а broker должен проверять свежесть при использовании.

## Поиск и извлечение

FTS5 использует AND из экранированных поисковых слов. Scope — относительный POSIX-путь файла или каталога, без traversal; `%`/`_` не становятся wildcard. Результаты упорядочены по path, чтобы глобальный FTS corpus других проектов/истории не менял ответы на старый snapshot. Ranking контекста относится к этапу 04.

Ripgrep получает объединённые замороженные source bytes через stdin и возвращает точные literal matches с исходными path/lineNumber. Он не ищет по изменившейся live-папке и работает даже после её удаления, пока индекс открыт. Не включаются shell, regex-интерпретация query или пользовательский rg config. Внешняя команда ограничена timeout/output budget. UTF-8 chunks, BOM, CRLF и файл без последнего newline сохраняют корректную привязку; raw content hash проверяется при чтении source/search результатов.

SearchResult включает snapshotId, baseCommit, complete, warnings и hits. FTS limit ограничивает path hits, ripgrep limit — matching lines. По умолчанию limit 20, максимум 100; query — непустая строка до 1000 символов без newline/NUL. Превышение output budget ripgrep завершает запрос ошибкой, а не неполным успешным ответом.

## Walk, syntax и manifests

Walk уважает `.gitignore`, включает обычные hidden files, исключает `.git`, `.adw`, `node_modules`, `.aws`, `.ssh`, `.codex`, `.claude`, `.env*`, `*.pem`, `*.key`. Симлинки не обходятся; binary и non-UTF-8 не попадают в индекс. Безопасный relative-path guard также действует на прямое чтение source. SourceHashes считаются по целым bytes, а не усечённому preview.

Tree-sitter/грамматики недоступны в установленном offline cache. В этом этапе использован TypeScript 5.9.3 AST (`parser.version` содержит revision), вместо пропуска symbol tests. Поддерживаются TS/TSX/JS/JSX, declarations и статические import/export/require/import() literals; синтаксические ошибки дают partial status. Это syntax index, а не TypeChecker: aliases/package exports и динамические выражения не разрешаются. Для относительных specifiers проверяются обычные extension/index candidates, включая `.js` → `.ts`.

package.json и tsconfig/jsconfig извлекаются детерминированно; JSONC разрешён для configs. Команды — raw scripts с manifestPath/cwd; они не выполняются. Выбор package manager и запуск проверок остаются задачей core/verifier. Некорректный manifest остаётся searchable text с явным warning.

## Ограничения

Defaults: maxFiles 10 000 кандидатов в отсортированном списке; maxFileBytes 512 KiB; maxTotalBytes 32 MiB; maxListBytes 2 MiB; maxFacts 100 000; timeoutMs 20 000. Один файл ограничен 5000 symbol/import facts. Настройки передаются через limits и валидируются; сохранённый policy object заморожен.

Пропускаются целые файлы с warnings: усечённый content hash не публикуется. Общий byte budget учитывает и фактически прочитанные skipped binary/invalid files. complete=false явно показывает неполноту. Слишком большой listing или ошибка rg прерывают публикацию и оставляют прежний snapshot доступным. Deadline scan проверяется между операциями; синхронный TypeScript parser/SQLite commit не являются жёстким OS CPU/RAM limit. Проверено на Linux.

```bash
pnpm --filter @adw/context typecheck
pnpm --filter @adw/context test
```

В этапе 03 реализован индекс. ArtifactStore и ContextBundle builder добавлены этапом 04 ниже; watchers, MCP server и agent session sync пока отсутствуют.

## ArtifactStore и Context Broker

Core DB должна пройти `migrate(db)` до v3; index DB остаётся отдельной схемой v1. Артефакты, findings, promotions и bundles сохраняются append-only с аудитом. SQL triggers защищают историю от update/delete; явная invalidation фиксируется один раз. CAS проверяет SHA-256 при чтении, ограничивает размер и не следует симлинкам. Каталог данных должен находиться вне основной папки проекта и task worktree.

```ts
import { ContextFacade } from '@adw/core';

// db содержит project и зафиксированную задачу; index принадлежит этому проекту.
const facade = await ContextFacade.create(db, index, {
  dataDir: '/path/to/workstation-data',
  // Для индекса task worktree обязателен worktree receipt от GitWorktreeManager.
});
const context = facade.forTask('task_demo', { sessionId: 'session_demo' });
const result = await context.read.buildBundle({
  agentId: 'codex', tokenBudget: 8000, query: 'router', paths: ['src'],
});
// result.bundlePath передаётся CLI adapter как путь к готовому JSON.
```

`ContextFacade.create` проверяет регистрацию и base SHA task worktree, связывает API с её задачей; основной repo root допускает прямой constructor. Перед build facade обновляет индекс, объединяя конкурентные refresh одного экземпляра. Низкоуровневые `ArtifactStore`, `ContextBroker` и `createContextAPI` экспортированы для core/test consumers.

Read API: `getProjectMap`, `searchCode`, `getArtifact`, `getDecisions`, `getTaskFindings`, `getTestHistory`, `buildBundle`. Write API: `publishArtifact`, `publishFinding`, `promoteFinding`, `invalidateArtifact`. Scope project/task/session задаёт сервис: агент не может переопределить его аргументами. Project context читается только для verified артефактов с evidence; task/session context ограничен соответствующей задачей/сессией. Исторические findings без provenance видны с `missing_provenance` и не продвигаются.

Обычный API не разрешает публикацию verified, project visibility, продвижение или ручную invalidation. `forTask(taskId, {trusted:true})` предназначен только для независимого проверяющего core. Это доверенная конфигурация in-process сервиса, а не authentication server. `importCheckEvidence(checkId,{taskId})` копирует evidence только успешного check той же задачи/base из настроенного `evidenceStore`; зелёный check сам по себе не подтверждает произвольное утверждение агента.

Все артефакты имеют base SHA, producer, source paths/hashes и confidence. Verified дополнительно требует существующие CAS evidence refs и свежие source hashes. Promotion создаёт новый project artifact, сохраняя исходный; повторный вызов идемпотентен. Verified и inferred decisions сохраняются независимо, выбор текущей версии учитывает logicalKey/paths и confidence.

Freshness сравнивается с конкретным immutable index snapshot: другой base, изменение/удаление source, expiry или ручная invalidation исключают артефакт из обычной подборки. `revalidateAgainstIndex` возвращает stale IDs и пишет аудит, но не отзывает историю глобально: private worktree не должна инвалидировать данные другого снимка. `getArtifact` сохраняет доступ к исходному содержимому с причинами stale; решения поддерживают явный history режим.

Bundle содержит inline content, provenance, точные source ranges/hashes, source refs, snapshot/base и полный task intent/acceptance/outOfScope. Бюджет измеряется по всему сериализованному JSON приблизительно как UTF-8 bytes/4; это не tokenizer модели. Критерии не обрезаются: если обязательный контекст превышает бюджет, bundle получает `overBudget` и warning без optional sections. Обязательный контекст свыше 1 MiB отклоняется ошибкой. Готовый bundle неизменяем и записывается в CAS/SQLite с аудитом; перед публикацией повторно проверяются task/index/freshness.

Ranking учитывает confidence, path/query relevance и размер. Lossless-first означает дедупликацию refs и выбор целых sections. Только `research` допускает явно предоставленный summary; сохраняются ссылки и на summary, и на оригинал. Решения и acceptance автоматически не пересказываются. Запросов к модели нет.

Ограничения: bundle 1 MiB, тело/summary артефакта по 4 MiB, CAS blob до 16 MiB, материализация кандидатов до 128 артефактов/8 MiB. Кэш кандидатов до 64 entries/8 MiB, отдельная entry до 2 MiB; ключ включает repository/base/snapshot/hashes/query/summary version и scoped metadata. Другой agent может переиспользовать кандидатов без изменения собственных bundle metadata. Метрики отражают cache hits; экономия токенов не заявляется. GC/retention, MCP/auth transport, semantic verification и Supervisor относятся к следующим этапам.
