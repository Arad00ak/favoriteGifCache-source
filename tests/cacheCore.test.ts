import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MAX_BYTES, GifCacheCore } from "../plugin/cacheCore.ts";

function bytes(label: string) {
    return new TextEncoder().encode(label);
}

describe("GifCacheCore", () => {
    it("defaults size budget to infinity unless set", () => {
        const c = new GifCacheCore();
        assert.equal(c.getMaxBytes(), Number.POSITIVE_INFINITY);
        assert.equal(DEFAULT_MAX_BYTES, 500 * 1024 * 1024);
    });

    it("defaults size budget to 500 MB when set via options", () => {
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
        // two 1-byte payloads fill a 2-byte budget
        const c = new GifCacheCore({ maxBytes: 2, now: () => 1 });
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
        const c = new GifCacheCore({ maxBytes: 2, now: () => ++t });
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
        const c = new GifCacheCore({ maxBytes: 2, now: () => ++t });
        c.put("first", bytes("1"));
        c.put("second", bytes("2"));

        const result = c.put("third", bytes("3"), "image/gif", { allowEvict: true });
        assert.deepEqual(result.evictedKeys, ["first"]);
        assert.equal(c.has("first"), false);
    });

    it("protected keys are last to go when allowing evict", () => {
        let t = 0;
        const c = new GifCacheCore({ maxBytes: 2, now: () => ++t });
        c.put("protected", bytes("P"));
        c.put("expendable", bytes("E"));
        c.setProtectedKeys(["protected"]);

        const result = c.put("incoming", bytes("I"), "image/gif", { allowEvict: true });
        assert.ok(result.evictedKeys.includes("expendable"));
        assert.equal(c.has("protected"), true);
        assert.equal(c.has("incoming"), true);
    });

    it("overwrite same key does not grow size", () => {
        const c = new GifCacheCore({ maxBytes: 20 });
        c.put("x", bytes("one"));
        c.put("x", bytes("two-two"));
        assert.equal(c.size(), 1);
        assert.deepEqual([...c.get("x")!.data], [...bytes("two-two")]);
    });

    it("no entry count cap — only byte budget matters", () => {
        const c = new GifCacheCore({ maxBytes: 100 });
        for (let i = 0; i < 50; i++) {
            assert.equal(c.put(`k${i}`, bytes("X")).stored, true);
        }
        assert.equal(c.size(), 50);
        assert.equal(c.bytes(), 50);
    });

    it("soft memory unloads cold payloads without dropping catalog", () => {
        const c = new GifCacheCore({ maxBytes: 1000, softMemoryBytes: 10, now: () => 1 });
        assert.equal(c.put("a", new Uint8Array(6).fill(1)).stored, true);
        assert.equal(c.put("b", new Uint8Array(6).fill(2)).stored, true);
        // both cataloged
        assert.equal(c.size(), 2);
        assert.equal(c.bytes(), 12);
        // one payload dropped to stay under soft RAM
        assert.ok(c.residentBytes() <= 10);
        assert.equal(c.has("a"), true);
        assert.equal(c.has("b"), true);
        assert.ok(c.needsHydrate("a") || c.needsHydrate("b"));
    });
});
