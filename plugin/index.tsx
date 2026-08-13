/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { FluxDispatcher, Menu, Toasts } from "@webpack/common";

import { setActiveCache, setRebuildCache } from "./cacheAccess";
import { CacheUsageBar } from "./CacheUsageBar";
import {
    allowAutoCache,
    denyAutoCache,
    isAutoCacheDenied,
    loadDenylist,
} from "./denylist";
import {
    favoriteStableKey,
    GIF_FORMAT_VIDEO,
    healFavoriteUrls,
    isBlobOrDataUrl,
    isRemoteHttpUrl,
    mimeMatchesFormat,
    remoteDisplaySrc,
    remoteSendUrl,
    restoreUrlsForSend,
    stashOriginalUrls,
} from "./displayUrls";
import {
    cacheKeyForUrl,
    favoriteRefsToPickerItems,
    getFavoriteGifRefsFromFrecency,
    isCacheableFavoriteUrl,
    isHeavyVideoUrl,
    isLikelyGifMediaUrl,
    keysForFavorite,
    PREFETCH_WARM_NEWEST,
    prefetchTargetBytes,
    sortFavoritesNewestFirst,
    waitForFavoriteGifRefs,
    type FavoriteGifRef,
} from "./favorites";
import {
    createFavoriteGifCache,
    DEFAULT_MAX_BYTES,
    type FavoriteGifCache,
} from "./gifCache";
import { cacheOnUserAction, ensureCached, MAX_ENTRY_BYTES } from "./media";
import { getPluginNative } from "./nativeApi";
import { purgeStalePluginSettings, setUsageBarComponent, settings, settingsHooks } from "./settings";
import { createBackendForPath } from "./storage";

export { settings };

setUsageBarComponent(() => <CacheUsageBar />);

let cache: FavoriteGifCache | null = null;
let favoriteUrlSet = new Set<string>();

let favoritesSeeded = false;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let lastPickerInstance: { forceUpdate?: () => void; dead?: boolean } | null = null;
let wrapAsyncGeneration = 0;
let forceUpdateTimer: ReturnType<typeof setTimeout> | null = null;

const displayViews = new Map<string, any>();
let lastGoodFavorites: any[] = [];
let emptyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let emptyRetryCount = 0;
let unsubSettings: (() => void) | null = null;

function maxBytesFromSettings() {
    const mb = Number(settings.store.maxMegabytes);
    if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_MAX_BYTES;
    return Math.floor(mb * 1024 * 1024);
}


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

    } catch {

    }
}

settingsHooks.onLimitsChange = () => { void applyLimitsFromSettings(); };
settingsHooks.onSmartEvictionChange = () => {
    try {
        getCache().setSmartEviction(settings.store.smartEviction !== false);
    } catch {

    }
};
settingsHooks.onCacheDirectoryChange = () => { void rebuildCache(); };


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

    if (!favoritesSeeded || favoriteUrlSet.size === 0) return false;
    return favoriteUrlSet.has(url) || favoriteUrlSet.has(cacheKeyForUrl(url));
}

function shouldCacheFavoriteUrl(url: string, _format?: number) {
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) return false;

    return isCacheableFavoriteUrl(url) || isLikelyGifMediaUrl(url);
}


function pickCacheableUrl(ref: { src?: string; url?: string; format?: number; }): string | null {
    const candidates = [ref.src, ref.url].filter((u): u is string => !!u && typeof u === "string");
    const nonVideo = candidates.filter(u => shouldCacheFavoriteUrl(u) && !isHeavyVideoUrl(u));
    if (nonVideo.length) return nonVideo[0]!;
    for (const u of candidates) {
        if (shouldCacheFavoriteUrl(u)) return u;
    }
    return null;
}

function safeForceUpdate(instance: any) {
    try {
        if (instance && !instance.dead && typeof instance.forceUpdate === "function") {
            instance.forceUpdate();
        }
    } catch {

    }
}

