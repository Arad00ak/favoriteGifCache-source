import type { FavoriteGifCache } from "./gifCache";

/** Live cache handle for settings UI + plugin code. */
let active: FavoriteGifCache | null = null;
let rebuild: (() => Promise<FavoriteGifCache>) | null = null;

export function setActiveCache(cache: FavoriteGifCache | null) {
    active = cache;
}

export function getActiveCache() {
    return active;
}

export function setRebuildCache(fn: (() => Promise<FavoriteGifCache>) | null) {
    rebuild = fn;
}

export async function rebuildActiveCache() {
    if (!rebuild) throw new Error("Cache rebuild is not ready");
    return rebuild();
}
