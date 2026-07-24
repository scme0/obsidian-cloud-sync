# Implementation plan: unified sync engine + multipart + path-prefix endpoints

Working repo: `/data/workspace/cloud-drive-sync`, branch `monorepo-tauri-app` (do NOT work on
`main`). Heavy build/test work must run in disposable pods via `k8s-run` (sandbox policy):

```bash
k8s-run --image node:22 --dir cloud-drive-sync --cmd "npm install && npm run build --workspace=packages/obsidian-plugin && npm run test --workspace=packages/core"
# Tauri TS typecheck (no Rust build possible in sandbox):
k8s-run --image node:22 --dir cloud-drive-sync --cmd "./node_modules/.bin/tsc -p packages/tauri-app/tsconfig.json --noEmit --skipLibCheck"
```

Context docs: `notes/home/dev/de-google/services/drive.md` (overall architecture, decided
topology), `notes/home/dev/cloud-drive-sync/architecture.md` (monorepo layout). The
corresponding task list entries are #2–#6; mark them in_progress/completed as you go.

**Hard constraints for every step**

- The Obsidian plugin ships to real users via BRAT. Its observable Notes-sync behavior must
  not regress. `npm run build --workspace=packages/obsidian-plugin` (tsc + esbuild) must stay
  green after every step.
- Follow existing code style: tabs, no semicolon changes, comments only for non-obvious
  constraints. Conventional Commits; commit messages end with the Claude co-author line.
- New server infra already exists (deployed 2026-07-24, `home` repo `apps/rclone-drive/`):
  `https://s3.example.com/{alice,bob,shared}` → per-person `rclone serve s3`;
  `https://s3.example.com/{name}/webdav` → per-person `rclone serve webdav`
  (`--baseurl`). Same creds as the old `*-notes.example.com` endpoints. Old endpoints stay
  up until swap-over completes.

---

## Task #2 — S3 client: SigV4 path-prefix fix + multipart upload

Files: `packages/core/src/providers/s3/s3-api.ts`, `s3-provider.ts`, new
`packages/core/src/util/constants.ts`, new test `packages/core/tests/s3-multipart.test.ts`.

### 2a. Path-prefix (endpoint with a path component)

Today `buildAuthHeaders` builds `canonicalUri = "/" + encodePath(path)` where callers pass
`path = "{bucket}/{key}"` — correct only for path-less endpoints. With
`endpoint = https://s3.example.com/alice`, the real request path is
`/alice/{bucket}/{key}`; the signature must cover exactly that or rclone 403s every request.

Implementation: in `S3Api`, derive once from config:
```ts
private get pathPrefix(): string {
    // "" for https://host, "/alice" for https://host/alice (trailing slash stripped)
    return new URL(this.cfg.endpoint).pathname.replace(/\/$/, "");
}
```
`objectUrl`/`bucketUrl` need no change (they concatenate the full endpoint string already).
Change every `buildAuthHeaders(...)` call to prepend the prefix to the signed path — cleanest
is to change the `path` argument the callers pass from `this.objectPath(key)` to a helper
`this.signedPath(key)` returning `${prefixNoLeadingSlash}/{bucket}/{key}` — check how
`buildAuthHeaders` composes `canonicalUri` and keep the encoding identical (`encodePath` splits
on `/` and encodes segments; the prefix must go through the same encoding path, not be
concatenated post-encoding by different rules).

