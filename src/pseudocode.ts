import ts from "typescript";
import { digestOf } from "./extract/extract.ts";
import { effectSites } from "./extract/javascript-effects.ts";
import { isAmbient, isCodeSyntax, programOver, scriptKind } from "./extract/javascript.ts";
import type { EffectSite } from "./extract/adapters.ts";
import type { CodeSyntax } from "./extract/javascript.ts";
import { isCodeNode, resourceId, targetText } from "./graph.ts";
import type { CodeNode, EffectEdge, FileTree, Graph, LineRange, NodeId } from "./graph.ts";
import { lineRangeOf, lineStarts } from "./lines.ts";
import type { LineKind, PseudoLine } from "./pseudo-line.ts";

export type { LineKind, PseudoLine } from "./pseudo-line.ts";

// A long return, throw, await or effect argument is cut and marked; a condition never is.
const CUT = 100;

/**
 * The outline of one function, computed from its file's text and the graph's effect edges, in
 * source order. Undefined for anything that is not a function of this tree.
 */
export function pseudocode(graph: Graph, tree: FileTree, id: NodeId): PseudoLine[] | undefined {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined || !isCodeNode(node) || node.level !== "function") return undefined;
  const text = tree.get(node.path);
  if (text === undefined) return undefined;
  // The effect catalog resolves names through the binder of the file alone (no module resolution),
  // so a program over this one file finds the same call sites, with exact positions, as the extractor.
  const program = programOver([{ path: node.path, text }]);
  const file = program.getSourceFile(`/${node.path}`) ?? ts.createSourceFile(node.path, text, ts.ScriptTarget.Latest, true, scriptKind(node.path));
  const sites = effectSites(file, program.getTypeChecker());
  const syntax = find(file, text, node);
  if (syntax === undefined) return undefined;
  const children = graph.nodes.filter((child): child is CodeNode => isCodeNode(child) && child.parent === id);
  const effects = graph.edges.filter((edge) => edge.from === id);
  return new Outline(file, text, children, effects, sites).of(syntax);
}

function find(file: ts.SourceFile, text: string, node: CodeNode): CodeSyntax | undefined {
  const starts = lineStarts(text);
  let found: CodeSyntax | undefined;
  const visit = (candidate: ts.Node): void => {
    if (found !== undefined || isAmbient(candidate)) return;
    if (isCodeSyntax(candidate)) {
      const start = candidate.getStart(file);
      const range = lineRangeOf(starts, start, candidate.end);
      if (range.start === node.range.start && range.end === node.range.end && digestOf(text.slice(start, candidate.end)) === node.digest) {
        found = candidate;
        return;
      }
    }
    candidate.forEachChild(visit);
  };
  visit(file);
  return found;
}

/** One line per row: its source lines, then the text indented two spaces per level. */
export function renderPseudocode(lines: readonly PseudoLine[]): string {
  return lines
    .map((line) => {
      const label = line.range.start === line.range.end ? `L${line.range.start}` : `L${line.range.start}-${line.range.end}`;
      return `${label.padEnd(9)}${"  ".repeat(line.depth)}${line.text}\n`;
    })
    .join("");
}

class Outline {
  private readonly lines: PseudoLine[] = [];
  private readonly starts: number[];
  private readonly unclaimed: EffectEdge[];
  private readonly nested: CodeNode[];
  private readonly file: ts.SourceFile;
  private readonly text: string;
  private run: { start: number; end: number } | undefined;

  private readonly sites = new Map<string, EffectSite>();

  constructor(file: ts.SourceFile, text: string, children: readonly CodeNode[], effects: readonly EffectEdge[], sites: readonly EffectSite[]) {
    for (const site of sites) this.sites.set(`${site.start}:${site.end}`, site);
    this.file = file;
    this.text = text;
    this.starts = lineStarts(text);
    this.unclaimed = [...effects];
    this.nested = [...children];
  }

  of(syntax: CodeSyntax): PseudoLine[] {
    if (ts.isClassLike(syntax)) return [];
    const fn = syntax as ts.FunctionLikeDeclaration;
    const body = fn.body;
    if (body === undefined) return [];
    this.add(this.inline(fn.parameters, 0));
    if (ts.isBlock(body)) this.statements(body.statements, 0);
    else {
      this.add([{ depth: 0, kind: "return", text: `=> ${this.cut(body)}`, range: this.range(body.getStart(this.file), body.end) }, ...this.inline(body, 1)]);
    }
    this.flush(0);
    return this.lines;
  }

  private add(lines: readonly PseudoLine[]): void {
    this.lines.push(...lines);
  }

  private range(start: number, end: number): LineRange {
    return lineRangeOf(this.starts, start, Math.max(end, start + 1));
  }

