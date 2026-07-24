/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

import { setActiveCache, setRebuildCache } from "./cacheAccess";
import { CacheUsageBar } from "./CacheUsageBar";
import {
    cacheKeyForUrl,
    getFavoriteGifRefsFromFrecency,
    isCacheableFavoriteUrl,
    isHeavyVideoUrl,
    isLikelyGifMediaUrl,
    keysForFavorite,
    type FavoriteGifRef,
} from "./favorites";
import {
    createFavoriteGifCache,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_ENTRIES,
    type FavoriteGifCache,
} from "./gifCache";
import { cacheOnUserAction, ensureCached, installFetchInterceptor } from "./media";
import { getPluginNative } from "./nativeApi";
import { setUsageBarComponent, settings, settingsHooks } from "./settings";
import { createBackendForPath } from "./storage";

export { settings };

setUsageBarComponent(() => <CacheUsageBar />);

let cache: FavoriteGifCache | null = null;
let uninstallFetch: (() => void) | null = null;
let favoriteUrlSet = new Set<string>();
/** After first seed, keys that appear here are "just favorited". */
let favoritesSeeded = false;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let lastPickerInstance: { forceUpdate?: () => void; dead?: boolean } | null = null;

function maxBytesFromSettings() {
    const mb = Number(settings.store.maxMegabytes);
    if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MAX_BYTES;
    return Math.floor(mb * 1024 * 1024);
}

function createBackend() {
    const dir = (settings.store.cacheDirectory || "").trim();
    const native = getPluginNative();
    return createBackendForPath(dir, native);
}

function getCache() {
    if (!cache) {
        cache = createFavoriteGifCache({
            maxEntries: settings.store.maxEntries || DEFAULT_MAX_ENTRIES,
            maxBytes: maxBytesFromSettings(),
            backend: createBackend(),
            smartEviction: settings.store.smartEviction !== false,
        });
        setActiveCache(cache);
    }
    return cache;
}

async function rebuildCache() {
    cache = null;
    setActiveCache(null);
    const c = getCache();
    await c.init();
    c.setSmartEviction(settings.store.smartEviction !== false);
    await applyLimitsFromSettings();
    return c;
}

setRebuildCache(rebuildCache);

async function applyLimitsFromSettings() {
    try {
        const c = getCache();
        await c.init();
        const max = Math.max(1, Number(settings.store.maxEntries) || DEFAULT_MAX_ENTRIES);
        await c.setMaxEntries(max);
        await c.setMaxBytes(maxBytesFromSettings());
        c.setSmartEviction(settings.store.smartEviction !== false);
        c.warmAllBlobUrls();
    } catch {
        // settings UI should still work
    }
}

settingsHooks.onLimitsChange = () => { void applyLimitsFromSettings(); };
settingsHooks.onSmartEvictionChange = () => {
    try {
        getCache().setSmartEviction(settings.store.smartEviction !== false);
    } catch {
        // ignore
    }
};
settingsHooks.onCacheDirectoryChange = () => { void rebuildCache(); };

/**
 * Update the known favorite URL set.
 * Returns primary media URLs that are newly favorited (not present last time).
 * First call only seeds state so startup/open does not look like mass "new" favorites.
 */
function refreshFavoriteSet(refs?: FavoriteGifRef[]): string[] {
    const list = refs ?? getFavoriteGifRefsFromFrecency();
    const next = new Set<string>();
    const primaryByKey = new Map<string, string>();

    for (const ref of list) {
        const primary = ref.src || ref.url;
        if (!primary) continue;
        for (const k of keysForFavorite(ref)) {
            next.add(k);
            if (!primaryByKey.has(k)) primaryByKey.set(k, primary);
        }
    }

    const newlyAddedUrls: string[] = [];
    if (favoritesSeeded) {
        const seenPrimary = new Set<string>();
        for (const key of next) {
            if (favoriteUrlSet.has(key)) continue;
            const primary = primaryByKey.get(key);
            if (!primary || seenPrimary.has(primary)) continue;
            seenPrimary.add(primary);
            newlyAddedUrls.push(primary);
        }
    }

    favoriteUrlSet = next;
    favoritesSeeded = true;
    getCache().setProtectedKeys(next);
    return newlyAddedUrls;
}