function scheduleForceUpdate(instance: any) {
    if (forceUpdateTimer) clearTimeout(forceUpdateTimer);
    forceUpdateTimer = setTimeout(() => {
        forceUpdateTimer = null;
        safeForceUpdate(instance ?? lastPickerInstance);
    }, 48);
}

function scheduleEmptyRetry(instance: any) {
    if (emptyRetryCount >= 8) return;
    if (emptyRetryTimer) return;
    emptyRetryTimer = setTimeout(() => {
        emptyRetryTimer = null;
        emptyRetryCount += 1;
        safeForceUpdate(instance ?? lastPickerInstance);
    }, 250 + emptyRetryCount * 200);
}

function readRemotes(storeGif: any) {
    healFavoriteUrls(storeGif);
    stashOriginalUrls(storeGif);
    const src = remoteDisplaySrc(storeGif)
        || (isRemoteHttpUrl(storeGif?.src) ? storeGif.src : "")
        || (isRemoteHttpUrl(storeGif?.url) ? storeGif.url : "");
    const url = remoteSendUrl(storeGif)
        || (isRemoteHttpUrl(storeGif?.url) ? storeGif.url : "")
        || src;
    const format = typeof storeGif?.format === "number"
        ? storeGif.format
        : (typeof storeGif?.__fgcOriginalFormat === "number" ? storeGif.__fgcOriginalFormat : undefined);
    return { src, url, format };
}


function getStableDisplayGif(storeGif: any, c: FavoriteGifCache | null): any {
    if (!storeGif || typeof storeGif !== "object") return storeGif;

    const { src: remoteSrc, url: remoteUrl, format } = readRemotes(storeGif);
    const key = remoteUrl || remoteSrc;
    if (!key) {
        healFavoriteUrls(storeGif);
        return storeGif;
    }

    const cdnSrc = remoteSrc || remoteUrl;
    const cdnUrl = remoteUrl || remoteSrc;

    let view = displayViews.get(key);
    if (!view) {
        view = { ...storeGif };
        view.__fgcOriginalSrc = cdnSrc;
        view.__fgcOriginalUrl = cdnUrl;
        if (typeof format === "number") {
            view.__fgcOriginalFormat = format;
            view.format = format;
        }
        view.src = cdnSrc;
        view.url = cdnUrl;
        displayViews.set(key, view);
    } else {
        if (cdnSrc) view.__fgcOriginalSrc = cdnSrc;
        if (cdnUrl) view.__fgcOriginalUrl = cdnUrl;
        if (typeof format === "number") {
            view.__fgcOriginalFormat = format;
            view.format = format;
        } else if (typeof view.__fgcOriginalFormat === "number") {
            view.format = view.__fgcOriginalFormat;
        }
        if (storeGif.width != null) view.width = storeGif.width;
        if (storeGif.height != null) view.height = storeGif.height;
        if (storeGif.order != null) view.order = storeGif.order;
        view.url = view.__fgcOriginalUrl || cdnUrl;
    }


    const srcNow = view.src;
    if (!srcNow || isBlobOrDataUrl(srcNow)) {
        const live = c && isBlobOrDataUrl(srcNow) && c.isInitialized() && c.isLiveBlobUrl(srcNow);
        if (!live) view.src = view.__fgcOriginalSrc || view.__fgcOriginalUrl || cdnSrc;
    } else if (!isRemoteHttpUrl(srcNow)) {
        view.src = view.__fgcOriginalSrc || view.__fgcOriginalUrl || cdnSrc;
    }

    return view;
}

function displayCandidateUrls(view: any): string[] {
    const src = view.__fgcOriginalSrc || "";
    const url = view.__fgcOriginalUrl || "";
    const format = typeof view.__fgcOriginalFormat === "number" ? view.__fgcOriginalFormat : view.format;
    const out: string[] = [];
    const push = (u: string) => {
        if (u && isRemoteHttpUrl(u) && !out.includes(u)) out.push(u);
    };
    if (format === GIF_FORMAT_VIDEO) {
        if (isHeavyVideoUrl(src)) push(src);
        if (isHeavyVideoUrl(url)) push(url);
    } else {
        if (src && !isHeavyVideoUrl(src)) push(src);
        if (url && !isHeavyVideoUrl(url)) push(url);
    }
    push(src);
    push(url);
    return out;
}


