export function greet(name: string): string {
  return `hi ${name}`;
}

export function twice(name: string): string {
  return greet(greet(name));
}
