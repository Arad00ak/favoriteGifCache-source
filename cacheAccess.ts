import type { FavoriteGifCache } from "./gifCache";

/** Live cache handle for settings UI + plugin code. */
let active: FavoriteGifCache | null = null;

export function setActiveCache(cache: FavoriteGifCache | null) {
    active = cache;
}

export function getActiveCache() {
    return active;
}
