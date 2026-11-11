import ts from "typescript";

const WITHHELD = "(signature withheld)";

type Hidden = { readonly start: number; readonly end: number };

/** Every default or initializer in `file`, outermost only: a parameter's, a destructured name's and a type parameter's. */
function defaults(file: ts.SourceFile): Hidden[] {
  const found: Hidden[] = [];
  const visit = (node: ts.Node): void => {
    const value = ts.isParameter(node) || ts.isBindingElement(node) ? node.initializer : ts.isTypeParameterDeclaration(node) ? node.default : undefined;
    if (value !== undefined) {
      found.push({ start: value.getStart(file), end: value.end });
      // Names inside a destructuring pattern may hold defaults of their own.
      if (!ts.isTypeParameterDeclaration(node)) ts.forEachChild(node, (child) => (child === value ? undefined : visit(child)));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function attempt(wrapped: string, offset: number, text: string): string | undefined {
  const file = ts.createSourceFile("signature.ts", wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (((file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length > 0) return undefined;
  let out = "";
  let at = 0;
  const hidden = defaults(file).sort((a, b) => a.start - b.start);
  for (const { start, end } of hidden) {
    if (start - offset < at) continue;
    out += `${text.slice(at, start - offset)}…`;
    at = end - offset;
  }
  return out + text.slice(at);
}

/**
 * A node's signature as an agent may see it: names and type annotations, with every default
 * value shown as `…`. A default is an expression, which is source text, and may hold a literal or
 * a condition. The signature is parsed as a function's or a class's and a default is removed by
 * its place in the syntax; one that parses as neither is withheld whole.
 */
export function promptSignature(signature: string): string {
  const flavour = /^(async\s+)?(\*\s*)?/.exec(signature)?.[0] ?? "";
  const body = signature.slice(flavour.length);
  const call = "type T = { ";
  const method = attempt(`${call}${body} }`, call.length, body);
  if (method !== undefined) return flavour + method;
  const head = "class C ";
  const whole = attempt(`${head}${signature}`, head.length, signature);
  return whole ?? WITHHELD;
}
