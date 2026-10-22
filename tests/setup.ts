// The code uses window.setTimeout (popout windows); the test runner has no window.
(globalThis as unknown as { window: unknown }).window = globalThis;
