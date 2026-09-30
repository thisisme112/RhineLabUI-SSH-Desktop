const path = require("node:path");
const run = process.env.RHINE_CHECK_RUN_ID ||= new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-native";
exports.artifactPath = relative => {
  const [suite, ...parts] = relative.replaceAll("\\", "/").split("/");
  return path.join(".artifacts/checks", suite, run, ...parts);
};
