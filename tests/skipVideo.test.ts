import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    isCacheableFavoriteUrl,
    isHeavyVideoMime,
    isHeavyVideoUrl,
} from "../favorites.ts";
import { createFavoriteGifCache, MemoryStorageBackend } from "../gifCache.ts";
import { cacheOnUserAction, ensureCached } from "../media.ts";

describe("skip heavy video (mp4) from cache", () => {
    it("detects mp4/webm urls", () => {
        assert.equal(isHeavyVideoUrl("https://media.tenor.com/foo.mp4"), true);
        assert.equal(isHeavyVideoUrl("https://media.tenor.com/foo.webm"), true);
        assert.equal(isHeavyVideoUrl("https://media.tenor.com/foo.gif"), false);
        assert.equal(isCacheableFavoriteUrl("https://media.tenor.com/foo.mp4"), false);
        assert.equal(isCacheableFavoriteUrl("https://media.tenor.com/foo.gif"), true);
        assert.equal(isHeavyVideoMime("video/mp4"), true);
        assert.equal(isHeavyVideoMime("image/gif"), false);
    });

    it("IMAGE format (1) is still cacheable; only VIDEO (2) is skipped by format", async () => {
        // regression: we used to treat format !== 0 as video, which blocked format=1 images
        const { createFavoriteGifCache, MemoryStorageBackend } = await import("../gifCache.ts");
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        const fakeFetch: typeof fetch = async () =>
            new Response(new TextEncoder().encode("GIFDATA"), {
                status: 200,
                headers: { "Content-Type": "image/gif" },
            });
        const res = await ensureCached(cache, "https://media.tenor.com/still-image.gif", fakeFetch);
        assert.ok(res?.stored);
        assert.equal(cache.size(), 1);
    });

    it("ensureCached never fetches mp4 bodies into the store", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls += 1;
            return new Response(new Uint8Array([1, 2, 3, 4]), {
                status: 200,
                headers: { "Content-Type": "video/mp4" },
            });
        };

        const res = await ensureCached(cache, "https://media.tenor.com/huge.mp4", fakeFetch);
        assert.equal(res, null);
        assert.equal(fetchCalls, 0, "must bail before network for .mp4 urls");
        assert.equal(cache.size(), 0);
    });

    it("rejects video content-type even if url looks generic", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls += 1;
            return new Response(new Uint8Array(100), {
                status: 200,
                headers: { "Content-Type": "video/mp4" },
            });
        };

        // path has no extension; host is tenor so isLikelyGifMediaUrl is true
        // but response is video → do not store (and we abort before buffering if mime known)
        const res = await ensureCached(
            cache,
            "https://media.tenor.com/SomeHash/AAAAC/",
            fakeFetch,
        );
        // may fetch once to learn mime, but must not store
        assert.equal(res, null);
        assert.equal(cache.size(), 0);
        assert.ok(fetchCalls <= 1);
    });

    it("cacheOnUserAction also skips mp4", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        let fetchCalls = 0;
        const fakeFetch: typeof fetch = async () => {
            fetchCalls += 1;
            return new Response(new Uint8Array(50), {
                status: 200,
                headers: { "Content-Type": "video/mp4" },
            });
        };

        const res = await cacheOnUserAction(
            cache,
            "https://cdn.discordapp.com/attachments/1/2/clip.mp4",
            fakeFetch,
        );
        assert.equal(res, null);
        assert.equal(fetchCalls, 0);
        assert.equal(cache.size(), 0);
    });
});
