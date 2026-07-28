import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    isCacheableFavoriteUrl,
    isHeavyVideoMime,
    isHeavyVideoUrl,
} from "../favorites.ts";
import { createFavoriteGifCache, MemoryStorageBackend } from "../gifCache.ts";
import { ensureCached, MAX_ENTRY_BYTES } from "../media.ts";

describe("media size / video rules", () => {
    it("detects mp4 urls but still treats tenor hosts as cache candidates", () => {
        assert.equal(isHeavyVideoUrl("https://media.tenor.com/foo.mp4"), true);
        assert.equal(isHeavyVideoUrl("https://media.tenor.com/foo.gif"), false);
        assert.equal(isCacheableFavoriteUrl("https://media.tenor.com/foo.mp4"), true);
        assert.equal(isCacheableFavoriteUrl("https://media.tenor.com/foo.gif"), true);
        assert.equal(isHeavyVideoMime("video/mp4"), true);
    });

    it("stores normal gif bytes", async () => {
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

    it("stores small video/gif mp4 under the per-file cap", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        const body = new Uint8Array(1024);
        const fakeFetch: typeof fetch = async () =>
            new Response(body, {
                status: 200,
                headers: { "Content-Type": "video/mp4" },
            });
        const res = await ensureCached(cache, "https://media.tenor.com/clip.mp4", fakeFetch);
        assert.ok(res?.stored, "small tenor mp4 should cache");
        assert.equal(cache.size(), 1);
    });

    it("rejects oversized files", async () => {
        const cache = createFavoriteGifCache({
            maxEntries: 10,
            backend: new MemoryStorageBackend(),
        });
        const huge = new Uint8Array(MAX_ENTRY_BYTES + 100);
        const fakeFetch: typeof fetch = async () =>
            new Response(huge, {
                status: 200,
                headers: {
                    "Content-Type": "video/mp4",
                    "Content-Length": String(huge.byteLength),
                },
            });
        const res = await ensureCached(cache, "https://media.tenor.com/huge.mp4", fakeFetch);
        assert.equal(res, null);
        assert.equal(cache.size(), 0);
    });
});