function isTrackedFavorite(url: string) {
    if (!url || !isLikelyGifMediaUrl(url)) return false;
    if (favoriteUrlSet.size === 0) return isLikelyGifMediaUrl(url);
    return favoriteUrlSet.has(url) || favoriteUrlSet.has(cacheKeyForUrl(url));
}

/** Discord favorite format: 0 ≈ image gif; anything else is usually video/mp4. */
function isVideoFavoriteFormat(format?: number) {
    return typeof format === "number" && format !== 0;
}

function shouldCacheFavoriteUrl(url: string, format?: number) {
    if (!url || isHeavyVideoUrl(url) || !isCacheableFavoriteUrl(url)) return false;
    if (isVideoFavoriteFormat(format)) return false;
    return true;
}

function originalSrc(gif: any) {
    return gif?.__fgcOriginalSrc || gif?.src || gif?.url || "";
}

function applySyncBlobSrc(favorites: any[], c: FavoriteGifCache) {
    if (!settings.store.rewriteFavoriteSrc) return 0;
    let changed = 0;
    for (const gif of favorites) {
        if (!gif || typeof gif !== "object") continue;
        const original = originalSrc(gif);
        if (!original || typeof original !== "string") continue;
        if (original.startsWith("blob:") || original.startsWith("data:")) continue;

        const local = c.resolveDisplayUrlSync(original);
        if (local && local.startsWith("blob:") && gif.src !== local) {
            if (!gif.__fgcOriginalSrc) gif.__fgcOriginalSrc = gif.src || original;
            if (!gif.__fgcOriginalUrl && gif.url) gif.__fgcOriginalUrl = gif.url;
            gif.src = local;
            changed += 1;
        }
    }
    return changed;
}

function safeForceUpdate(instance: any) {
    try {
        if (instance && !instance.dead && typeof instance.forceUpdate === "function") {
            instance.forceUpdate();
        }
    } catch {
        // picker stays usable even if forceUpdate flakes
    }
}

async function applyMaxFromSettings() {
    await applyLimitsFromSettings();
}

/** Fill free slots only. Never evicts just to prefetch something new. */
async function prefetchFavorites() {
    try {
        const c = getCache();
        await c.init();
        refreshFavoriteSet();
        const refs = getFavoriteGifRefsFromFrecency();
        const queue = refs
            .filter(r => shouldCacheFavoriteUrl(r.src || r.url, r.format))
            .map(r => r.src || r.url)
            .filter(Boolean) as string[];
        let i = 0;
        const concurrency = 3;

        async function worker() {
            while (i < queue.length) {
                if (c.size() >= c.getMaxEntries()) return;
                const idx = i++;
                const url = queue[idx]!;
                try {
                    await ensureCached(c, url, { allowEvict: false });
                    const key = cacheKeyForUrl(url);
                    c.ensureBlobUrlSync(key, { bumpUsage: false });
                    if (key !== url) c.ensureBlobUrlSync(url, { bumpUsage: false });
                } catch {
                    // skip bad urls
                }
            }
        }

        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        c.warmAllBlobUrls();
    } catch {
        // never take discord down
    }
}

