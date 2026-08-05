/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { Menu, Toasts } from "@webpack/common";

import { setActiveCache, setRebuildCache } from "./cacheAccess";
import { CacheUsageBar } from "./CacheUsageBar";
import {
    allowAutoCache,
    denyAutoCache,
    isAutoCacheDenied,
    loadDenylist,
} from "./denylist";
import {
    cacheKeyForUrl,
    getFavoriteGifRefsFromFrecency,
    isCacheableFavoriteUrl,
    isHeavyVideoUrl,
    isLikelyGifMediaUrl,
    keysForFavorite,
    PREFETCH_WARM_NEWEST,
    prefetchTargetBytes,
    sortFavoritesNewestFirst,
    type FavoriteGifRef,
} from "./favorites";
import {
    createFavoriteGifCache,
    DEFAULT_MAX_BYTES,
    type FavoriteGifCache,
} from "./gifCache";
import { cacheOnUserAction, ensureCached, installFetchInterceptor, MAX_ENTRY_BYTES } from "./media";
import { getPluginNative } from "./nativeApi";
import { purgeStalePluginSettings, setUsageBarComponent, settings, settingsHooks } from "./settings";
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

/** Per-file download cap; Infinity when skipLargeFiles is off. */
function perFileMaxBytes() {
    return settings.store.skipLargeFiles === false ? Number.MAX_SAFE_INTEGER : MAX_ENTRY_BYTES;
}

function createBackend() {
    const dir = (settings.store.cacheDirectory || "").trim();
    const native = getPluginNative();
    return createBackendForPath(dir, native);
}

