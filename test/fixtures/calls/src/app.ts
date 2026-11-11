import leftPad from "left-pad";
import { greet } from "./index.ts";
import { Counter } from "./shapes.ts";
import shout from "./shout.ts";

const handlers: { [name: string]: () => void } = {};

export function main(name: string): string {
  const counter = new Counter();
  counter.bump();
  handlers[name]();
  leftPad(name, 4);
  JSON.stringify(name);
  return shout(greet(name));
}
