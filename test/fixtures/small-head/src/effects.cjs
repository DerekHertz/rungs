const { readFileSync } = require("node:fs");
const cp = require("child_process");

module.exports = {
  load: () => readFileSync("config.json"),
  which: (name) => cp.spawnSync("which", [name]),
};
