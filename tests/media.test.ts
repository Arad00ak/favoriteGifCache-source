import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFavoriteGifCache, MemoryStorageBackend } from "../plugin/gifCache.ts";
import { ensureCached, getCachedBytes } from "../plugin/media.ts";

describe("ensureCached", () => {
    it("miss downloads once, stores, hit skips network", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        await cache.init();

        const url = "https://media.tenor.com/unit-test-gif.gif";
        const remote = new TextEncoder().encode("REMOTE-GIF-BYTES");
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls += 1;
            return new Response(remote, {
                status: 200,
                headers: { "Content-Type": "image/gif" },
            });
        };

        assert.equal(await getCachedBytes(cache, url), null);

        const miss = await ensureCached(cache, url, fakeFetch);
        assert.ok(miss);
        assert.equal(miss!.fromCache, false);
        assert.equal(miss!.stored, true);
        assert.equal(fetchCalls, 1);

        const hit = await ensureCached(cache, url, fakeFetch);
        assert.equal(hit!.fromCache, true);
        assert.equal(fetchCalls, 1);
    });

    it("when full, download without kicking existing entries", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 1,
            backend: new MemoryStorageBackend(),
        });
        await cache.put("https://media.tenor.com/keep.gif", new TextEncoder().encode("KEEP"));

        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls += 1;
            return new Response(new TextEncoder().encode("NEW"), {
                status: 200,
                headers: { "Content-Type": "image/gif" },
            });
        };

        const res = await ensureCached(cache, "https://media.tenor.com/other.gif", {
            fetchImpl: fakeFetch,
            allowEvict: false,
        });
        assert.ok(res);
        assert.equal(res!.stored, false);
        assert.equal(fetchCalls, 1);
        assert.equal(cache.has("https://media.tenor.com/keep.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/other.gif"), false);
    });
});
