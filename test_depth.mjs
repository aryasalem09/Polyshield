import { assertPathArgsInScope, remapArgs } from "./src/sandbox.js";

const scope = "/tmp/scope";
const args = { a: { b: { c: { d: { e: { f: { g: { h: { i: { filepath: "../escape.txt" } } } } } } } } } };

try {
  assertPathArgsInScope(args, scope);
  console.log("assertPathArgsInScope Failed open!");
} catch (e) {
  console.log("assertPathArgsInScope Threw:", e.message);
}

try {
  const remapped = remapArgs(args, scope, "/tmp/overlay");
  console.log("remapArgs Failed open:", JSON.stringify(remapped));
} catch(e) {
  console.log("remapArgs Threw:", e.message);
}
