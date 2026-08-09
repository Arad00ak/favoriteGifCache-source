import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    favoriteStableKey,
    GIF_FORMAT_IMAGE,
    GIF_FORMAT_VIDEO,
    healFavoriteUrls,
    mimeMatchesFormat,
    remoteDisplaySrc,
    remoteSendUrl,
    restoreUrlsForSend,
    stashOriginalUrls,
} from "../plugin/displayUrls.ts";
import { createFavoriteGifCache, MemoryStorageBackend, SOFT_MEMORY_BYTES } from "../plugin/gifCache.ts";
import { sniffMime } from "../plugin/sniffMime.ts";

function bytes(n: number, tag = 1) {
    const u = new Uint8Array(n);
    u.fill(tag);
    return u;
}

function gifHeader() {
    const u = new Uint8Array(16);
    u.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
    return u;
}

function mp4Header() {
    const u = new Uint8Array(32);
    u[4] = 0x66; u[5] = 0x74; u[6] = 0x79; u[7] = 0x70;
    return u;
}

describe("displayUrls", () => {
    it("restore puts CDN back before send", () => {
        const gif: any = {
            src: "https://media.tenor.com/abc.gif",
            url: "https://media.tenor.com/abc.gif",
            format: GIF_FORMAT_IMAGE,
        };
        stashOriginalUrls(gif);
        gif.src = "blob:https://discord.com/x";
        gif.url = "blob:https://discord.com/x";
        restoreUrlsForSend(gif);
        assert.equal(gif.url, "https://media.tenor.com/abc.gif");
        assert.equal(gif.src, "https://media.tenor.com/abc.gif");
        assert.equal(gif.format, GIF_FORMAT_IMAGE);
    });

    it("healFavoriteUrls fixes store pollution", () => {
        const gif: any = {
            __fgcOriginalSrc: "https://media.tenor.com/y.gif",
            __fgcOriginalUrl: "https://media.tenor.com/y.gif",
            src: "blob:https://discord.com/dead",
            url: "blob:https://discord.com/dead",
        };
        healFavoriteUrls(gif);
        assert.equal(gif.src, "https://media.tenor.com/y.gif");
        assert.equal(gif.url, "https://media.tenor.com/y.gif");
    });

    it("mimeMatchesFormat gate", () => {
        assert.equal(mimeMatchesFormat(GIF_FORMAT_IMAGE, "image/gif"), true);
        assert.equal(mimeMatchesFormat(GIF_FORMAT_IMAGE, "video/mp4"), false);
        assert.equal(mimeMatchesFormat(GIF_FORMAT_VIDEO, "video/mp4"), true);
        assert.equal(mimeMatchesFormat(GIF_FORMAT_VIDEO, "image/webp"), false);
    });

    it("favoriteStableKey prefers send url", () => {
        const gif: any = {
            src: "https://media.tenor.com/a.webp",
            url: "https://media.tenor.com/a.mp4",
        };
        assert.equal(favoriteStableKey(gif), "https://media.tenor.com/a.mp4");
        assert.equal(remoteSendUrl(gif), "https://media.tenor.com/a.mp4");
        assert.equal(remoteDisplaySrc(gif), "https://media.tenor.com/a.webp");
    });
});

describe("sniffMime", () => {
    it("detects gif and mp4", () => {
        assert.equal(sniffMime(gifHeader()), "image/gif");
        assert.equal(sniffMime(mp4Header()), "video/mp4");
    });
});

describe("live blob tracking", () => {
    it("isLiveBlobUrl false after revoke via delete", async () => {
        const cache = createFavoriteGifCache({ backend: new MemoryStorageBackend() });
        await cache.init();
        const key = "https://media.tenor.com/z.gif";
        await cache.put(key, bytes(32, 1), "image/gif");
        const blob = cache.ensureBlobUrlSync(key, { bumpUsage: false })!;
        assert.equal(cache.isLiveBlobUrl(blob), true);
        await cache.delete(key);
        assert.equal(cache.isLiveBlobUrl(blob), false);
    });

    it("pinned key stays resident", async () => {
        const cache = createFavoriteGifCache({
            backend: new MemoryStorageBackend(),
            softMemoryBytes: 1000,
            maxBytes: SOFT_MEMORY_BYTES,
        });
        await cache.init();
        const pinned = "https://media.tenor.com/pin.gif";
        await cache.put(pinned, bytes(600, 1), "image/gif");
        cache.setDisplayPinnedKeys([pinned]);
        await cache.put("https://media.tenor.com/other.gif", bytes(600, 2), "image/gif");
        assert.equal(cache.hasResidentData(pinned), true);
    });
});
