// node scripts/check-linediff.mjs (Node 23.6+ runs the .ts import directly)
import assert from "node:assert/strict"
import { lineChanges } from "../src/linediff.ts"

const f = (...l) => l.join("\n")
assert.deepEqual(lineChanges(f("a", "b", "c"), f("a", "b", "c")), [])
assert.deepEqual(lineChanges(f("a", "b", "c"), f("a", "x", "b", "c")), [[2, "a"]])
assert.deepEqual(lineChanges(f("a", "b", "c"), f("a", "B", "c")), [[2, "m"]])
assert.deepEqual(lineChanges(f("a", "b", "c"), f("a", "c")), [[2, "d"]])
assert.deepEqual(lineChanges(f("a", "b", "c"), f("a", "b")), [[2, "d"]])
assert.deepEqual(lineChanges("", f("x", "y")), [[1, "m"], [2, "a"]])
assert.deepEqual(lineChanges(f("a", "b", "c", "d"), f("a", "X", "Y", "d", "e")), [[2, "m"], [3, "m"], [5, "a"]])
console.log("linediff ok")
