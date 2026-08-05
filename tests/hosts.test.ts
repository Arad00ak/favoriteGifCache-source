import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    isKlipyUrl,
    isTenorUrl,
    mediaDownloadCandidates,
    mediaLookupKeys,
    tenorToKlipyFallbackUrls,
} from "../plugin/hosts.ts";
import { isLikelyGifMediaUrl, cacheKeyForUrl } from "../plugin/favorites.ts";

describe("Tenor → Klipy fallback hosts", () => {
    it("detects tenor and klipy urls", () => {
        assert.equal(isTenorUrl("https://media.tenor.com/abc/name.gif"), true);
        assert.equal(isKlipyUrl("https://media.klipy.com/abc/name.gif"), true);
        assert.equal(isTenorUrl("https://media.klipy.com/abc/name.gif"), false);
        assert.equal(isKlipyUrl("https://media.tenor.com/abc/name.gif"), false);
    });

    it("treats klipy as cacheable gif media", () => {
        assert.equal(isLikelyGifMediaUrl("https://media.klipy.com/foo.gif"), true);
        assert.equal(isLikelyGifMediaUrl("https://cdn.klipy.com/x.mp4"), true);
    });

    it("builds klipy host-swap fallbacks for tenor urls", () => {
        const fallbacks = tenorToKlipyFallbackUrls("https://media.tenor.com/XxYyZz/cool.gif?x=1");
        assert.ok(fallbacks.length > 0);
        assert.ok(fallbacks.every(u => u.includes("klipy.com")));
        assert.ok(fallbacks.some(u => u.startsWith("https://media.klipy.com/XxYyZz/cool.gif")));
        assert.ok(fallbacks.every(u => u.includes("x=1")));
    });

    it("download candidates list original then klipy", () => {
        const c = mediaDownloadCandidates("https://media.tenor.com/id/file.gif");
        assert.equal(c[0], "https://media.tenor.com/id/file.gif");
        assert.ok(c.some(u => u.includes("media.klipy.com")));
        assert.equal(mediaDownloadCandidates("https://media.giphy.com/x.gif").length, 1);
    });

    it("lookup keys cover both tenor and klipy forms", () => {
        const keys = mediaLookupKeys("https://media.tenor.com/id/file.gif");
        assert.ok(keys.includes("https://media.tenor.com/id/file.gif"));
        assert.ok(keys.some(k => k.includes("media.klipy.com")));
    });

    it("cacheKey strips query for klipy like tenor", () => {
        const k = cacheKeyForUrl("https://media.klipy.com/a/b.gif?token=1");
        assert.equal(k, "https://media.klipy.com/a/b.gif");
    });
});
