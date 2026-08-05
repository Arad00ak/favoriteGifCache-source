import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    prefetchTargetBytes,
    sortFavoritesNewestFirst,
    type FavoriteGifRef,
} from "../plugin/favorites.ts";

describe("prefetch newest-first and 1/3 capacity", () => {
    it("prefetchTargetBytes is floor(maxBytes/3), at least 1", () => {
        assert.equal(prefetchTargetBytes(500 * 1024 * 1024), Math.floor((500 * 1024 * 1024) / 3));
        assert.equal(prefetchTargetBytes(3), 1);
        assert.equal(prefetchTargetBytes(1), 1);
        assert.equal(prefetchTargetBytes(100), 33);
        assert.equal(prefetchTargetBytes(0), 0);
    });

    it("sortFavoritesNewestFirst puts higher order first", () => {
        const refs: FavoriteGifRef[] = [
            { url: "https://media.tenor.com/old.gif", src: "https://media.tenor.com/old.gif", order: 1 },
            { url: "https://media.tenor.com/new.gif", src: "https://media.tenor.com/new.gif", order: 99 },
            { url: "https://media.tenor.com/mid.gif", src: "https://media.tenor.com/mid.gif", order: 50 },
        ];
        const sorted = sortFavoritesNewestFirst(refs);
        assert.equal(sorted[0]!.order, 99);
        assert.equal(sorted[1]!.order, 50);
        assert.equal(sorted[2]!.order, 1);
    });

    it("missing order goes after numbered orders", () => {
        const refs: FavoriteGifRef[] = [
            { url: "https://media.tenor.com/a.gif", src: "https://media.tenor.com/a.gif" },
            { url: "https://media.tenor.com/b.gif", src: "https://media.tenor.com/b.gif", order: 2 },
        ];
        const sorted = sortFavoritesNewestFirst(refs);
        assert.equal(sorted[0]!.order, 2);
    });
});