Unit-test with a fake `HttpClient` capturing requests: same operation against
`https://h/alice` vs `https://h` must produce different `authorization` signatures and URLs,
and against `https://h` must produce byte-identical canonical behavior to today (regression
guard: existing endpoints must keep working unchanged — that's the live Notes sync).

### 2b. Multipart upload

New constants in `packages/core/src/util/constants.ts`:
```ts
export const HASH_VERIFY_THRESHOLD_BYTES = 50 * 1024 * 1024;  // used by Task #3
export const MULTIPART_THRESHOLD_BYTES = 80 * 1024 * 1024;    // under Cloudflare's ~100MB body cap
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;    // ≥ S3's 5MB min; retry granularity
```

New `S3Api` methods (all reuse `buildAuthHeaders` — it already handles arbitrary sorted query
params — and the injected `this.http`):

```ts
async createMultipartUpload(key: string): Promise<string>
// POST {objectUrl}?uploads  (query {uploads: ""}), parse <UploadId> from XML response text.

async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string>
// PUT {objectUrl}?partNumber=N&uploadId=X with body; x-amz-content-sha256 over THIS PART's
// bytes (same pattern putObject uses). Return the ETag response header, quotes stripped.
// HttpResponse.headers keys are lowercase in both implementations — read "etag".

async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>
// POST {objectUrl}?uploadId=X, XML body:
// <CompleteMultipartUpload>(<Part><PartNumber>N</PartNumber><ETag>"..."</ETag></Part>)*</CompleteMultipartUpload>
// Parts MUST be sorted ascending by partNumber. Body hash = sha256 of the XML bytes.

async abortMultipartUpload(key: string, uploadId: string): Promise<void>
// DELETE {objectUrl}?uploadId=X. Accept 204/200/404 as success (matches deleteObject's tolerance).
```

`S3Provider.uploadFile` and `updateFile`: when `content.byteLength >= MULTIPART_THRESHOLD_BYTES`,
route through a private `uploadLarge(key, content, mimeType)`:
create → slice into `MULTIPART_PART_SIZE_BYTES` chunks (last chunk may be smaller) → upload
**sequentially** → on any part failure call `abortMultipartUpload` then rethrow with context
(`multipart upload failed at part N/M: <cause>`) → complete with parts sorted ascending.
No concurrency (no memory benefit — buffer is fully resident anyway; keeps abort handling simple).

Tests (`s3-multipart.test.ts`, fake `HttpClient` recording requests, canned XML responses):
- create/parts/complete happy path: URL shapes, part ordering in the XML manifest, etag quote
  stripping, sequential ordering.
- canonical query-string for the empty-value `uploads=` param (nothing exercises empty query
  values today — verify it renders `uploads=` per AWS SigV4 spec in the signed canonical
  request, not `uploads` bare).
- part-2 failure → abort called with the right uploadId, error message includes part number.
- threshold routing: `uploadFile` with byteLength just below/above `MULTIPART_THRESHOLD_BYTES`
  takes single-PUT vs multipart respectively.

**Known server-side caveat (do not "fix" client-side)**: rclone `serve s3` buffers the whole
object in memory during multipart (rclone/rclone#7453; fixed on master, unreleased as of
1.74.4). The deployed pods have a 5Gi limit for this. Part size does not affect server memory.

---

## Task #3 — Unified sync engine in `packages/core`

The big one. Port the algorithm of
`packages/obsidian-plugin/src/sync/sync-engine.ts` (~1000 lines — READ IT FULLY FIRST) into a
new `packages/core/src/sync/sync-engine.ts` that depends only on core ports, then delete
`packages/core/src/sync/mirror-sync-engine.ts` (+ its test file). The Obsidian shell keeps its
modals; the engine must never import from `"obsidian"`.

### 3a. Ports

`packages/core/src/fs/local-file-system.ts` — extend the existing interface:
```ts
export interface LocalFileEntry { path: string; mtimeMs: number; size: number; }
export interface LocalFileSystem {
    listFiles(root: string): Promise<LocalFileEntry[]>;        // exists
    readFile(root: string, relPath: string): Promise<Uint8Array>;   // exists
    writeFile(root: string, relPath: string, content: Uint8Array): Promise<void>; // exists
    deleteFile(root: string, relPath: string): Promise<void>;  // exists
    listFolders(root: string): Promise<string[]>;              // NEW: recursive rel paths, dotfiles excluded
    createFolder(root: string, relPath: string): Promise<void>; // NEW (recursive mkdir)
    deleteFolder(root: string, relPath: string): Promise<void>; // NEW (recursive)
    statFile(root: string, relPath: string): Promise<LocalFileEntry | null>; // NEW: single-path stat (null if missing) — needed by syncPaths
}
```

New `packages/core/src/sync/sync-ui-port.ts`:
```ts
export type FirstSyncStrategy = "download" | "upload" | "merge";
export interface SyncIssue {
    vaultPath: string;
    type: "conflict" | "delete-conflict" | "error";
    remoteId?: string;
    localModTime?: number;
    remoteModTime?: number;
    errorMessage?: string;
}
export interface SyncIssueResolution {
    vaultPath: string;
    resolution: ConflictResolution | "retry";
    remoteId?: string;
}
export interface SyncUIPort {
    chooseFirstSyncStrategy(): Promise<FirstSyncStrategy>;
    resolveSyncIssues(issues: SyncIssue[]): Promise<SyncIssueResolution[]>;
    // Optional debug hook: preview planned actions before execution. Obsidian
    // implements it with SyncPlanModal when settings.debugMode; return
    // {cancelled:true} to abort the pass. Engine skips the call if undefined.
    reviewPlan?(actions: SyncAction[], issues: SyncIssue[]): Promise<{ cancelled: boolean }>;
    // Optional external-merge hook (Obsidian desktop only). Engine calls it for
    // resolution "external"; implementations without it treat as "skip".
    externalMerge?(vaultPath: string, remoteId: string): Promise<void>;
}
```
These types currently live in `packages/obsidian-plugin/src/sync/{first-sync-modal,sync-results-modal}.ts`
and are imported *backwards* by the old engine — move the type definitions to core, have the
modal files import them from `@cloud-drive-sync/core` (modal classes themselves stay put).

### 3b. Engine shape

```ts
export interface SyncEngineSettings {
    conflictStrategy: ConflictStrategy;
    excludePatterns: string[];
    debugMode?: boolean;
}
export class SyncEngine {
    constructor(
        private fs: LocalFileSystem,
        private root: string,              // local root (vault root for Obsidian → "")
        private provider: CloudProvider,
        private state: SyncStateStore,
        private ui: SyncUIPort,
        private settings: SyncEngineSettings,
    ) {}
    onProgress?: (message: string) => void;
    async sync(): Promise<SyncResult>
    async syncPaths(paths: Set<string>): Promise<SyncResult>
}
```
Port `sync()`, `syncPaths()`, `computeActions()`, `computeFolderActions()`,
`executeAction()`, `executeFolderAction()`, `applyResolutions()`, `mergeFiles()` from the old
engine, replacing: `app.vault.*` → `this.fs.*` / `this.root`; `TFile.stat.mtime/size` →
`LocalFileEntry.mtimeMs/size`; modal instantiation → `this.ui.*`; `Notice` → drop (shells own
user notification; engine returns results/throws); `Platform.isDesktop` gating of external
merge → `this.ui.externalMerge !== undefined`. Deduplicate the two near-identical decision
blocks (`computeActions` and the inline one in `syncPaths`) into ONE private
`classifyPath(path, local, remote, record): SyncAction | null` — the delete-conflict fix then
lands in exactly one place.

### 3c. Change detection (replaces the old mtime-only local check)

Add `size?: number` to `SyncFileRecord` (`packages/core/src/types.ts`) — populate on every
upload/download/adopt. Old persisted records lack it; all comparisons must tolerate
`undefined` (treat as "size unknown → fall back to mtime-only," never as "changed").

```ts
const isMultipartEtag = (etag: string) => /-\d+$/.test(etag);

const mtimeChanged = local.mtimeMs > record.localModTime;
const sizeChanged = record.size !== undefined && local.size !== record.size;
const localChanged = mtimeChanged || sizeChanged;

const remoteChanged = remote.modifiedTime > record.remoteModTime
    && (isMultipartEtag(remote.md5Checksum) || remote.md5Checksum !== record.contentHash);
```

The old engine's step-4 "conflict verification read" (read local file + `computeMD5`, compare
to `remote.md5Checksum`, silently auto-resolve if identical) is kept, with two gates:
- only when `local.size < HASH_VERIFY_THRESHOLD_BYTES` (above: skip the read, go straight to
  conflict resolution), and