function paintCachedSrc(view: any, c: FavoriteGifCache): boolean {
    const cdn = view.__fgcOriginalSrc || view.__fgcOriginalUrl;
    const send = view.__fgcOriginalUrl || cdn;
    let changed = false;

    if (send && view.url !== send) {
        view.url = send;
        changed = true;
    }
    if (typeof view.__fgcOriginalFormat === "number" && view.format !== view.__fgcOriginalFormat) {
        view.format = view.__fgcOriginalFormat;
        changed = true;
    }

    if (!settings.store.rewriteFavoriteSrc) {
        if (cdn && view.src !== cdn) {
            view.src = cdn;
            changed = true;
        }
        return changed;
    }

    const format = typeof view.__fgcOriginalFormat === "number"
        ? view.__fgcOriginalFormat
        : (typeof view.format === "number" ? view.format : 1);

    for (const remote of displayCandidateUrls(view)) {
        const hit = c.resolveDisplayHitSync(remote, { bumpUsage: false });
        if (!hit?.blobUrl?.startsWith("blob:")) continue;
        if (!mimeMatchesFormat(format, hit.mimeType)) continue;
        if (!c.isLiveBlobUrl(hit.blobUrl)) continue;
        if (view.src !== hit.blobUrl) {
            view.src = hit.blobUrl;
            changed = true;
        }
        return changed;
    }

    if (cdn && view.src !== cdn) {
        view.src = cdn;
        changed = true;
    }
    return changed;
}

async function applyMaxFromSettings() {
    await applyLimitsFromSettings();
}

function toast(message: string, type: any) {
    try {
        Toasts.show({ message, type, id: Toasts.genId() });
    } catch {

    }
}

function resolveItemUrl(item: any): string | null {
    if (!item) return null;
    stashOriginalUrls(item);
    const src = remoteDisplaySrc(item) || undefined;
    const url = remoteSendUrl(item) || undefined;
    const picked = pickCacheableUrl({ src, url, format: item.format });
    if (picked) return picked;
    if (url) return url;
    if (src) return src;
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
        maxBytes: Number.MAX_SAFE_INTEGER,
    });
    if (res?.stored || c.has(cacheKeyForUrl(url))) {
        c.ensureBlobUrlSync(cacheKeyForUrl(url), { bumpUsage: true });
        toast("GIF Cached", Toasts.Type.SUCCESS);
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
    toast("GIF Removed From Cache", Toasts.Type.SUCCESS);
    safeForceUpdate(lastPickerInstance);
}


async function prefetchFavorites() {
    try {
        const c = getCache();
        await c.init();
        refreshFavoriteSet();
        let refs = getFavoriteGifRefsFromFrecency();

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

                }
            }
        };


        if (c.bytes() >= targetBytes) {
            await warmNewest();
            return;
        }


        let steps = 0;
        for (const url of queue) {
            if (c.bytes() >= targetBytes) break;
            try {
                const key = cacheKeyForUrl(url);
                if (c.has(key) || c.has(url)) continue;
                await ensureCached(c, url, { allowEvict: false, ...autoCacheOpts() });

                steps += 1;
                if (steps % 2 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            } catch {

            }
        }

        await warmNewest();
    } catch {

    }
}

