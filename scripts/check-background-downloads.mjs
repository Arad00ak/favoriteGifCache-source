import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const mediaSource = fs.readFileSync(new URL("../plugin/media.ts", import.meta.url), "utf8");
const pluginSource = fs.readFileSync(new URL("../plugin/index.tsx", import.meta.url), "utf8");
const hostsSource = fs.readFileSync(new URL("../plugin/hosts.ts", import.meta.url), "utf8");
const nativeSource = fs.readFileSync(new URL("../plugin/native.ts", import.meta.url), "utf8");

function loadMedia(native) {
    const source = ts.transpileModule(mediaSource, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    const mocks = {
        "./favorites": { cacheKeyForUrl: url => url, isLikelyGifMediaUrl: () => true },
        "./hosts": { isDirectMediaUrl: () => true, mediaLookupKeys: url => [url] },
        "./nativeApi": { getPluginNative: () => native },
        "./sniffMime": { sniffMime: () => "image/gif" },
    };
    Function("require", "module", "exports", source)(id => mocks[id], mod, mod.exports);
    return mod.exports;
}

function fakeCache({ used = 0, max = 100, smart = false, onPut } = {}) {
    const entries = new Map();
    return {
        init: async () => {},
        has: key => entries.has(key),
        hasResidentData: key => entries.has(key),
        hydrate: async () => false,
        peekSync: key => entries.get(key) ?? null,
        touchSync: () => true,
        bytes: () => used,
        getMaxBytes: () => max,
        isSmartEvictionEnabled: () => smart,
        setSmartEviction: value => { smart = value; },
        put: async (key, data, _mime, options) => {
            if (onPut) return onPut({ data, setUsed: value => { used = value; } });
            if (data.byteLength > max || ((!smart || !options.allowEvict) && used + data.byteLength > max)) {
                return { stored: false, evictedKeys: [], skippedFull: data.byteLength <= max };
            }
            used = smart && options.allowEvict ? Math.min(max, used + data.byteLength) : used + data.byteLength;
            const entry = { key, data, mimeType: "image/gif" };
            entries.set(key, entry);
            return { stored: true, evictedKeys: [] };
        },
    };
}

function nativeDownloads(sizes) {
    const limits = [];
    return {
        limits,
        fetchMedia: async (_url, maxBytes) => {
            limits.push(maxBytes);
            const size = sizes.shift();
            if (size == null || size > maxBytes) return null;
            return { data: new Uint8Array(size).buffer, type: "image/gif" };
        },
    };
}

assert.doesNotMatch(hostsSource, /tenorToKlipyFallbackUrls|mediaDownloadCandidates/);
assert.match(pluginSource, /prefetchRunning \|\| prefetchDone/);
assert.doesNotMatch(pluginSource, /for \(const u of \[pickCacheableUrl/);

{
    const native = nativeDownloads([1]);
    const { ensureCached } = loadMedia(native);
    await ensureCached(fakeCache({ used: 100 }), "full.gif", { allowEvict: true });
    assert.deepEqual(native.limits, []);
}

{
    const native = nativeDownloads([10]);
    const { ensureCached } = loadMedia(native);
    const cache = fakeCache({ used: 95 });
    await ensureCached(cache, "near-full.gif", { allowEvict: true, maxBytes: 100 });
    await ensureCached(cache, "near-full.gif", { allowEvict: true, maxBytes: 100 });
    assert.deepEqual(native.limits, [5]);
}

{
    const native = nativeDownloads([null, 10]);
    const { ensureCached } = loadMedia(native);
    const cache = fakeCache({ smart: true });
    await ensureCached(cache, "dead.gif", { allowEvict: true });
    await ensureCached(cache, "dead.gif", { allowEvict: true });
    await ensureCached(cache, "dead.gif", { allowEvict: true, force: true });
    assert.equal(native.limits.length, 2);
}

{
    const native = nativeDownloads([10, 10]);
    const { ensureCached } = loadMedia(native);
    const cache = fakeCache({
        used: 50,
        onPut: ({ setUsed }) => {
            setUsed(90);
            return { stored: false, evictedKeys: [], skippedFull: true };
        },
    });
    await ensureCached(cache, "race-a.gif", { allowEvict: true });
    await ensureCached(cache, "race-b.gif", { allowEvict: true });
    cache.setSmartEviction(true);
    await ensureCached(cache, "race-b.gif", { allowEvict: true });
    assert.equal(native.limits.length, 2);
}

{
    let cancelled = false;
    const chunks = [new Uint8Array(4), new Uint8Array(4)];
    const fetchImpl = async () => ({
        ok: true,
        headers: { get: () => null },
        body: { getReader: () => ({
            read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
            cancel: async () => { cancelled = true; },
        }) },
    });
    const { ensureCached } = loadMedia(null);
    await ensureCached(fakeCache({ max: 5 }), "stream.gif", { fetchImpl, maxBytes: 5 });
    assert.equal(cancelled, true);
}

{
    let cancelled = false;
    const fetchImpl = async () => ({
        ok: true,
        headers: { get: name => name === "content-length" ? "6" : null },
        body: { cancel: async () => { cancelled = true; } },
    });
    const { ensureCached } = loadMedia(null);
    await ensureCached(fakeCache({ max: 5 }), "length.gif", { fetchImpl, maxBytes: 5 });
    assert.equal(cancelled, true);
}

for (const [fileName, source] of [["index.tsx", pluginSource], ["hosts.ts", hostsSource], ["native.ts", nativeSource]]) {
    const result = ts.transpileModule(source, { fileName, reportDiagnostics: true });
    assert.deepEqual(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error), []);
}

console.log("background download guards pass");