- only when `!isMultipartEtag(remote.md5Checksum)` (a multipart ETag is not a whole-file MD5 —
  comparison would be meaningless).

`contentHash` is still always computed during actual uploads/downloads regardless of size
(the bytes are in memory anyway).

### 3d. The delete-vs-changed-elsewhere bug fix (the load-bearing correctness change)

Old behavior (both copies): `!local && remote && record` → unconditional `delete-remote`.
This destroys another device's newer edit with no prompt.

New behavior in `classifyPath`:
```ts
} else if (!local && remote && record) {
    if (remoteChangedSinceRecord) {   // same remoteChanged expression as above
        // Ambiguous: deleted here vs edited elsewhere. Never destroy silently.
        //   use-local            → delete-remote (honor the deletion)
        //   use-remote           → download (resurrect)
        //   latest-wins / smart-merge / prompt → download (no local-deletion
        //     timestamp exists to compare; bias to not-deleting), AND for
        //     prompt/smart-merge surface a SyncIssue{type:"delete-conflict"}
        //     so the user sees it and can override via the results UI.
    } else {
        // safe: remote unchanged since this device last saw it
        actions.push({ type: "delete-remote", ... });
    }
}
```
In the results UI path, a `delete-conflict` resolution of `"local"` means delete-remote,
`"remote"` means re-download. `SyncResultsModal` needs a small addition to render
`delete-conflict` rows with those two buttons + Skip (no Merge) and a caption like
"deleted here, but changed on Drive since last sync".