export default definePlugin({
    name: "FavoriteGifCache",
    description: "Caches GIF picker favorites on disk so they load from local storage instead of re-downloading",
    authors: [{ name: "Arad", id: 825757055981846560n }],
    tags: ["GIF", "Media", "Performance"],


    settings,

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {

                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.wrapFavorites(this,$2),",
                },
                {

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

    
    gifPickerContextMenu(instance: any, _e?: any) {
        try {
            const item = instance?.props?.item ?? instance?.props;
            const url = resolveItemUrl(item);
            if (!url) return null;

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

    
    onSelectGif(gif?: { url?: string; src?: string; format?: number; __fgcOriginalSrc?: string; __fgcOriginalUrl?: string; }) {
        try {
            if (!gif) return;


            restoreUrlsForSend(gif);

            const remote = pickCacheableUrl({
                src: remoteDisplaySrc(gif) || undefined,
                url: remoteSendUrl(gif) || undefined,
                format: gif.format,
            });
            if (!remote) return;
            if (!isTrackedFavorite(remote) && !isTrackedFavorite(remoteSendUrl(gif) || "") && !isTrackedFavorite(remoteDisplaySrc(gif) || "")) {

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

                }
            })();
        } catch {

        }
    },

    wrapFavorites(instance: any, favorites: any[]) {
        try {
            if (!Array.isArray(favorites)) return favorites;
            if (instance && typeof instance === "object") lastPickerInstance = instance;

            let source = favorites;
            if (source.length === 0) {
                const fromStore = favoriteRefsToPickerItems(getFavoriteGifRefsFromFrecency());
                if (fromStore.length) source = fromStore;
                else if (lastGoodFavorites.length) source = lastGoodFavorites;
                else {
                    scheduleEmptyRetry(instance);
                    return source;
                }
            } else {
                emptyRetryCount = 0;
            }

            const c = getCache();

            for (const g of source) healFavoriteUrls(g);
            const view = source.map(g => getStableDisplayGif(g, c.isInitialized() ? c : null));

            if (!view.length) {
                scheduleEmptyRetry(instance);
                return lastGoodFavorites.length ? lastGoodFavorites : source;
            }
            lastGoodFavorites = view;


            const live = new Set<string>();
            for (const v of view) {
                const k = v?.__fgcOriginalUrl || v?.__fgcOriginalSrc || favoriteStableKey(v);
                if (k) live.add(k);
            }
            for (const k of [...displayViews.keys()]) {
                if (!live.has(k)) displayViews.delete(k);
            }

            const refs: FavoriteGifRef[] = [];
            for (const g of view) {
                const url = g?.__fgcOriginalUrl || remoteSendUrl(g) || "";
                const src = g?.__fgcOriginalSrc || remoteDisplaySrc(g) || "";
                if (!url && !src) continue;
                refs.push({
                    url,
                    src,
                    width: g?.width,
                    height: g?.height,
                    format: typeof g?.__fgcOriginalFormat === "number" ? g.__fgcOriginalFormat : g?.format,
                    order: g?.order,
                });
            }

            const newlyFavorited = refreshFavoriteSet(refs);

            const visibleKeys: string[] = [];
            const seen = new Set<string>();
            for (const ref of refs) {
                for (const u of [ref.src, ref.url, pickCacheableUrl(ref)]) {
                    if (!u) continue;
                    const key = cacheKeyForUrl(u);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    visibleKeys.push(key);
                }
            }
            c.setDisplayPinnedKeys(visibleKeys);


            if (c.isInitialized()) {
                for (const v of view) paintCachedSrc(v, c);
            }

            const gen = ++wrapAsyncGeneration;
            void (async () => {
                try {
                    await c.init();
                    if (gen !== wrapAsyncGeneration) return;
                    c.setDisplayPinnedKeys(visibleKeys);

                    for (const key of visibleKeys) {
                        if (c.has(key) && !c.hasResidentData(key)) await c.hydrate(key);
                        if (c.hasResidentData(key)) c.ensureBlobUrlSync(key, { bumpUsage: false });
                        if (gen !== wrapAsyncGeneration) return;
                    }

                    let changed = false;
                    for (const v of view) {
                        if (paintCachedSrc(v, c)) changed = true;
                    }

                    for (const u of newlyFavorited) {
                        const cacheUrl = pickCacheableUrl({ src: u, url: u });
                        if (!cacheUrl || isAutoCacheDenied(cacheUrl)) continue;
                        try {
                            await cacheOnUserAction(c, cacheUrl, fetch, autoCacheOpts());
                            await c.ensureBlobUrl(cacheKeyForUrl(cacheUrl), { bumpUsage: false });
                        } catch {  }
                        if (gen !== wrapAsyncGeneration) return;
                    }

                    let downloads = 0;
                    for (const ref of refs) {
                        if (downloads >= 10) break;
                        for (const u of displayCandidateUrls({
                            __fgcOriginalSrc: ref.src,
                            __fgcOriginalUrl: ref.url,
                            __fgcOriginalFormat: ref.format,
                            format: ref.format,
                        })) {
                            if (isAutoCacheDenied(u)) continue;
                            const key = cacheKeyForUrl(u);
                            if (!c.has(key) && !c.has(u) && downloads < 10) {
                                await ensureCached(c, u, { allowEvict: false, ...autoCacheOpts() });
                                downloads += 1;
                            }
                            if (c.has(key) || c.has(u)) {
                                await c.ensureBlobUrl(key, { bumpUsage: false });
                            }
                        }
                        if (gen !== wrapAsyncGeneration) return;
                    }

                    for (const v of view) {
                        if (paintCachedSrc(v, c)) changed = true;
                    }
                    if (changed) scheduleForceUpdate(instance);
                } catch {

                }
            })();

            return view;
        } catch {
            return favorites;
        }
    },

    async start() {
        try {
            purgeStalePluginSettings();

            try {
                if (settings.store.rewriteFavoriteSrc !== true) {
                    settings.store.rewriteFavoriteSrc = true;
                }
            } catch {

            }
            await loadDenylist();
            await applyMaxFromSettings();

            try {
                await getCache().init();
            } catch {
            }

            const early = await waitForFavoriteGifRefs(10, 300);
            if (early.length) {
                lastGoodFavorites = favoriteRefsToPickerItems(early);
                refreshFavoriteSet(early);
            } else {
                refreshFavoriteSet();
            }

            const onSettings = () => {
                const refs = getFavoriteGifRefsFromFrecency();
                if (!refs.length) return;
                lastGoodFavorites = favoriteRefsToPickerItems(refs);
                refreshFavoriteSet(refs);
                safeForceUpdate(lastPickerInstance);
            };
            try {
                FluxDispatcher.subscribe("USER_SETTINGS_PROTO_UPDATE", onSettings);
                unsubSettings = () => {
                    try {
                        FluxDispatcher.unsubscribe("USER_SETTINGS_PROTO_UPDATE", onSettings);
                    } catch {
                    }
                };
            } catch {
            }

            if (settings.store.prefetchOnStart) {
                prefetchTimer = setTimeout(() => {
                    void prefetchFavorites().then(() => {
                        setTimeout(() => void prefetchFavorites(), 8000);
                    });
                }, 800);
            }
        } catch (e) {
            console.error("[FavoriteGifCache] failed to start", e);
        }
    },

    stop() {
        if (prefetchTimer) {
            clearTimeout(prefetchTimer);
            prefetchTimer = null;
        }
        if (forceUpdateTimer) {
            clearTimeout(forceUpdateTimer);
            forceUpdateTimer = null;
        }
        if (emptyRetryTimer) {
            clearTimeout(emptyRetryTimer);
            emptyRetryTimer = null;
        }
        if (unsubSettings) {
            unsubSettings();
            unsubSettings = null;
        }
        cache = null;
        setActiveCache(null);
        favoriteUrlSet = new Set();
        favoritesSeeded = false;
        lastPickerInstance = null;
        lastGoodFavorites = [];
        emptyRetryCount = 0;
        displayViews.clear();
        wrapAsyncGeneration += 1;
    },
});

export {
    createFavoriteGifCache,
    DEFAULT_MAX_BYTES,
    FavoriteGifCache,
} from "./gifCache";
export { GifCacheCore } from "./cacheCore";
