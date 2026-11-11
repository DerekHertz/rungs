// Opt-in speed check (`npm run perf`): wall-clock seconds depend on the machine, so this is
// kept out of `npm test`. test/extract.test.ts holds the operation-count check that runs there.
import { extract } from "../src/extract/extract.ts";
import { wideTree } from "../test/fixture-tree.ts";

const files = 300;
const limitSeconds = 4;
const tree = wideTree(files);
const started = performance.now();
const graph = extract(tree);
const seconds = (performance.now() - started) / 1000;
console.log(`extracted ${files} files, ${graph.edges.length} edges in ${seconds.toFixed(2)}s (limit ${limitSeconds}s)`);
if (graph.edges.length !== files * 30 || seconds >= limitSeconds) process.exit(1);