### 3e. Binary guard for merge

New `packages/core/src/util/binary-guard.ts`:
```ts
export function isProbablyText(content: ArrayBuffer, mimeType: string): boolean {
    if (mimeType.startsWith("text/")) return true;
    if (["application/json", "application/xml", "application/javascript", "application/typescript"].includes(mimeType)) return true;
    const bytes = new Uint8Array(content, 0, Math.min(content.byteLength, 8192));
    return !bytes.includes(0);   // NUL-byte sniff, same heuristic as git/grep -I
}
```
Guard EVERY `merge2way` invocation (smart-merge auto-attempt in the engine, `mergeFiles()`):
if either side fails `isProbablyText`, skip the merge and queue a plain conflict instead.

### 3f. Folder tracking

Keep the old engine's `FOLDER_SENTINEL`/`computeFolderActions` mechanism, ported onto
`fs.listFolders/createFolder/deleteFolder`. Semantics unchanged (including the
`folderContainsTrackedFiles` guard and the rename-treated-as-new comment block — preserve that
comment, it documents a real historical bug).

### 3g. Tests (`packages/core/tests/sync-engine.test.ts`)

Fake `CloudProvider` + fake `LocalFileSystem` + recording `SyncUIPort` (reuse the fakes from
`mirror-sync-engine.test.ts` as a starting point before deleting that file). Cover at minimum:
- full 3×3 classify matrix (local × record × remote presence), incl. all first-sync strategies
- edit propagates (mtime bump → update-remote), remote edit propagates (etag+mtime → update-local)
- both-changed + identical hash → silent auto-resolve (below threshold)
- both-changed above `HASH_VERIFY_THRESHOLD_BYTES` → no verification read (assert via a
  readFile-call counter on the fake fs), goes to conflict path
- multipart ETag (`"abc-3"`) → treated as changed, never hash-compared
- **delete-conflict**: tracked+local-missing+remote-changed → download under latest-wins;
  delete-remote under use-local; issue surfaced under prompt
- tracked+local-missing+remote-unchanged → delete-remote (old safe behavior intact)
- binary content (contains NUL) + smart-merge → no merge2way, plain conflict
- folder create/delete both directions incl. `folderContainsTrackedFiles` guard
- `record.size === undefined` (legacy record) → mtime-only, no false "changed"

---

## Task #4 — Rewire the Obsidian plugin

