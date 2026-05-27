/**
 * concurrency.test.ts — Tests for mapConcurrent, Mutex, and concurrency helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConcurrency, mapConcurrent, Mutex } from './concurrency';

describe('defaultConcurrency', () => {
  it('is clamped into the [4, 16] range', () => {
    expect(defaultConcurrency).toBeGreaterThanOrEqual(4);
    expect(defaultConcurrency).toBeLessThanOrEqual(16);
  });
});

describe('mapConcurrent', () => {
  it('returns empty array for empty input without invoking fn', async () => {
    let called = 0;
    const result = await mapConcurrent<number, number>([], async (x) => {
      called++;
      return x;
    });
    expect(result).toEqual([]);
    expect(called).toBe(0);
  });

  it('preserves input order regardless of completion order', async () => {
    const result = await mapConcurrent([10, 20, 30, 40], async (value, index) => {
      // Earlier items finish later; reversed completion order.
      await new Promise((r) => setTimeout(r, (4 - index) * 5));
      return value * 2;
    });
    expect(result).toEqual([20, 40, 60, 80]);
  });

  it('caps the number of in-flight operations at the given limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);

    await mapConcurrent(
      items,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      4,
    );

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });

  it('clamps non-positive limits to at least 1', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapConcurrent(
      [1, 2, 3],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      },
      0,
    );
    expect(peak).toBe(1);
  });

  it('passes index as the second argument', async () => {
    const result = await mapConcurrent(['a', 'b', 'c'], async (item, index) => `${index}:${item}`);
    expect(result).toEqual(['0:a', '1:b', '2:c']);
  });
});

// ─── Mutex tests ──────────────────────────────────────────────────────────────

describe('Mutex', () => {
  let mutex: Mutex;

  beforeEach(() => {
    mutex = new Mutex();
  });

  afterEach(() => {
    // Ensure clean state
  });

  describe('tryAcquire', () => {
    it('returns true on first call (unlocked)', () => {
      const acquired = mutex.tryAcquire();
      expect(acquired).toBe(true);
    });

    it('returns false on second call without release (locked)', () => {
      mutex.tryAcquire();
      const acquired = mutex.tryAcquire();
      expect(acquired).toBe(false);
    });

    it('returns true after release', async () => {
      await mutex.acquire();
      mutex.release();
      const acquired = mutex.tryAcquire();
      expect(acquired).toBe(true);
    });

    it('does not wait when mutex is locked', async () => {
      mutex.tryAcquire();
      const start = Date.now();
      const acquired = mutex.tryAcquire();
      const elapsed = Date.now() - start;

      expect(acquired).toBe(false);
      expect(elapsed).toBeLessThan(10); // Should be instant, not blocked
    });
  });

  describe('acquire and release', () => {
    it('resolves immediately when unlocked', async () => {
      const start = Date.now();
      await mutex.acquire();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10); // Should be instant
    });

    it('waits for release when locked', async () => {
      await mutex.acquire();
      let secondAcquireResolved = false;

      const secondPromise = mutex.acquire().then(() => {
        secondAcquireResolved = true;
      });

      // Give the second acquire a chance to start waiting
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondAcquireResolved).toBe(false);

      mutex.release();
      await secondPromise;
      expect(secondAcquireResolved).toBe(true);
    });
  });

  describe('isLocked_', () => {
    it('returns false initially', () => {
      expect(mutex.isLocked_()).toBe(false);
    });

    it('returns true after acquire', async () => {
      await mutex.acquire();
      expect(mutex.isLocked_()).toBe(true);
    });

    it('returns false after release', async () => {
      await mutex.acquire();
      mutex.release();
      expect(mutex.isLocked_()).toBe(false);
    });
  });

  describe('runExclusive', () => {
    it('acquires, runs function, and releases', async () => {
      let executed = false;
      await mutex.runExclusive(async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(mutex.isLocked_()).toBe(false);
    });

    it('waits for previous exclusive block', async () => {
      const order: string[] = [];

      const p1 = mutex.runExclusive(async () => {
        order.push('fn1-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('fn1-end');
      });

      // Give p1 a chance to acquire
      await new Promise((resolve) => setTimeout(resolve, 5));

      const p2 = mutex.runExclusive(async () => {
        order.push('fn2-start');
        order.push('fn2-end');
      });

      await Promise.all([p1, p2]);

      // fn2 should not start until fn1 releases
      expect(order).toEqual(['fn1-start', 'fn1-end', 'fn2-start', 'fn2-end']);
    });

    it('returns the function result', async () => {
      const result = await mutex.runExclusive(async () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    it('handles synchronous functions', async () => {
      const result = await mutex.runExclusive(() => {
        return 'sync-result';
      });

      expect(result).toBe('sync-result');
    });

    it('releases on error', async () => {
      try {
        await mutex.runExclusive(async () => {
          throw new Error('test error');
        });
      } catch {
        // Expected
      }

      expect(mutex.isLocked_()).toBe(false);
    });
  });

  describe('GC ↔ indexing worker pattern (try-acquire)', () => {
    it('simulates GC deferring when indexing is in progress', () => {
      // Indexing starts and acquires the mutex
      const indexingStarted = mutex.tryAcquire();
      expect(indexingStarted).toBe(true);

      // GC tries to acquire; should fail and defer
      const gcCanRun = mutex.tryAcquire();
      expect(gcCanRun).toBe(false);

      // Indexing finishes and releases
      mutex.release();

      // Next GC cycle can acquire
      const gcCanRunNext = mutex.tryAcquire();
      expect(gcCanRunNext).toBe(true);
    });
  });
});
