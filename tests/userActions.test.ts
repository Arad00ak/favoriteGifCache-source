import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFavoriteGifCache, MemoryStorageBackend } from "../plugin/gifCache.ts";
import { cacheOnUserAction, ensureCached } from "../plugin/media.ts";

function bytes(s: string) {
    return new TextEncoder().encode(s);
}

function fakeFetch(body: string): typeof fetch {
    return async () =>
        new Response(bytes(body), {
            status: 200,
            headers: { "Content-Type": "image/gif" },
        });
}

describe("user actions vs scroll fill", () => {
    it("scroll fill does not evict when full", async () => {
        let t = 0;
        const cache = createFavoriteGifCache({
            maxBytes: 2,
            backend: new MemoryStorageBackend(),
            now: () => ++t,
        });
        await cache.put("https://media.tenor.com/a.gif", bytes("A"));
        await cache.put("https://media.tenor.com/b.gif", bytes("B"));
        await cache.get("https://media.tenor.com/a.gif");

        await ensureCached(cache, "https://media.tenor.com/c.gif", {
            fetchImpl: fakeFetch("C"),
            allowEvict: false,
        });

        assert.equal(cache.has("https://media.tenor.com/a.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/b.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/c.gif"), false);
        assert.equal(cache.size(), 2);
    });

    it("new favorite / send (cacheOnUserAction) evicts least-used when full", async () => {
        let t = 0;
        // IDLE(4)+HOT(3)=7 fills budget; NEW(3) needs to evict IDLE
        const cache = createFavoriteGifCache({
            maxBytes: 7,
            backend: new MemoryStorageBackend(),
            now: () => ++t,
            smartEviction: true,
        });
        await cache.put("https://media.tenor.com/idle.gif", bytes("IDLE"));
        await cache.put("https://media.tenor.com/hot.gif", bytes("HOT"));
        await cache.get("https://media.tenor.com/hot.gif");
        await cache.get("https://media.tenor.com/hot.gif");

        const res = await cacheOnUserAction(
            cache,
            "https://media.tenor.com/new-fav.gif",
            fakeFetch("NEW"),
        );
        assert.ok(res);
        assert.equal(res!.stored, true);
        assert.equal(cache.has("https://media.tenor.com/new-fav.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/hot.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/idle.gif"), false);
    });

    it("smartEviction off refuses store when full instead of deleting", async () => {
        let t = 0;
        const cache = createFavoriteGifCache({
            maxBytes: 2,
            backend: new MemoryStorageBackend(),
            now: () => ++t,
            smartEviction: false,
        });
        await cache.put("https://media.tenor.com/a.gif", bytes("A"));
        await cache.put("https://media.tenor.com/b.gif", bytes("B"));

        const res = await cacheOnUserAction(
            cache,
            "https://media.tenor.com/c.gif",
            fakeFetch("C"),
        );
        assert.ok(res);
        assert.equal(res!.stored, false);
        assert.equal(cache.has("https://media.tenor.com/a.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/b.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/c.gif"), false);
    });

    it("send path works after a scroll miss left the entry unstored", async () => {
        let t = 0;
        // KEEP(4) fills 5-byte budget for second 5-byte body without eviction
        const cache = createFavoriteGifCache({
            maxBytes: 5,
            backend: new MemoryStorageBackend(),
            now: () => ++t,
        });
        await cache.put("https://media.tenor.com/keep-until-send.gif", bytes("KEEP"));

        // scroll-style miss: download but no room
        const scroll = await ensureCached(cache, "https://media.tenor.com/later-send.gif", {
            fetchImpl: fakeFetch("LATER"),
            allowEvict: false,
        });
        assert.equal(scroll!.stored, false);
        assert.equal(cache.has("https://media.tenor.com/later-send.gif"), false);

        // user actually sends it → force store + evict
        const sent = await cacheOnUserAction(
            cache,
            "https://media.tenor.com/later-send.gif",
            fakeFetch("LATER"),
        );
        assert.equal(sent!.stored, true);
        assert.equal(cache.has("https://media.tenor.com/later-send.gif"), true);
        assert.equal(cache.has("https://media.tenor.com/keep-until-send.gif"), false);
    });
});