- New `packages/obsidian-plugin/src/fs/obsidian-local-fs.ts`: implements `LocalFileSystem`
  over `app.vault` (`getFiles`, `readBinary`, `modifyBinary`/`createBinary`, `createFolder`,
  `getAbstractFileByPath`, recursive `TFolder` walk for `listFolders`). `deleteFile`/
  `deleteFolder` MUST use `vault.trash(file, true)` (preserves today's soft-delete safety).
  `root` is `""` — vault paths are already relative.
- New `packages/obsidian-plugin/src/sync/obsidian-sync-ui.ts`: implements `SyncUIPort` —
  `chooseFirstSyncStrategy` → `new FirstSyncModal(app).openAndWait()`; `resolveSyncIssues` →
  `new SyncResultsModal(app, issues).openAndWait()`; `reviewPlan` → `SyncPlanModal` (only
  wired when `settings.debugMode`); `externalMerge` → port of the old `launchExternalMerge`
  (keep `require("child_process")`, gate on `Platform.isDesktop &&
  settings.mergeToolCommand`; it needs vault adapter absolute paths — keep that logic here,
  NOT in core).
- Delete `packages/obsidian-plugin/src/sync/sync-engine.ts`. Update `main.ts`: construct the
  core `SyncEngine` with the two new adapters; keep `getSyncEngine()`'s provider/state wiring
  as-is. `SyncResultsModal`: import moved types from core, add delete-conflict row rendering
  (3d). `sync-plan-modal.ts`: import types from core.
- Notice-based toasts (`"Sync already in progress"`, merge notices) move from engine to the
  shells' call sites (`main.ts` / `obsidian-sync-ui.ts`) — user-visible strings must stay
  identical.
- Regression bar: `npm run build --workspace=packages/obsidian-plugin` green; no changes to
  `manifest.json`/BRAT flow; the settings shape (`data.json`) must remain
  backward-compatible (only additive: existing fields untouched).

## Task #5 — Rewire the Tauri app

- `packages/tauri-app/src/fs/tauri-local-fs.ts`: add `listFolders` (collect dir rel-paths in
  the existing `walk`), `createFolder` (`mkdir` recursive — already imported), `deleteFolder`
  (`remove` recursive), `statFile` (`stat` wrapped, null on missing).
- New `packages/tauri-app/src/sync/tauri-sync-ui.ts`:
  `chooseFirstSyncStrategy` → `"merge"`; `resolveSyncIssues` → auto-resolve per
  `settings.conflictStrategy`: `use-local`→local, `use-remote`→remote, everything else
  (incl. prompt/smart-merge, which have no UI here) → compare
  `localModTime`/`remoteModTime`, newer side wins; issues of type `error` → skip (next sync
  retries). For `delete-conflict` under the timestamp fallback: choose `"remote"`
  (re-download) — never auto-delete.
- `packages/tauri-app/src/store/settings-store.ts`: add `conflictStrategy: ConflictStrategy`
  (default `"latest-wins"`) to `TauriAppSettings` + `DEFAULT_SETTINGS`.
- `packages/tauri-app/src/main.ts`: replace `MirrorSyncEngine` with core `SyncEngine`
  (`new SyncEngine(new TauriLocalFileSystem(), settings.localFolder, provider, stateStore,
  new TauriSyncUI(settings.conflictStrategy), { conflictStrategy, excludePatterns: [] })`).
  Keep the existing watcher → `syncPaths`? The watcher currently triggers full `runSync()` —
  fine to keep full-sync triggering for now (simpler; path-scoped optimization later).
- Settings form field for conflict strategy: optional, additive — a `<select>` in
  `index.html` mirroring the Obsidian options minus prompt/smart-merge.

## Task #6 — Verify, push, document

1. `k8s-run` full verification (commands at top). All existing + new tests green;
   obsidian build green; tauri tsc green.
2. Commit(s) on `monorepo-tauri-app`, push. Logical commit split: (a) s3 path-prefix +
   multipart, (b) unified engine + shells, or one commit if interdependent — do not split
   into a broken intermediate state.
3. Update `notes/home/dev/cloud-drive-sync/architecture.md` (engine unification — replace the
   MirrorSyncEngine description with the unified design incl. the delete-conflict semantics)
   and `notes/home/dev/de-google/services/drive.md` status checklist (mark SigV4 fix +
   multipart + unified engine done).
4. Append the swap-over checklist to `notes/home/dev/cloud-drive-sync/manual-todo.md`
   (user-facing manual steps — see "User swap-over steps" below, copy it there).

### User swap-over steps (for the checklist)

1. Cloudflare dashboard: add public hostname `s3.example.com` → service
   `https://nginx-ingress-ingress-nginx-controller.nginx:443` (same origin the `*-notes`
   hostnames use — single rule; nginx does the path routing). No Cloudflare Access on it.
2. Verify endpoints: `curl -I https://s3.example.com/alice` (expect S3-style 403, not
   404/502); same for `/alice/webdav` (expect 401 WebDAV auth challenge).
3. On one test device: Obsidian plugin → endpoint `https://s3.example.com/alice`,
   bucket `Notes`, same keys. Verify a sync round-trips. Old endpoint keeps working in
   parallel — sync state stays valid because bucket+keys+file tree are identical.
4. Migrate remaining devices (Mac, phone, iPad; then Bob's devices with `/bob`).
5. Multipart validation (needs a Mac + a >100MB file): upload via the Tauri app pointed at
   `https://s3.example.com/alice`, watch `kubectl top pod -n rclone-drive` during it,
   confirm memory returns to baseline afterwards (checking the release-after-completion
   question). Verify md5 of the file downloaded back.
6. After all devices migrated: delete `apps/rclone-notes` + `apps/rclone-notes.yaml` from the
   `home` repo (ArgoCD prunes it), remove the three `*-notes.example.com` Cloudflare
   hostnames. Optionally rotate to dedicated `rclone-drive-*` 1Password items afterwards.
