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
 *
 * `invoke`/`eventSend` throw by default (mirroring `ipc.ts`'s own
 * non-window fallback) rather than silently resolving with a fake success
 * payload. A test whose component reaches a real IPC call it didn't intend
 * to exercise should fail loudly and name the channel, not receive a
 * `{ success: true, data: null }` it then has to `.map()` over incorrectly.
 * Tests that do need a working `invoke`/`eventSend` should mock
 * `@renderer/lib/ipc` directly (see board-dnd.test.tsx) or override this
 * stub in their own `beforeEach`.
 */
vi.stubGlobal('electronAPI', {
  invoke: vi.fn((channel: string) => {
    throw new Error(`electronAPI.invoke is unavailable for ${channel} in browser tests`);
  }),
  eventSend: vi.fn((channel: string) => {
    throw new Error(`electronAPI.eventSend is unavailable for ${channel} in browser tests`);
  }),
  eventOn: vi.fn(() => () => {}),
  getPathForFile: vi.fn(() => ''),
  requestWirePort: vi.fn(() => Promise.resolve()),
});
