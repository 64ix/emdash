import { afterEach, vi } from 'vitest';

// Vitest's `node` (and other non-browser) test environments share a single
// process-wide global object across every test file that a worker executes,
// rather than isolating `globalThis` per file. When a test file calls
// `vi.useFakeTimers()` in its last test (or in every test via a top-level
// `beforeEach`, as in `automation-scheduler.test.ts`) without a matching
// `vi.useRealTimers()` afterward, the fake timers stay installed and leak
// into whichever test file the worker happens to run next.
//
// That leak previously caused non-deterministic timeouts in unrelated files
// (observed in `issue-selector.test.ts`, which awaits real microtask/timer
// scheduling during `act()`), depending on how Vitest scheduled files across
// worker threads. Restoring real timers after every single test, globally,
// makes this class of leak impossible regardless of which individual test
// file forgets to clean up after itself.
afterEach(() => {
  vi.useRealTimers();
});
