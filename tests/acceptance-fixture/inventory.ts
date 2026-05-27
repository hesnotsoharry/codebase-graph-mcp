/* eslint-disable */
// Second fixture file — gives the indexer cross-file relationships to extract.

import { Greeter, createGreeter } from './greeter';

export interface Item {
  id: string;
  name: string;
  qty: number;
}

export class Inventory {
  private items: Item[] = [];
  private greeter: Greeter;

  constructor(owner: string) {
    this.greeter = createGreeter(owner);
  }

  add(item: Item): void {
    this.items.push(item);
  }

  count(): number {
    return this.items.length;
  }

  describeOwner(): string {
    return this.greeter.greet();
  }
}
