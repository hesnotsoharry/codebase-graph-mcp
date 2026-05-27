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

import os from 'os';
import pLimit from 'p-limit';

/**
 * Default concurrency for file I/O in the indexer. Clamped to [4, 16]:
 *   - Lower bound keeps small machines responsive.
 *   - Upper bound stays well below Windows' default per-process FD budget,
 *     even when other subsystems (log writer, watchers, PTY) hold handles.
 */
export const defaultConcurrency: number = Math.max(4, Math.min(16, os.cpus().length * 2));

/**
 * Run `fn` over `items` with at most `limit` operations in flight at once.
 * Preserves input order in the returned array.
 */
export function mapConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = defaultConcurrency,
): Promise<R[]> {
  if (items.length === 0) return Promise.resolve([]);
  const gate = pLimit(Math.max(1, limit));
  return Promise.all(items.map((item, index) => gate(() => fn(item, index))));
}

/**
 * Simple Mutex for main-thread synchronization.
 * Supports both blocking acquire/release and try-acquire patterns.
 * Used to coordinate operations like GC and indexing that must not run concurrently.
 */
export class Mutex {
  private isLocked = false;
  private waiters: Array<() => void> = [];

  /**
   * Acquire the mutex. If locked, waits until released.
   */
  async acquire(): Promise<void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Release the mutex. Wakes the next waiter if any.
   */
  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    } else {
      this.isLocked = false;
    }
  }

  /**
   * Try to acquire the mutex without waiting.
   * Returns true if acquired, false if already locked.
   */
  tryAcquire(): boolean {
    if (this.isLocked) {
      return false;
    }
    this.isLocked = true;
    return true;
  }

  /**
   * Run a function with exclusive access to the mutex.
   * Waits for the mutex to be available before running.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await Promise.resolve(fn());
    } finally {
      this.release();
    }
  }

  /**
   * Check if the mutex is currently locked.
   */
  isLocked_(): boolean {
    return this.isLocked;
  }
}
