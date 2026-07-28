import {
    createFavoriteGifCache,
    MemoryStorageBackend,
    DEFAULT_MAX_ENTRIES,
} from "../plugin/gifCache.ts";

function fail(msg: string): never {
    console.error("SMOKE FAIL:", msg);
    process.exit(1);
}

function bytes(s: string) {
    return new TextEncoder().encode(s);
}

async function main() {
    console.log("FavoriteGifCache smoke");
    if (DEFAULT_MAX_ENTRIES !== 500) fail("default max should be 500");

    const backend = new MemoryStorageBackend();
    let t = 0;
    const cache = createFavoriteGifCache({
        maxEntries: 2,
        backend,
        now: () => ++t,
    });

    const payload = bytes("smoke-gif-bytes");
    if (!(await cache.put("https://media.tenor.com/smoke.gif", payload, "image/gif")).stored) {
        fail("put should store");
    }
    const hit = await cache.get("https://media.tenor.com/smoke.gif");
    if (!hit) fail("get should hit");
    for (let i = 0; i < payload.length; i++) {
        if (hit.data[i] !== payload[i]) fail("byte mismatch");
    }
    console.log("put→get ok, useCount=", hit.useCount);

    // full cache should refuse a third entry without allowEvict
    await cache.put("keep-hot", bytes("hot"));
    await cache.get("keep-hot");
    const blocked = await cache.put("incoming", bytes("new"));
    if (blocked.stored) fail("should not store when full without allowEvict");
    if (!cache.has("https://media.tenor.com/smoke.gif") || !cache.has("keep-hot")) {
        fail("existing entries must stay when full put is refused");
    }
    console.log("no thrash when full ok");

    // restart simulation
    const again = createFavoriteGifCache({ maxEntries: 2, backend });
    await again.init();
    if (!(await again.peek("keep-hot"))) fail("disk data missing after re-init");
    console.log("persist across re-init ok");

    // allowEvict path still works when we intentionally reclaim
    const ev = await again.put("forced", bytes("F"), "image/gif", { allowEvict: true });
    if (!ev.stored) fail("allowEvict put should store");
    if (again.size() > 2) fail("over cap after allowEvict");
    console.log("SMOKE PASS");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
