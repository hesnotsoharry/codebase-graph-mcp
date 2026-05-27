/**
 * modernTs.ts — Wave 67 regression fixture for the indexer's tree-sitter parsing.
 *
 * Each TypeScript syntactic construct here has historically caused parse-output
 * drift in some grammar version. The companion test asserts that all top-level
 * definitions are extracted with the correct labels, catching future grammar
 * upgrades or pipeline refactors that silently regress one of these features.
 *
 * Do NOT import this file from runtime code. It exists purely as test input.
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-namespace, no-console */

// ─── Types and interfaces used by the fixture ───────────────────────────────

type SomeType = { x: number; y: string };

interface Disposable {
  [Symbol.dispose](): void;
}

// ─── Inline type modifier import ────────────────────────────────────────────
// Note: This file demonstrates TS syntax, so we use block `import type` below

import type { SomeModule } from './dummy';

// ─── satisfies operator (TS 4.9) ────────────────────────────────────────────

const config = {
  host: 'localhost',
  port: 3000,
  debug: true,
} satisfies SomeType;

// ─── using declaration (TS 5.2) ─────────────────────────────────────────────

using resource = (() => ({
  [Symbol.dispose]: () => {
    // cleanup
  },
}))() as Disposable;

// ─── Decorators (TS 5.0 stage-3) ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decorator(target: any): void {
  // decorator implementation
}

@decorator
class DecoratedClass {
  @decorator
  method(): string {
    return 'decorated';
  }
}

// ─── Abstract class ─────────────────────────────────────────────────────────

export abstract class AbstractWidget {
  protected abstract render(): string;

  public display(): void {
    console.log(this.render());
  }
}

// ─── Exported class with full class-body ────────────────────────────────────

export class FullClass {
  private readonly secretKey: string;
  private internalState: number = 0;

  constructor(key: string) {
    this.secretKey = key;
  }

  public getValue(): number {
    return this.internalState;
  }

  public setValue(val: number): void {
    this.internalState = val;
  }
}

// ─── Namespace declaration ──────────────────────────────────────────────────

export namespace MyNs {
  export const version = '1.0.0';

  export function greet(name: string): void {
    console.log(`Hello, ${name}`);
  }
}

// ─── Ambient declaration ────────────────────────────────────────────────────

declare const __INJECTED__: string;

// ─── Generic function with const type parameter (TS 5.0) ───────────────────

export function pick<const T>(x: T): T {
  return x;
}

// ─── Auto-accessor keyword (TS 5.0 stage-3 decorators) ─────────────────────
// If the grammar doesn't recognize `accessor` as a class-member modifier,
// AutoAccessorClass will either be missing from the Class extraction or
// produce wrong member nodes (e.g. a property literally named "accessor"
// instead of an auto-accessor for `name`). See
// roadmap/deferred/tree-sitter-grammar-upgrade.md for the upgrade path
// if this assertion fails.

export class AutoAccessorClass {
  accessor name = 'default';
  accessor count: number = 0;
}