  // Layout is collapsed to single spaces; the text of string, template and regular expression
  // literals is not layout and stays as written.
  private collapse(start: number, end: number): string {
    const literals: [number, number][] = [];
    const visit = (node: ts.Node): void => {
      if (node.end <= start || node.getStart(this.file) >= end) return;
      if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateLiteralToken(node)) literals.push([node.getStart(this.file), node.end]);
      else node.forEachChild(visit);
    };
    visit(this.file);
    let out = "";
    let at = start;
    const layout = (to: number): void => {
      if (to > at) out += this.text.slice(at, to).replace(/\s+/g, " ");
    };
    for (const [from, to] of literals) {
      const clipped = Math.max(from, start);
      layout(clipped);
      out += this.text.slice(clipped, Math.min(to, end));
      at = Math.min(to, end);
    }
    layout(end);
    return out.trim();
  }

  private cut(node: ts.Node): string {
    const text = this.collapse(node.getStart(this.file), node.end);
    return text.length > CUT ? `${text.slice(0, CUT)} ...` : text;
  }

  /** The text from `node`'s first token up to where `until` begins. */
  private header(node: ts.Node, until: ts.Node): string {
    return this.collapse(node.getStart(this.file), until.getStart(this.file));
  }

  private line(depth: number, kind: LineKind, text: string, start: number, end: number): PseudoLine {
    return { depth, kind, text, range: this.range(start, end) };
  }

  private flush(depth: number): void {
    if (this.run === undefined) return;
    const range = this.range(this.run.start, this.run.end);
    const count = range.end - range.start + 1;
    this.lines.push({ depth, kind: "straight", text: `${count} ${count === 1 ? "line" : "lines"} of straight-line code`, range });
    this.run = undefined;
  }

  private statements(list: readonly ts.Statement[], depth: number): void {
    for (const statement of list) this.statement(statement, depth, "");
    this.flush(depth);
  }

  private body(statement: ts.Statement, depth: number): void {
    if (ts.isBlock(statement)) this.statements(statement.statements, depth);
    else this.statements([statement], depth);
  }

  private statement(node: ts.Statement, depth: number, label: string, from?: number): void {
    const start = from ?? node.getStart(this.file);
    const emit = (kind: LineKind, text: string, to: number, rest: readonly PseudoLine[] = []): void => {
      this.flush(depth);
      this.add([this.line(depth, kind, `${label}${text}`, start, to), ...rest]);
    };
    if (ts.isIfStatement(node)) return this.branch(node, depth, label);
    if (ts.isLabeledStatement(node)) return this.statement(node.statement, depth, `${label}${node.label.text}: `, start);
    if (ts.isBlock(node)) {
      this.flush(depth);
      return this.statements(node.statements, depth);
    }
    if (ts.isWithStatement(node)) {
      emit("with", `with (${this.collapse(node.expression.getStart(this.file), node.expression.end)})`, this.headerEnd(node, node.statement), this.inline(node.expression, depth + 1));
      return this.body(node.statement, depth + 1);
    }
    if (ts.isSwitchStatement(node)) {
      emit("switch", `switch (${this.collapse(node.expression.getStart(this.file), node.expression.end)})`, this.headerEnd(node, node.caseBlock), this.inline(node.expression, depth + 1));
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          const text = `case ${this.collapse(clause.expression.getStart(this.file), clause.expression.end)}:`;
          this.add([this.line(depth + 1, "case", text, clause.getStart(this.file), clause.expression.end), ...this.inline(clause.expression, depth + 2)]);
        } else this.add([this.line(depth + 1, "default", "default:", clause.getStart(this.file), clause.getStart(this.file) + "default".length)]);
        this.statements(clause.statements, depth + 2);
      }
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node)) {
      const text = this.header(node, node.statement);
      emit(ts.isWhileStatement(node) ? "while" : "for", text, this.headerEnd(node, node.statement), this.inline(headerParts(node), depth + 1));
      return this.body(node.statement, depth + 1);
    }
    if (ts.isDoStatement(node)) {
      emit("do", "do", start + 2);
      this.body(node.statement, depth + 1);
      const text = `while (${this.collapse(node.expression.getStart(this.file), node.expression.end)})`;
      const keyword = node.getChildren(this.file).find((child) => child.kind === ts.SyntaxKind.WhileKeyword)!;
      this.add([this.line(depth, "while", text, keyword.getStart(this.file), node.end), ...this.inline(node.expression, depth + 1)]);
      return;
    }
    if (ts.isTryStatement(node)) {
      emit("try", "try", start + 3);
      this.statements(node.tryBlock.statements, depth + 1);
      if (node.catchClause !== undefined) {
        const clause = node.catchClause;
        const text = clause.variableDeclaration === undefined ? "catch" : this.header(clause, clause.block);
        const to = clause.variableDeclaration === undefined ? clause.getStart(this.file) + 5 : this.headerEnd(clause, clause.block);
        this.add([this.line(depth, "catch", text, clause.getStart(this.file), to)]);
        this.statements(clause.block.statements, depth + 1);
      }
      if (node.finallyBlock !== undefined) {
        const keyword = node.getChildren(this.file).find((child) => child.kind === ts.SyntaxKind.FinallyKeyword)!;
        this.add([this.line(depth, "finally", "finally", keyword.getStart(this.file), keyword.end)]);
        this.statements(node.finallyBlock.statements, depth + 1);
      }
      return;
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      const kind = ts.isReturnStatement(node) ? "return" : "throw";
      const inner = node.expression === undefined ? [] : this.inline(node.expression, depth + 1);
      return emit(kind, this.cut(node), node.end, inner);
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      return emit(ts.isBreakStatement(node) ? "break" : "continue", this.cut(node), node.end);
    }
    const inner = this.inline(node, depth);
    if (inner.length > 0) {
      this.flush(depth);
      this.add(inner);
    } else if (this.run === undefined) this.run = { start, end: node.end };
    else this.run.end = node.end;
  }

  private branch(node: ts.IfStatement, depth: number, label: string): void {
    for (let current: ts.IfStatement = node, first = true; ; first = false) {
      const start = current.getStart(this.file);
      const text = this.header(current, current.thenStatement);
      const headerEnd = this.headerEnd(current, current.thenStatement);
      this.flush(depth);
      const prefix = first ? label : "";
      const keyword = first ? "if" : "else if";
      this.add([this.line(depth, keyword, `${prefix}${first ? text : `else ${text}`}`, first ? start : this.elseOf(current.parent as ts.IfStatement), headerEnd), ...this.inline(current.expression, depth + 1)]);
      this.body(current.thenStatement, depth + 1);
      const other = current.elseStatement;
      if (other === undefined) return;
      if (ts.isIfStatement(other)) {
        current = other;
        continue;
      }
      const elseStart = this.elseOf(current);
      this.add([this.line(depth, "else", "else", elseStart, elseStart + 4)]);
      return this.body(other, depth + 1);
    }
  }

  /** The end of a header: where the text before `body` stops, trailing layout excluded. */
  private headerEnd(node: ts.Node, body: ts.Node): number {
    const start = node.getStart(this.file);
    return start + this.text.slice(start, body.getStart(this.file)).trimEnd().length;
  }

  private elseOf(node: ts.IfStatement): number {
    return node.getChildren(this.file).find((child) => child.kind === ts.SyntaxKind.ElseKeyword)!.getStart(this.file);
  }

  /** The awaits, yields, nested functions and effect calls inside `root`, in source order. */
  private inline(root: ts.Node | readonly ts.Node[], depth: number): PseudoLine[] {
    const found: PseudoLine[] = [];
    const visit = (node: ts.Node, awaited: ts.AwaitExpression | undefined): void => {
      if (isCodeSyntax(node) && !isAmbient(node)) {
        const start = node.getStart(this.file);
        const at = this.range(start, node.end);
        const digest = digestOf(this.text.slice(start, node.end));
        const child = this.nested.find((candidate) => candidate.range.start === at.start && candidate.range.end === at.end && candidate.digest === digest);
        if (child !== undefined) {
          this.nested.splice(this.nested.indexOf(child), 1);
          found.push({ depth, kind: "function", text: `${child.level === "class" ? "class" : "function"} ${child.name}`, range: child.range, node: child.id });
        }
        return;
      }
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
        const isAwait = ts.isAwaitExpression(node);
        const operand = node.expression === undefined ? undefined : unwrap(node.expression);
        if (isAwait && operand !== undefined && this.effectOf(operand) !== undefined) {
          visit(operand, node as ts.AwaitExpression);
          return;
        }
        const keyword = isAwait ? "await" : node.asteriskToken === undefined ? "yield" : "yield*";
        const text = node.expression === undefined ? keyword : `${keyword} ${this.cut(node.expression)}`;
        found.push(this.line(depth, isAwait ? "await" : "yield", text, node.getStart(this.file), node.end));
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const edge = this.claim(node);
        if (edge !== undefined) {
          const text = `effect ${edge.to.slice("resource:".length)}: ${edge.operation}${edge.target === "none" ? "" : ` ${targetText(edge.target)}`}`;
          const range = awaited === undefined ? edge.range : this.range(awaited.getStart(this.file), awaited.end);
          found.push({ depth, kind: "effect", text: awaited === undefined ? text : `await ${text}`, range });
        }
      }
      node.forEachChild((child) => visit(child, undefined));
    };
    for (const node of Array.isArray(root) ? (root as readonly ts.Node[]) : [root as ts.Node]) visit(node, undefined);
    return found;
  }

  private effectOf(node: ts.Expression): EffectEdge | undefined {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return undefined;
    const start = node.getStart(this.file);
    const site = this.sites.get(`${start}:${node.end}`);
    if (site === undefined) return undefined;
    const range = this.range(start, node.end);
    return this.unclaimed.find(
      (edge) => edge.range.start === range.start && edge.range.end === range.end && edge.operation === site.operation && edge.to === resourceId(site.resource) && targetText(edge.target) === targetText(site.target),
    );
  }

  private claim(node: ts.CallExpression | ts.NewExpression): EffectEdge | undefined {
    const edge = this.effectOf(node);
    if (edge !== undefined) this.unclaimed.splice(this.unclaimed.indexOf(edge), 1);
    return edge;
  }
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function headerParts(node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement | ts.WhileStatement): ts.Node[] {
  if (ts.isForStatement(node)) return [node.initializer, node.condition, node.incrementor].filter((part): part is NonNullable<typeof part> => part !== undefined);
  return ts.isWhileStatement(node) ? [node.expression] : [node.initializer, node.expression];
}
