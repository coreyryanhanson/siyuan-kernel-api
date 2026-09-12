// Fails when the publishable tarball does not exactly match the tracked
// production sources: every root module must ship, and nothing else may.
import { execSync } from "node:child_process";

const pack = execSync("npm pack --dry-run --json", { encoding: "utf8" });
const packed = JSON.parse(pack)[0].files.map((f) => f.path).sort();

const expected = execSync("git ls-files '*.ts'", { encoding: "utf8" })
	.split("\n")
	.filter((f) => f && !f.endsWith(".test.ts"))
	.sort();

const missing = expected.filter((f) => !packed.includes(f));
const extra = packed.filter((f) => f.endsWith(".ts") && !expected.includes(f));

for (const f of missing) console.error(`MISSING from tarball: ${f}`);
for (const f of extra) console.error(`UNEXPECTED in tarball: ${f}`);
if (missing.length || extra.length) process.exit(1);
console.log(`pack check ok (${expected.length} source files)`);
