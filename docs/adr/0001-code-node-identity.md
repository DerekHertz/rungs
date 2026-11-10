# 1. Code node identity

Status: draft, proposed in the PR that adds class and function nodes. Not adopted until the
maintainer accepts it.

## Context

SPEC.md makes identity (level, path, qualified name). Packages, folders and files have an empty
qualified name. Classes and functions need one that stays the same across unrelated edits, because
the review overlay pairs nodes across two graphs by id, and call edges and pseudocode attach to
these nodes later. `nodeId` joins the parts as `level:path#qualifiedName`, so a qualified name
must never be empty and never contain `#`. Real source puts `#` in names: private members
(`#grow`) and string keys (`"a#b"() {}`).

## Decision

**A line ends at `\n` and nowhere else.** `\r` stays in the line's text, and U+2028 and U+2029 do
not end a line. File line counts, code node ranges and source slices all come from
`src/lines.ts`. The TypeScript compiler's line numbers are never used, because it also breaks lines
at `\r`, U+2028 and U+2029.

**Adapters describe; the extractor names.** A language adapter returns, per file, a tree of
declarations: level, the text the language calls the node in its scope, and UTF-16 offsets. It
never picks an id, a line number, an ordinal or an escape. The extractor turns offsets into line
ranges through `src/lines.ts` and texts into qualified names through `qualifiedName` in
`src/graph.ts`. A new adapter cannot produce colliding ids or a second definition of a line.

**The qualified name.** Each node contributes one segment, its text plus an ordinal among the
siblings with the same text, counted from 1 in source order across both levels:

```
segment       = (IdentifierName | jsonString) ("@" ordinal)?    ordinal written only when > 1
qualifiedName = segment ("." segment)*
```

`jsonString` is `JSON.stringify(text)` with each `#` written as `#`. An IdentifierName
contains none of `. @ " #`, and a JSON string delimits itself, so every name decodes to exactly
one path of (text, ordinal) pairs. Distinct nodes in a file therefore get distinct names, and no
name is empty or contains `#`.

The JavaScript and TypeScript adapter takes the text from the first rule that applies:

| Syntax | Text | Example qualified name |
|---|---|---|
| Named function or class, declaration or expression | its name | `legacy` for `module.exports = function legacy() {}` |
| Class method or accessor | key, with `static `, `get `, `set ` as written; `constructor` | `Square."get side"`, `Square."#grow"` |
| Initializer of a variable, parameter, binding element or class field | the bound name | `Widget`, `Square.onResize` |
| Object literal member | the literal's own access path, `.`, then the key | `"handlers.nested.reset"` |
| Right side of `a.b.c = ...` over identifiers and `this` | the target | `"Foo.prototype.bar"` |
| Anonymous `export default` | `default` | `default` |
| Argument of a call or `new` with a named callee | `callee() callback`, with a string first argument inside the parentheses | `"describe(\"parser\") callback"` |
| Anything else | `<function>` or `<class>` | `"<function>"` |

A declaration directly inside `namespace N { }` is prefixed `N.`.

## Consequences

A qualified name changes only when the node's own text changes, an ancestor's text changes, or a
sibling with the same text is inserted before it. Adding, removing or editing other functions, and
any edit that shifts lines, leave it alone. Renaming a test title or a callback's callee changes
that callback's identity. Quoted segments are hard to read raw; people read a node's `name`, not
its id.
