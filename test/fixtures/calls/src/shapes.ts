export class Counter {
  n = 0;
  bump(): number {
    this.n += 1;
    return this.n;
  }
}
