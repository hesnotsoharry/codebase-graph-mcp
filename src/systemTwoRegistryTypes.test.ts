/**
 * systemTwoRegistryTypes.test.ts — Smoke tests for registry type shapes.
 *
 * Since these are pure TypeScript interfaces (no runtime logic), tests verify
 * that objects conforming to the types can be constructed and accessed as
 * expected — catching any accidental structural breaks.
 */

import { describe, expect, it } from 'vitest';

import type { RegistryEntry, SystemTwoHandle } from './systemTwoRegistryTypes';

// ─── SystemTwoHandle ──────────────────────────────────────────────────────────

describe('SystemTwoHandle', () => {
  it('accepts a fully populated handle object', () => {
    const handle: SystemTwoHandle = {
      projectRoot: '/home/user/my-project',
      projectName: 'my-project',
      refCount: 1,
      watcher: null,
      createdAt: Date.now(),
      lastIndexStatus: 'idle',
    };
    expect(handle.projectRoot).toBe('/home/user/my-project');
    expect(handle.projectName).toBe('my-project');
    expect(handle.refCount).toBe(1);
    expect(handle.watcher).toBeNull();
    expect(handle.lastIndexStatus).toBe('idle');
  });

  it('allows refCount > 1 for multiply-acquired roots', () => {
    const handle: SystemTwoHandle = {
      projectRoot: '/work/repo',
      projectName: 'repo',
      refCount: 3,
      watcher: null,
      createdAt: 1000,
      lastIndexStatus: 'indexing',
    };
    expect(handle.refCount).toBe(3);
  });
});

// ─── RegistryEntry ────────────────────────────────────────────────────────────

describe('RegistryEntry', () => {
  it('accepts a fully populated mutable entry', () => {
    const entry: RegistryEntry = {
      projectRoot: '/home/user/my-project',
      projectName: 'my-project',
      refCount: 1,
      watcher: null,
      nativeWatcherSubscription: null,
      createdAt: Date.now(),
      lastIndexStatus: 'idle',
    };
    // Mutability: RegistryEntry is mutable (not readonly)
    entry.refCount = 2;
    entry.lastIndexStatus = 'complete';
    expect(entry.refCount).toBe(2);
    expect(entry.lastIndexStatus).toBe('complete');
  });

  it('can represent a zero-refcount entry (about to be removed)', () => {
    const entry: RegistryEntry = {
      projectRoot: '/tmp/test',
      projectName: 'test',
      refCount: 0,
      watcher: null,
      nativeWatcherSubscription: null,
      createdAt: 0,
      lastIndexStatus: 'disposed',
    };
    expect(entry.refCount).toBe(0);
  });
});
