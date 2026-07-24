import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFavoriteGifCache, MemoryStorageBackend } from "../gifCache.ts";

function bytes(s: string) {
    return new TextEncoder().encode(s);
}

describe("FavoriteGifCache", () => {
    it("survives a new instance on the same backend (like restarting Discord)", async () => {
        const backend = new MemoryStorageBackend();
        const a = createFavoriteGifCache({ maxEntries: 500, backend });
        await a.put("https://example.com/f.gif", bytes("durable-gif"), "image/gif");

        const b = createFavoriteGifCache({ maxEntries: 500, backend });
        await b.init();
        const again = await b.peek("https://example.com/f.gif");
        assert.ok(again);
        assert.deepEqual([...again!.data], [...bytes("durable-gif")]);
    });

    it("default put will not evict when full", async () => {
        const backend = new MemoryStorageBackend();
        let t = 0;
        const cache = createFavoriteGifCache({
            maxEntries: 2,
            backend,
            now: () => ++t,
        });
        await cache.put("a", bytes("A"));
        await cache.put("b", bytes("B"));
        const blocked = await cache.put("c", bytes("C"));
        assert.equal(blocked.stored, false);
        assert.equal(cache.has("a"), true);
        assert.equal(cache.has("b"), true);
        assert.equal(await backend.get("a") != null, true);
        assert.equal(await backend.get("c"), null);
    });

    it("allowEvict removes least-used from memory and backend", async () => {
        const backend = new MemoryStorageBackend();
        let t = 0;
        const cache = createFavoriteGifCache({
            maxEntries: 2,
            backend,
            now: () => ++t,
        });
        await cache.put("low", bytes("L"));
        await cache.put("high", bytes("H"));
        await cache.get("high");
        await cache.get("high");

        const put = await cache.put("new", bytes("N"), "image/gif", { allowEvict: true });
        assert.equal(put.stored, true);
        assert.ok(put.evictedKeys.includes("low"));
        assert.equal(await backend.get("low"), null);
        assert.ok(await backend.get("high"));
    });

    it("miss get is null", async () => {
        const cache = createFavoriteGifCache({ backend: new MemoryStorageBackend() });
        assert.equal(await cache.get("nope"), null);
    });
});
