import { vi } from 'vitest';

/**
 * Shared setup for the `browser` Vitest project (real Chromium, no Electron).
 *
 * `src/renderer/lib/ipc.ts` reads `window.electronAPI` at module-evaluation
 * time (`const electronAPI = window.electronAPI`), not lazily inside a
 * function. Any test file that statically imports something which pulls in
 * `ipc.ts` — directly or transitively — dereferences `window.electronAPI`
 * before a single `beforeEach` has run, so a per-test `vi.stubGlobal` is too
 * late to help. Vitest setup files run before the test file's own module
 * graph is imported, so stubbing here covers that static-import case as well
 * as the existing per-test dynamic-import + stubGlobal pattern.
 *
 * Individual tests may still call `vi.stubGlobal('electronAPI', ...)` in
 * their own `beforeEach` to provide more specific mock behavior (e.g.
 * asserting on `invoke` calls); this baseline just guarantees the shape is
 * never `undefined`.
 */
vi.stubGlobal('electronAPI', {
  invoke: vi.fn(() => Promise.resolve({ success: true, data: null })),
  eventSend: vi.fn(),
  eventOn: vi.fn(() => () => {}),
  getPathForFile: vi.fn(() => ''),
  requestWirePort: vi.fn(() => Promise.resolve()),
});
