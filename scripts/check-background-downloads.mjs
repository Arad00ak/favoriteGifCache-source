import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const media = fs.readFileSync(new URL("../plugin/media.ts", import.meta.url), "utf8");
const plugin = fs.readFileSync(new URL("../plugin/index.tsx", import.meta.url), "utf8");

assert.match(media, /fullCacheStates\.get\(cache\) === cacheState/);
assert.match(media, /Math\.min\(maxBytes, remainingBytes\)/);
assert.match(media, /failedAutoDownloads\.set\(cache,/);
assert.match(plugin, /prefetchRunning \|\| prefetchDone/);
assert.match(plugin, /prefetchDone = true;/);

for (const [fileName, source] of [["media.ts", media], ["index.tsx", plugin]]) {
    const result = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), []);
}

console.log("background download guards present");
