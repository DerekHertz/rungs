// Geometry for the widget.
export interface Shape {
  area(): number;
}

export abstract class Polygon implements Shape {
  abstract area(): number;
  static from(points: number[]): Polygon {
    return new Square(points.length);
  }
}

export class Square extends Polygon {
  #side: number;
  static count = 0;
  static {
    Square.count = 0;
  }
  constructor(side: number) {
    super();
    this.#side = side;
  }
  get side(): number {
    return this.#side;
  }
  set side(value: number) {
    this.#side = value;
  }
  area(): number {
    const squared = () => this.#side * this.#side;
    return squared();
  }
  static area(): number {
    return 0;
  }
  #grow(by: number): void {
    function clamp(n: number): number {
      return Math.max(0, n);
    }
    this.#side += clamp(by);
  }
  "half.size#x"(): number {
    return this.#side / 2;
  }
  onResize = (): void => {};
}

export function scale(shape: Shape, by: number): number;
export function scale(shape: Shape, by: string): number;
export function scale(shape: Shape, by: number | string): number {
  return shape.area() * Number(by);
}

export const sides = [1, 2, 3].map((n) => n * 2).filter((n) => n > 2);
export const doubled = [4].map((n) => n * 2);

export const handlers = {
  open() {
    return 1;
  },
  close: () => 0,
  nested: { reset: function () {} },
};

export const Circle = class {
  radius(): number {
    return 1;
  }
};

describeShapes("squares", () => {
  describeShapes("area", () => {});
});

function describeShapes(_name: string, body: () => void): void {
  body();
}
