/**
 * concurrency.ts — Bounded-parallelism helper for indexer I/O and mutual exclusion.
 *
 * Wraps `p-limit` to cap the number of in-flight async operations, keeping
 * the libuv thread pool and OS file-descriptor budget within safe bounds
 * during full-project indexing. Results preserve input order regardless of
 * completion order.
 *
 * Also provides a simple Mutex for coordinating between main-thread operations
 * (e.g., GC and indexing worker coordination).
 */
/**
 * Default concurrency for file I/O in the indexer. Clamped to [4, 16]:
 *   - Lower bound keeps small machines responsive.
 *   - Upper bound stays well below Windows' default per-process FD budget,
 *     even when other subsystems (log writer, watchers, PTY) hold handles.
 */
export declare const defaultConcurrency: number;
/**
 * Run `fn` over `items` with at most `limit` operations in flight at once.
 * Preserves input order in the returned array.
 */
export declare function mapConcurrent<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, limit?: number): Promise<R[]>;
/**
 * Simple Mutex for main-thread synchronization.
 * Supports both blocking acquire/release and try-acquire patterns.
 * Used to coordinate operations like GC and indexing that must not run concurrently.
 */
export declare class Mutex {
    private isLocked;
    private waiters;
    /**
     * Acquire the mutex. If locked, waits until released.
     */
    acquire(): Promise<void>;
    /**
     * Release the mutex. Wakes the next waiter if any.
     */
    release(): void;
    /**
     * Try to acquire the mutex without waiting.
     * Returns true if acquired, false if already locked.
     */
    tryAcquire(): boolean;
    /**
     * Run a function with exclusive access to the mutex.
     * Waits for the mutex to be available before running.
     */
    runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;
    /**
     * Check if the mutex is currently locked.
     */
    isLocked_(): boolean;
}
//# sourceMappingURL=concurrency.d.ts.map