function getCache() {
    if (!cache) {
        cache = createFavoriteGifCache({
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
        await c.setMaxBytes(maxBytesFromSettings());
        c.setSmartEviction(settings.store.smartEviction !== false);
        // do not warm entire cache into RAM after settings change
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
    // Until favorites seed, do NOT treat every gif URL as favorite — that made
    // the fetch interceptor + cache init run on every media request (crash fuel).
    if (!favoritesSeeded || favoriteUrlSet.size === 0) return false;
    return favoriteUrlSet.has(url) || favoriteUrlSet.has(cacheKeyForUrl(url));
}

function shouldCacheFavoriteUrl(url: string, _format?: number) {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;
    // Size filter happens at download time — don't block Tenor mp4 "gifs" by format alone
    return isCacheableFavoriteUrl(url) || isLikelyGifMediaUrl(url);
}

/** Prefer image-like urls when both src and url exist; otherwise first media url. */
function pickCacheableUrl(ref: { src?: string; url?: string; format?: number; }): string | null {
    const candidates = [ref.src, ref.url].filter((u): u is string => !!u && typeof u === "string");
    const nonVideo = candidates.filter(u => shouldCacheFavoriteUrl(u) && !isHeavyVideoUrl(u));
    if (nonVideo.length) return nonVideo[0]!;
    for (const u of candidates) {
        if (shouldCacheFavoriteUrl(u)) return u;
    }
    return null;
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

function toast(message: string, type: any) {
    try {
        Toasts.show({ message, type, id: Toasts.genId() });
    } catch {
        // ignore
    }
}

function resolveItemUrl(item: any): string | null {
    if (!item) return null;
    // Prefer originals we stashed when rewriting to blob: — context menu must not use blob URLs
    const src = typeof item.__fgcOriginalSrc === "string" && item.__fgcOriginalSrc
        ? item.__fgcOriginalSrc
        : (typeof item.src === "string" && !item.src.startsWith("blob:") && !item.src.startsWith("data:")
            ? item.src
            : undefined);
    const url = typeof item.__fgcOriginalUrl === "string" && item.__fgcOriginalUrl
        ? item.__fgcOriginalUrl
        : (typeof item.url === "string" && !item.url.startsWith("blob:") && !item.url.startsWith("data:")
            ? item.url
            : undefined);

    const picked = pickCacheableUrl({ src, url, format: item.format });
    if (picked) return picked;
    if (src) return src;
    if (url) return url;
    return null;
}

function isLocallyCached(url: string) {
    try {
        const c = getCache();
        const key = cacheKeyForUrl(url);
        return c.has(key) || c.has(url);
    } catch {
        return false;
    }
}

const autoCacheOpts = () => ({
    isDenied: isAutoCacheDenied,
    maxBytes: perFileMaxBytes(),
});

async function manualCacheGif(url: string) {
    await allowAutoCache(url);
    const c = getCache();
    await c.init();
    const res = await cacheOnUserAction(c, url, fetch, {
        force: true,
        maxBytes: perFileMaxBytes(),
    });
    if (res?.stored || c.has(cacheKeyForUrl(url))) {
        c.ensureBlobUrlSync(cacheKeyForUrl(url), { bumpUsage: true });
        toast("GIF cached", Toasts.Type.SUCCESS);
        safeForceUpdate(lastPickerInstance);
    } else {
        toast("Could not cache GIF", Toasts.Type.FAILURE);
    }
}

async function manualRemoveFromCache(url: string) {
    const c = getCache();
    await c.init();
    const key = cacheKeyForUrl(url);
    await c.delete(key);
    if (key !== url) await c.delete(url);
    await denyAutoCache(url);
    toast("Removed from cache — won't auto-cache again", Toasts.Type.SUCCESS);
    safeForceUpdate(lastPickerInstance);
}

/**
 * Startup auto-download:
 * newest first until cache catalog hits 1/3 of max size (e.g. 500 MB → ~167 MB on disk).
 * Never evicts. Does not keep ~167 MB of blob URLs in RAM — soft memory + warm only newest slice.
 */
async function prefetchFavorites() {
    try {
        const c = getCache();
        await c.init();
        refreshFavoriteSet();
        let refs = getFavoriteGifRefsFromFrecency();
        // Frecency can be empty early in boot — retry once
        if (!refs.length) {
            await new Promise(r => setTimeout(r, 2000));
            refs = getFavoriteGifRefsFromFrecency();
        }

        const targetBytes = prefetchTargetBytes(c.getMaxBytes());
        const newest = sortFavoritesNewestFirst(refs);
        const queue: string[] = [];
        const seen = new Set<string>();
        for (const ref of newest) {
            const u = pickCacheableUrl(ref);
            if (!u) continue;
            const key = cacheKeyForUrl(u);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(u);
        }
        if (!queue.length) return;

        const warmNewest = async () => {
            for (const url of queue.slice(0, PREFETCH_WARM_NEWEST)) {
                try {
                    await c.ensureBlobUrl(cacheKeyForUrl(url), { bumpUsage: false });
                } catch {
                    // ignore
                }
            }
        };

        // Already at / over 1/3 capacity — only warm a small newest slice
        if (c.bytes() >= targetBytes) {
            await warmNewest();
            return;
        }

        // Disk-first fill to 1/3. Soft RAM unload runs inside put; no per-file blob mint.
        let steps = 0;
        for (const url of queue) {
            if (c.bytes() >= targetBytes) break;
            try {
                const key = cacheKeyForUrl(url);
                if (c.has(key) || c.has(url)) continue;
                await ensureCached(c, url, { allowEvict: false, ...autoCacheOpts() });
                // yield so Discord UI / input stay responsive during a long 1/3 fill
                steps += 1;
                if (steps % 2 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            } catch {
                // skip bad urls
            }
        }

        await warmNewest();
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
                    // plain favorites: ...
                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
                {
                    // after FavoriteGifSearch: favorites:$self.getFav(x),
                    match: /(,suggestions:\i,favorites:)(\i\.getFav\(\i\)),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
            ],
        },
        {
            find: "handleSelectGIF=",
            replacement: {
                match: /handleSelectGIF=(\i)=>\{/,
                replace: "$&$self.onSelectGif($1);",
            },
        },
    ],

    /**
     * Right-click on GIF in picker (ExtraContextMenusAPI wires this in).
     * Signature matches GifPickerContextMenuItemFactory: (instance, event).
     */
    gifPickerContextMenu(instance: any, _e?: any) {
        try {
            const item = instance?.props?.item ?? instance?.props;
            const url = resolveItemUrl(item);
            if (!url) return null;
            // allow any remote media URL from the picker, not only known hosts
            if (url.startsWith("blob:") || url.startsWith("data:")) return null;

            const cached = isLocallyCached(url);

            return (
                <Menu.MenuGroup>
                    <Menu.MenuItem
                        id="fgc-cache-gif"
                        label="Cache GIF"
                        disabled={cached}
                        action={() => { void manualCacheGif(url); }}
                    />
                    <Menu.MenuItem
                        id="fgc-remove-cache"
                        label="Remove from cache"
                        color="danger"
                        disabled={!cached}
                        action={() => { void manualRemoveFromCache(url); }}
                    />
                </Menu.MenuGroup>
            );
        } catch (e) {
            console.error("[FavoriteGifCache] gifPickerContextMenu failed", e);
            return null;
        }
    },

    /**
     * User clicked a GIF to send. If it is a favorite and not cached yet,
     * store it (may evict least-used when full).
     */
    onSelectGif(gif?: { url?: string; src?: string; format?: number; __fgcOriginalSrc?: string; __fgcOriginalUrl?: string; }) {
        try {
            if (!gif) return;
            const remote = pickCacheableUrl({
                src: gif.__fgcOriginalSrc
                    || (typeof gif.src === "string" && !gif.src.startsWith("blob:") ? gif.src : "")
                    || undefined,
                url: gif.__fgcOriginalUrl
                    || (typeof gif.url === "string" && !gif.url.startsWith("blob:") ? gif.url : "")
                    || undefined,
                format: gif.format,
            });
            if (!remote) return;
            if (!isTrackedFavorite(remote) && !isTrackedFavorite(gif.url || "") && !isTrackedFavorite(gif.src || "")) {
                // still cache if it looks like a favorite media host from picker
                if (!isLikelyGifMediaUrl(remote)) return;
            }

            const c = getCache();
            const key = cacheKeyForUrl(remote);
            if (isAutoCacheDenied(remote)) return;

            if (c.has(key) || c.has(remote)) {
                c.touchSync(key) || c.touchSync(remote);
                return;
            }

            void (async () => {
                try {
                    await c.init();
                    await cacheOnUserAction(c, remote, fetch, autoCacheOpts());
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
                    // Only warm keys for THIS visible list — never the whole disk cache
                    const visibleKeys: string[] = [];
                    for (const ref of refs) {
                        const u = pickCacheableUrl(ref);
                        if (!u) continue;
                        visibleKeys.push(cacheKeyForUrl(u));
                    }
                    // hydrate a few visible entries that are on disk but not in RAM
                    let hydrateBudget = 12;
                    for (const key of visibleKeys) {
                        if (hydrateBudget <= 0) break;
                        if (c.has(key) && !c.hasResidentData(key)) {
                            await c.hydrate(key);
                            hydrateBudget -= 1;
                        }
                    }
                    c.warmAllBlobUrls(visibleKeys);
                    let changed = applySyncBlobSrc(favorites, c) > 0;

                    // Brand-new favorites may steal space from least-used when full
                    for (const u of newlyFavorited) {
                        const cacheUrl = pickCacheableUrl({ src: u, url: u });
                        if (!cacheUrl || isAutoCacheDenied(cacheUrl)) continue;
                        try {
                            await cacheOnUserAction(c, cacheUrl, fetch, autoCacheOpts());
                            const key = cacheKeyForUrl(cacheUrl);
                            await c.ensureBlobUrl(key, { bumpUsage: false });
                        } catch {
                            // ignore single failures
                        }
                    }

                    // Scroll fill: tiny budget so opening the picker cannot download 500MB
                    let scrollDownloads = 0;
                    const SCROLL_DOWNLOAD_BUDGET = 3;

                    for (const ref of refs) {
                        const u = pickCacheableUrl(ref);
                        if (!u || isAutoCacheDenied(u)) continue;
                        const key = cacheKeyForUrl(u);

                        if (!c.has(key) && !c.has(u) && scrollDownloads < SCROLL_DOWNLOAD_BUDGET) {
                            await ensureCached(c, u, { allowEvict: false, ...autoCacheOpts() });
                            scrollDownloads += 1;
                        }

                        const blob = await c.ensureBlobUrl(key, { bumpUsage: false })
                            || await c.ensureBlobUrl(u, { bumpUsage: false });
                        if (!blob) continue;

                        for (const gif of favorites) {
                            const orig = originalSrc(gif);
                            if (!orig || orig.startsWith("blob:")) continue;
                            if (cacheKeyForUrl(orig) === key || orig === u || orig === key) {
                                if (gif.src !== blob) {
                                    if (!gif.__fgcOriginalSrc) gif.__fgcOriginalSrc = gif.src || orig;
                                    if (!gif.__fgcOriginalUrl && gif.url) gif.__fgcOriginalUrl = gif.url;
                                    gif.src = blob;
                                    // some builds read .url for the media element
                                    if (typeof gif.url === "string" && !gif.url.startsWith("blob:")) {
                                        gif.url = blob;
                                    }
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
            // strip removed options (maxEntries, showCacheBadges, …) from saved settings
            purgeStalePluginSettings();
            await loadDenylist();
            // loads IndexedDB from last session — does not wipe on restart
            await applyMaxFromSettings();
            refreshFavoriteSet();
            uninstallFetch = installFetchInterceptor(getCache(), isTrackedFavorite);

            if (settings.store.prefetchOnStart) {
                // sooner + one backup pass so boot races with Frecency still fill the cache
                prefetchTimer = setTimeout(() => {
                    void prefetchFavorites().then(() => {
                        setTimeout(() => void prefetchFavorites(), 8000);
                    });
                }, 1200);
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
    DEFAULT_MAX_BYTES,
    FavoriteGifCache,
} from "./gifCache";
export { GifCacheCore } from "./cacheCore";