export default definePlugin({
    name: "FavoriteGifCache",
    description: "Cache GIF picker favorites on disk so they load faster",
    authors: [{ name: "Arad", id: 825757055981846560n }],
    tags: ["GIF", "Media", "Performance"],

    settings,

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {
                    // same favorites injection point FavoriteGifSearch uses
                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
            ],
        },
        {
            // When the user clicks a GIF to send it
            find: "handleSelectGIF=",
            replacement: {
                match: /handleSelectGIF=(\i)=>\{/,
                replace: "$&$self.onSelectGif($1);",
            },
        },
    ],

    /**
     * User clicked a GIF to send. If it is a favorite and not cached yet,
     * store it (may evict least-used when full).
     */
    onSelectGif(gif?: { url?: string; src?: string; __fgcOriginalSrc?: string; __fgcOriginalUrl?: string; }) {
        try {
            if (!gif) return;
            const remote =
                gif.__fgcOriginalUrl
                || gif.__fgcOriginalSrc
                || (typeof gif.url === "string" && !gif.url.startsWith("blob:") ? gif.url : "")
                || (typeof gif.src === "string" && !gif.src.startsWith("blob:") ? gif.src : "")
                || "";
            if (!remote || !shouldCacheFavoriteUrl(remote, (gif as any)?.format)) return;
            if (!isTrackedFavorite(remote)) return;

            const c = getCache();
            const key = cacheKeyForUrl(remote);
            if (c.has(key) || c.has(remote)) {
                c.touchSync(key) || c.touchSync(remote);
                return;
            }

            void (async () => {
                try {
                    await c.init();
                    await cacheOnUserAction(c, remote);
                    c.ensureBlobUrlSync(cacheKeyForUrl(remote), { bumpUsage: true });
                } catch {
                    // send still works without cache
                }
            })();
        } catch {
            // ignore
        }
    },

    wrapFavorites(instance: any, favorites: any[]) {
        try {
            if (!Array.isArray(favorites)) return favorites;
            if (instance && typeof instance === "object") lastPickerInstance = instance;

            const refs: FavoriteGifRef[] = favorites
                .map((g: any) => ({
                    url: g?.url || g?.src || "",
                    src: g?.src || g?.url || "",
                    width: g?.width,
                    height: g?.height,
                    format: g?.format,
                    order: g?.order,
                }))
                .filter(r => r.url || r.src);

            const newlyFavorited = refreshFavoriteSet(refs);
            const c = getCache();
            applySyncBlobSrc(favorites, c);

            void (async () => {
                try {
                    await c.init();
                    c.warmAllBlobUrls();
                    let changed = applySyncBlobSrc(favorites, c) > 0;

                    // Brand-new favorites may steal a slot from least-used when full
                    // (still skip mp4/video — those stay on the network)
                    for (const u of newlyFavorited) {
                        if (!shouldCacheFavoriteUrl(u)) continue;
                        try {
                            await cacheOnUserAction(c, u);
                            const key = cacheKeyForUrl(u);
                            c.ensureBlobUrlSync(key, { bumpUsage: false });
                        } catch {
                            // ignore single failures
                        }
                    }

                    for (const ref of refs) {
                        const u = ref.src || ref.url;
                        if (!u || u.startsWith("blob:")) continue;
                        if (!shouldCacheFavoriteUrl(u, ref.format)) continue;
                        const key = cacheKeyForUrl(u);

                        // Scrolling: only fill free slots, never thrash-evict
                        if (!c.has(key) && !c.has(u)) {
                            if (c.size() < c.getMaxEntries()) {
                                await ensureCached(c, u, { allowEvict: false });
                            }
                        }

                        const blob = c.ensureBlobUrlSync(key, { bumpUsage: false })
                            || c.ensureBlobUrlSync(u, { bumpUsage: false });
                        if (!blob) continue;

                        for (const gif of favorites) {
                            const orig = originalSrc(gif);
                            if (!orig || orig.startsWith("blob:")) continue;
                            if (cacheKeyForUrl(orig) === key || orig === u || orig === key) {
                                if (gif.src !== blob) {
                                    if (!gif.__fgcOriginalSrc) gif.__fgcOriginalSrc = gif.src || orig;
                                    gif.src = blob;
                                    c.touchSync(key) || c.touchSync(u);
                                    changed = true;
                                }
                            }
                        }
                    }

                    if (changed) safeForceUpdate(instance ?? lastPickerInstance);
                } catch {
                    // ignore
                }
            })();
        } catch {
            // ignore
        }
        return favorites;
    },

    async start() {
        try {
            // loads IndexedDB from last session — does not wipe on restart
            await applyMaxFromSettings();
            refreshFavoriteSet();
            uninstallFetch = installFetchInterceptor(getCache(), isTrackedFavorite);

            if (settings.store.prefetchOnStart) {
                prefetchTimer = setTimeout(() => {
                    void prefetchFavorites();
                }, 2500);
            }
        } catch (e) {
            console.error("[FavoriteGifCache] failed to start", e);
        }
    },

    stop() {
        // only drop process state. IndexedDB on disk is left alone.
        if (prefetchTimer) {
            clearTimeout(prefetchTimer);
            prefetchTimer = null;
        }
        if (uninstallFetch) {
            uninstallFetch();
            uninstallFetch = null;
        }
        cache = null;
        setActiveCache(null);
        favoriteUrlSet = new Set();
        favoritesSeeded = false;
        lastPickerInstance = null;
    },
});

export {
    createFavoriteGifCache,
    DEFAULT_MAX_ENTRIES,
    FavoriteGifCache,
} from "./gifCache";
export { GifCacheCore } from "./cacheCore";
