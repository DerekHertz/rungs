export function steady(count: number): number {
  return count + 1;
}

export class Counter {
  next(): number {
    return steady(1);
  }
}
