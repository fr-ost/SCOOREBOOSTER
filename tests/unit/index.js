// Node 22's test runner treats `node --test tests/unit/` as a glob that matches only this directory and
// then runs the directory as a script, which resolves to this file. Load every *.test.mjs from here so
// `npm test` (= node --test tests/unit/) works. With a glob (node --test "tests/unit/*.test.mjs") each
// file runs in its own process instead and this file is not used.
import { readdirSync } from "node:fs";

const files = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".test.mjs")).sort();
for (const f of files) await import(new URL(f, import.meta.url));
