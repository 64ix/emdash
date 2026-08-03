# Renderer Patterns

All paths are relative to `apps/emdash-desktop/`.

## Modal System

All modals use a registry-based system. Only one modal can be active at a time.

- `src/renderer/app/modal-registry.ts` — central registry mapping modal IDs to components
  (`createModal`, `modalRegistry`)
- `src/renderer/lib/modal/modal-provider.tsx` — React context managing active modal state
  (`useModalContext`, `showModal`, `BaseModalProps`)
- `src/renderer/lib/modal/modal-renderer.tsx` — renders the currently active modal
- `src/renderer/lib/modal/modal-store.ts` — modal state store
- `src/renderer/lib/modal/use-close-guard.ts` — close-guard hook

**Adding a modal:**
1. Create the component accepting `BaseModalProps<TResult>` (provides `onSuccess` and `onClose` callbacks)
2. Register it in `src/renderer/app/modal-registry.ts`
3. Open it via the hook:

```tsx
const { showModal } = useModalContext();
showModal('myModal', { projectId: '123', onSuccess: (result) => {...} });
```

**Rules:**
- All modals must be registered in `src/renderer/app/modal-registry.ts`
- `showModal` is type-safe — TypeScript infers required args from the registry
- `hasActiveCloseGuard` prevents dismissal during critical operations

## View System

Views use a registry + parameterized navigation pattern.

- `src/renderer/app/view-registry.ts` — view definitions (required `MainPanel`, optional
  `WrapView` and `TitlebarSlot`) plus navigation guards (`setupNavigationGuards`)
- `src/renderer/lib/layout/` — `provider.tsx`, `navigation-provider.tsx` (navigation and
  param persistence), `layout-provider.tsx` (panel collapse/expand/drag state),
  `panel-drag-store.ts`

**Key behaviors:**
- `navigate(viewId, params?)` (from `useNavigate`) is type-safe; params are optional when all fields are optional
- Params persist per-view (navigating away and back preserves params)
- `updateViewParams(viewId, partial)` updates params without re-navigating

**Rules:**
- Views are singletons — one per ViewId
- Add new views to `src/renderer/app/view-registry.ts`

## PTY Frontend (`src/renderer/lib/pty/`)

- `pty.ts` — `FrontendPty` class; subscribing fetches the main-process ring buffer and
  registers the consumer in one synchronous tick, so there is no renderer-side buffer
  and no missed output
- `pty-session.ts` — session lifecycle
- `pty-pool-provider.tsx` — `TerminalPoolProvider` managing reusable xterm.js instances
- `pty-pane.tsx` — terminal pane component
- `prompt-injection.ts`, `pty-input-buffer.ts`, `pty-keybindings.ts`, `pty-clipboard.ts` — input handling

**Rules:**
- Historical output comes from the main-process ring buffer; do not add renderer-side buffering
- `sessionId` format: `makePtySessionId(projectId, scopeId, leafId)` from
  `src/shared/core/pty/ptySessionId.ts` — deterministic
- Panel drag pauses resizing to avoid jank (`src/renderer/lib/layout/panel-drag-store.ts`)

## React Query Context Pattern

Context providers use React Query for data fetching with optimistic updates:

```tsx
// Pattern used in AppSettingsProvider, ProjectProvider, etc.
const { data } = useQuery({ queryKey: ['resource'], queryFn: () => rpc.ns.get() });
const mutation = useMutation({
  mutationFn: (args) => rpc.ns.update(args),
  onMutate: async (args) => {
    // optimistic update via queryClient.setQueryData
  },
  onError: () => {
    // rollback via queryClient.setQueryData with previous snapshot
  },
});
```

**Rules:**
- Contexts combine React Query + local state, not standalone useState
- Use `useAppSettingsKey(key)` for fine-grained per-setting hooks
- Optimistic updates must include rollback on error

## State Outside React

For state that must survive React unmounts or be shared across unrelated components:

- **`useSyncExternalStore`-compatible stores** — e.g., `panelDragStore` in `src/renderer/lib/layout/`
- **Cross-feature stores** — `src/renderer/lib/stores/` (navigation, dependencies, resource monitor, ...)
- **MobX task and project stores** — `src/renderer/features/tasks/stores/` and
  `src/renderer/features/projects/stores/`; access them through selectors
  (`task-selectors.ts`, `project-selectors.ts`) and task view hooks, never directly

## MobX `computed` over non-MobX state (a recurring trap)

A MobX `computed` getter whose body reads only non-MobX-tracked state — a SolidJS
signal (e.g. `@emdash/chat-ui`'s `ChatState`), a plain class field, or a framework-free
controller's own state — has **zero MobX-tracked dependencies**. The first time it is
observed continuously (wrapped in `observer(...)`, or read inside an `autorun`/
`reaction`), MobX caches that first evaluation and never invalidates it, because nothing
in its dependency graph ever reports a change. The getter silently freezes at whatever
it returned on first render, even though the underlying data keeps changing.

This shipped three separate times in `AcpChatStore`
(`apps/emdash-desktop/src/renderer/features/conversations/acp/acp-chat-store.ts`)
during spec #18 before being caught: the transcript outline, the permission queue, and
`searchHistoryExhausted`. All three had the same shape — a `computed` reading
`chatState.transcript.state`, `session.sessionState.current()`, or another non-MobX
store directly. Three independent occurrences in one spec is a pattern, not bad luck.

**The fix already established in this file:** make the value an explicit
`observable`/`observable.ref` field, not a `computed` getter, and recompute it via a
private `_syncX()` method called at **every** site the underlying non-MobX state can
change (see `AcpChatStore`'s `outline`, `permissionQueue`, and `attentionQueue` fields
and their paired `_syncOutline`/`_syncPermissionQueue`/`_syncAttentionQueue` methods for
the reference pattern, including the doc-comment convention of listing every call
site). Where the getter must stay a `computed` for API-shape reasons (e.g. delegating to
a framework-free controller like `AcpChatSearchController`), gate it on a manually
bumped observable version counter read first in the getter body (see
`searchVersion`/`permissionResolutionVersion`), and bump that counter unconditionally at
every site the delegate's state can change — not only when the delegate itself reports
a change, since a caller can rely on the getter staying live even when the delegate's
own update is a no-op (see `searchHistoryExhausted`'s doc for why `_syncSearch` bumps
`searchVersion` unconditionally).

**Before adding or reviewing any MobX `computed` getter, check what it reads.** If its
body's only MobX-tracked read is a stable object reference (e.g. `this.session`) and
everything past that is a plain method call (`.current()`, `.state`, a framework-free
controller's own field), it needs the explicit-field-plus-resync pattern above, not
`computed`. This is exactly the kind of bug a per-file or per-PR review can miss, since
the code type-checks, lints, and even passes tests that read the getter without ever
keeping it "hot" under a continuous observer — write the regression test as an
`autorun` that keeps observing across a mutation, matching the pattern in
`acp-chat-store.test.ts`'s "keeps updating once observed, instead of caching its first
evaluation" tests.
