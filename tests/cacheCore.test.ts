import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, GifCacheCore } from "../cacheCore.ts";

function bytes(label: string) {
    return new TextEncoder().encode(label);
}

describe("GifCacheCore", () => {
    it("defaults to 500 slots", () => {
        const c = new GifCacheCore();
        assert.equal(c.getMaxEntries(), DEFAULT_MAX_ENTRIES);
        assert.equal(DEFAULT_MAX_ENTRIES, 500);
    });

    it("defaults size budget to 500 MB when set via options", () => {
        assert.equal(DEFAULT_MAX_BYTES, 500 * 1024 * 1024);
        const c = new GifCacheCore({ maxBytes: DEFAULT_MAX_BYTES });
        assert.equal(c.getMaxBytes(), DEFAULT_MAX_BYTES);
    });

    it("put/get returns the same bytes and bumps useCount", () => {
        let t = 1000;
        const c = new GifCacheCore({ now: () => t });
        const payload = bytes("gif-alpha");
        assert.equal(c.put("https://media.tenor.com/a.gif", payload, "image/gif").stored, true);

        const hit = c.get("https://media.tenor.com/a.gif");
        assert.ok(hit);
        assert.deepEqual([...hit!.data], [...payload]);
        assert.equal(hit!.useCount, 1);

        t = 2000;
        assert.equal(c.get("https://media.tenor.com/a.gif")!.useCount, 2);
        assert.equal(c.get("https://media.tenor.com/a.gif")!.lastUsed, 2000);
    });

    it("miss is null", () => {
        assert.equal(new GifCacheCore().get("nope"), null);
    });

    it("does not evict when full unless allowEvict is set", () => {
        const c = new GifCacheCore({ maxEntries: 2, now: () => 1 });
        assert.equal(c.put("a", bytes("A")).stored, true);
        assert.equal(c.put("b", bytes("B")).stored, true);

        const blocked = c.put("c", bytes("C"));
        assert.equal(blocked.stored, false);
        assert.equal(blocked.skippedFull, true);
        assert.equal(c.size(), 2);
        assert.equal(c.has("a"), true);
        assert.equal(c.has("b"), true);
        assert.equal(c.has("c"), false);
    });

    it("allowEvict drops least-used and keeps hot entry", () => {
        let t = 0;
        const c = new GifCacheCore({ maxEntries: 2, now: () => ++t });
        c.put("old-low", bytes("A"));
        c.put("hot", bytes("B"));
        c.get("hot");
        c.get("hot");

        const result = c.put("new", bytes("C"), "image/gif", { allowEvict: true });
        assert.equal(result.stored, true);
        assert.ok(result.evictedKeys.includes("old-low"));
        assert.equal(c.has("old-low"), false);
        assert.equal(c.has("hot"), true);
        assert.equal(c.has("new"), true);
    });

    it("equal useCount tie-breaks on oldest lastUsed when allowing evict", () => {
        let t = 0;
        const c = new GifCacheCore({ maxEntries: 2, now: () => ++t });
        c.put("first", bytes("1"));
        c.put("second", bytes("2"));

        const result = c.put("third", bytes("3"), "image/gif", { allowEvict: true });
        assert.deepEqual(result.evictedKeys, ["first"]);
        assert.equal(c.has("first"), false);
    });

    it("protected keys are last to go when allowing evict", () => {
        let t = 0;
        const c = new GifCacheCore({ maxEntries: 2, now: () => ++t });
        c.put("protected", bytes("P"));
        c.put("expendable", bytes("E"));
        c.setProtectedKeys(["protected"]);

        const result = c.put("incoming", bytes("I"), "image/gif", { allowEvict: true });
        assert.ok(result.evictedKeys.includes("expendable"));
        assert.equal(c.has("protected"), true);
        assert.equal(c.has("incoming"), true);
    });

    it("overwrite same key does not grow size", () => {
        const c = new GifCacheCore({ maxEntries: 2 });
        c.put("x", bytes("one"));
        c.put("x", bytes("two-two"));
        assert.equal(c.size(), 1);
        assert.deepEqual([...c.get("x")!.data], [...bytes("two-two")]);
    });
});
