import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFavoriteGifCache, MemoryStorageBackend } from "../plugin/gifCache.ts";
import { ensureCached } from "../plugin/media.ts";

function bytes(s: string) {
    return new TextEncoder().encode(s);
}

describe("display path", () => {
    it("init rebuilds blob urls after a simulated restart", async () => {
        const backend = new MemoryStorageBackend();
        const first = createFavoriteGifCache({ maxEntries: 50, backend });
        await first.put("https://media.tenor.com/cold.gif", bytes("COLD-BYTES"), "image/gif");

        const second = createFavoriteGifCache({ maxEntries: 50, backend });
        assert.equal(second.getCachedBlobUrl("https://media.tenor.com/cold.gif"), undefined);

        await second.init();
        const hot = second.getCachedBlobUrl("https://media.tenor.com/cold.gif");
        assert.ok(hot?.startsWith("blob:"));
        assert.equal(second.resolveDisplayUrlSync("https://media.tenor.com/cold.gif"), hot);
    });

    it("display resolve bumps useCount so eviction prefers idle entries", async () => {
        let t = 0;
        const cache = createFavoriteGifCache({
            maxEntries: 2,
            backend: new MemoryStorageBackend(),
            now: () => ++t,
        });
        await cache.put("https://media.tenor.com/a.gif", bytes("A"));
        await cache.put("https://media.tenor.com/b.gif", bytes("B"));

        for (let i = 0; i < 5; i++) {
            assert.ok(cache.resolveDisplayUrlSync("https://media.tenor.com/a.gif")?.startsWith("blob:"));
        }

        const metaA = cache.getMetaSync("https://media.tenor.com/a.gif")!;
        const metaB = cache.getMetaSync("https://media.tenor.com/b.gif")!;
        assert.ok(metaA.useCount > metaB.useCount);

        const put = await cache.put("https://media.tenor.com/c.gif", bytes("C"), "image/gif", {
            allowEvict: true,
        });
        assert.ok(put.evictedKeys.includes("https://media.tenor.com/b.gif"));
        assert.equal(cache.has("https://media.tenor.com/a.gif"), true);
    });

    it("warmAllBlobUrls does not bump useCount", async () => {
        const cache = createFavoriteGifCache({ backend: new MemoryStorageBackend() });
        await cache.put("https://media.tenor.com/w.gif", bytes("W"));
        const before = cache.getMetaSync("https://media.tenor.com/w.gif")!.useCount;
        cache.warmAllBlobUrls();
        assert.equal(cache.getMetaSync("https://media.tenor.com/w.gif")!.useCount, before);
    });

    it("prefetch fill stops at capacity without deleting old entries", async () => {
        const backend = new MemoryStorageBackend();
        const cache = createFavoriteGifCache({ maxEntries: 1, backend });
        await cache.init();

        const fakeFetch: typeof fetch = async (input) => {
            const url = String(input);
            return new Response(bytes("x-" + url), {
                status: 200,
                headers: { "Content-Type": "image/gif" },
            });
        };

        await ensureCached(cache, "https://media.tenor.com/first.gif", {
            fetchImpl: fakeFetch,
            allowEvict: false,
        });
        await ensureCached(cache, "https://media.tenor.com/second.gif", {
            fetchImpl: fakeFetch,
            allowEvict: false,
        });

        assert.equal(cache.size(), 1);
        assert.equal(cache.has("https://media.tenor.com/first.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/second.gif"), false);
    });

    it("rewritten src is a blob url so the element does not hit the CDN", async () => {
        const cache = createFavoriteGifCache({ backend: new MemoryStorageBackend() });
        const remote = "https://media.tenor.com/paint.gif";
        await cache.put(remote, bytes("PAINT"), "image/gif");
        const local = cache.resolveDisplayUrlSync(remote);
        assert.ok(local?.startsWith("blob:"));
    });
});
