/* eslint-disable */
// Acceptance-test fixture for Wave 22 Phase 4 tool-surface contract.
// Do NOT import from runtime code; this file exists to give the indexer
// real symbols to populate the graph with.

export class Greeter {
  constructor(private name: string) {}

  greet(): string {
    return `Hello, ${this.name}`;
  }

  shout(): string {
    return this.greet().toUpperCase();
  }
}

export function createGreeter(name: string): Greeter {
  return new Greeter(name);
}

export function welcomeAll(names: string[]): string[] {
  return names.map((n) => createGreeter(n).greet());
}
