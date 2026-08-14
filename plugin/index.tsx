/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { FluxDispatcher, Menu, Toasts, UserSettingsActionCreators } from "@webpack/common";

import { setActiveCache, setRebuildCache } from "./cacheAccess";
import { CacheUsageBar } from "./CacheUsageBar";
import {
    allowAutoCache,
    denyAutoCache,
    isAutoCacheDenied,
    loadDenylist,
} from "./denylist";
import {
    GIF_FORMAT_IMAGE,
    GIF_FORMAT_VIDEO,
    healFavoriteUrls,
    isBlobOrDataUrl,
    isRemoteHttpUrl,
    isVideoMime,
    mimeMatchesFormat,
    remoteDisplaySrc,
    remoteSendUrl,
    restoreUrlsForSend,
    stashOriginalUrls,
} from "./displayUrls";
import {
    cacheKeyForUrl,
    getFavoriteGifRefsFromFrecency,
    isCacheableFavoriteUrl,
    isHeavyVideoUrl,
    isLikelyGifMediaUrl,
    keysForFavorite,
    prefetchTargetBytes,
    requestFavoriteGifsLoad,
    sortFavoritesNewestFirst,
    type FavoriteGifRef,
} from "./favorites";
import {
    createFavoriteGifCache,
    DEFAULT_MAX_BYTES,
    type FavoriteGifCache,
} from "./gifCache";
import { mediaLookupKeys } from "./hosts";
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
let forceUpdateTimer: ReturnType<typeof setTimeout> | null = null;

let emptyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let emptyRetryCount = 0;
let unsubSettings: (() => void) | null = null;
let mediaErrorBound = false;
let mediaObserver: MutationObserver | null = null;
let lastFavorites: any[] = [];
const pendingAddRefs = new Map<string, FavoriteGifRef>();
const pendingRemoveKeys = new Set<string>();
let favoriteDiffFlush: Promise<void> | null = null;
let favoritePoll: ReturnType<typeof setInterval> | null = null;
let wrapWork: Promise<void> | null = null;
let wrapWorkPending: {
    favorites: any[];
    refs: FavoriteGifRef[];
    visibleKeys: string[];
    newlyFavorited: string[];
} | null = null;

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
        cache.setRevokeListener(onBlobRevoking);
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


function refreshFavoriteSet(refs?: FavoriteGifRef[]): { added: string[]; removed: string[]; } {
    const list = refs ?? getFavoriteGifRefsFromFrecency();
    const next = new Set<string>();
    const primaryByKey = new Map<string, string>();

    for (const ref of list) {
        const primary = (isRemoteHttpUrl(ref.src) ? ref.src : "")
            || (isRemoteHttpUrl(ref.url) ? ref.url : "");
        if (!primary) continue;
        for (const k of keysForFavorite(ref)) {
            next.add(k);
            if (!primaryByKey.has(k)) primaryByKey.set(k, primary);
        }
    }

    const added: string[] = [];
    const removed: string[] = [];
    if (favoritesSeeded) {
        const seenPrimary = new Set<string>();
        for (const key of next) {
            if (favoriteUrlSet.has(key)) continue;
            const primary = primaryByKey.get(key);
            if (!primary || seenPrimary.has(primary)) continue;
            seenPrimary.add(primary);
            added.push(primary);
        }
        for (const key of favoriteUrlSet) {
            if (!next.has(key)) removed.push(key);
        }
    }

    favoriteUrlSet = next;
    favoritesSeeded = true;
    getCache().setProtectedKeys(next);
    return { added, removed };
}

function enqueueFavoriteDiff(added: string[], removed: string[], refs: FavoriteGifRef[]) {
    for (const ref of newRefsForUrls(added, refs)) {
        const id = (isRemoteHttpUrl(ref.url) ? ref.url : "") || ref.src || "";
        if (id) pendingAddRefs.set(id, ref);
    }
    for (const key of removed) pendingRemoveKeys.add(key);
    if (pendingAddRefs.size || pendingRemoveKeys.size) void flushFavoriteDiff();
}

function syncFromFrecency() {
    hookFavoriteUpdates();
    const refs = getFavoriteGifRefsFromFrecency();
    if (!refs.length) return;
    const { added, removed } = refreshFavoriteSet(refs);
    enqueueFavoriteDiff(added, removed, refs);
}

function hookFavoriteUpdates() {
    try {
        const ac = UserSettingsActionCreators?.FrecencyUserSettingsActionCreators;
        if (!ac || (ac as any).__fgcHooked) return;
        const orig = ac.updateAsync;
        if (typeof orig !== "function") return;
        (ac as any).__fgcHooked = true;
        ac.updateAsync = function (this: any, key: string, ...rest: any[]) {
            const ret = orig.call(this, key, ...rest);
            if (key === "favoriteGifs") {
                const after = () => {
                    try { syncFromFrecency(); } catch { }
                };
                if (ret && typeof (ret as Promise<unknown>).then === "function") {
                    (ret as Promise<unknown>).then(after, after);
                } else {
                    queueMicrotask(after);
                }
                setTimeout(after, 0);
                setTimeout(after, 300);
            }
            return ret;
        };
    } catch {
    }
}

async function flushFavoriteDiff() {
    if (favoriteDiffFlush) return favoriteDiffFlush;
    favoriteDiffFlush = (async () => {
        try {
            while (pendingAddRefs.size || pendingRemoveKeys.size) {
                const adds = [...pendingAddRefs.values()];
                pendingAddRefs.clear();
                const removes = [...pendingRemoveKeys];
                pendingRemoveKeys.clear();
                if (adds.length) await cacheNewFavoriteRefs(adds);
                if (removes.length) await evictUnfavoritedKeys(removes);
            }
        } finally {
            favoriteDiffFlush = null;
        }
    })();
    return favoriteDiffFlush;
}

async function evictUnfavoritedKeys(keys: string[]) {
    if (!keys.length) return;
    try {
        const c = getCache();
        await c.init();
        const drop = new Set<string>();
        for (const k of keys) {
            if (!k) continue;
            drop.add(k);
            drop.add(cacheKeyForUrl(k));
            for (const alt of mediaLookupKeys(k)) drop.add(alt);
        }
        for (const key of c.keys()) {
            if (!drop.has(key)) continue;
            if (favoriteUrlSet.has(key)) continue;
            try { await c.delete(key); } catch { }
        }
        scanPickerMedia();
    } catch {
    }
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


function newRefsForUrls(urls: string[], refs: FavoriteGifRef[]): FavoriteGifRef[] {
    if (!urls.length) return [];
    const want = new Set<string>();
    for (const u of urls) {
        if (!u) continue;
        want.add(u);
        want.add(cacheKeyForUrl(u));
        for (const k of mediaLookupKeys(u)) want.add(k);
    }
    return refs.filter(ref =>
        [ref.src, ref.url].some(u => !!u && (want.has(u) || want.has(cacheKeyForUrl(u)))),
    );
}

async function cacheNewFavoriteRefs(refs: FavoriteGifRef[]) {
    if (!refs.length) return;
    try {
        const c = getCache();
        await c.init();
        for (const ref of refs) {
            const tried = new Set<string>();
            const urls = [pickCacheableUrl(ref), ref.src, ref.url];
            for (const cacheUrl of urls) {
                if (!cacheUrl || !shouldCacheFavoriteUrl(cacheUrl) || isAutoCacheDenied(cacheUrl)) continue;
                const key = cacheKeyForUrl(cacheUrl);
                if (tried.has(key)) continue;
                tried.add(key);
                try {
                    const res = await cacheOnUserAction(c, cacheUrl, fetch, autoCacheOpts());
                    if (res?.stored || c.has(key) || c.has(cacheUrl)) {
                        await c.ensureBlobUrl(key, { bumpUsage: false });
                        break;
                    }
                } catch {
                }
            }
        }
        for (const g of lastFavorites) applyCacheSrc(g, c);
        scanPickerMedia();
    } catch {
    }
}

function pickCacheableUrl(ref: { src?: string; url?: string; format?: number; }): string | null {
    const candidates = [ref.src, ref.url].filter((u): u is string => !!u && typeof u === "string");
    let format = ref.format;
    if (typeof format !== "number" && ref.src && isHeavyVideoUrl(ref.src)) format = GIF_FORMAT_VIDEO;
    if (format === GIF_FORMAT_VIDEO) {
        const videos = candidates.filter(u => shouldCacheFavoriteUrl(u) && isHeavyVideoUrl(u));
        if (videos.length) return videos[0]!;
    }
    if (format === GIF_FORMAT_IMAGE) {
        const images = candidates.filter(u => shouldCacheFavoriteUrl(u) && !isHeavyVideoUrl(u));
        if (images.length) return images[0]!;
    }
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
    if (emptyRetryCount >= 12) return;
    if (emptyRetryTimer) return;
    emptyRetryTimer = setTimeout(() => {
        emptyRetryTimer = null;
        emptyRetryCount += 1;
        requestFavoriteGifsLoad();
        safeForceUpdate(instance ?? lastPickerInstance);
    }, 150 + emptyRetryCount * 150);
}

function isPlayableMediaUrl(url: unknown): url is string {
    if (!isRemoteHttpUrl(url) || !isLikelyGifMediaUrl(url)) return false;
    try {
        const path = new URL(url).pathname.toLowerCase();
        if (path.includes("/view/") || path.endsWith(".html")) return false;
    } catch {
        return false;
    }
    return true;
}

function healStoreGif(gif: any, c: FavoriteGifCache | null = null) {
    if (!gif || typeof gif !== "object") return;
    healFavoriteUrls(gif);
    stashOriginalUrls(gif);
    const send = remoteSendUrl(gif);
    if (send && isRemoteHttpUrl(send)) gif.url = send;
    if (isBlobOrDataUrl(gif.src)) {
        if (c?.isLiveBlobUrl(gif.src)) return;
        const cdn = [gif.__fgcOriginalSrc, remoteDisplaySrc(gif), send].find(isPlayableMediaUrl);
        if (cdn) gif.src = cdn;
    }
}

function remoteCandidates(gif: any): string[] {
    const out: string[] = [];
    const push = (u: unknown) => {
        if (typeof u === "string" && isRemoteHttpUrl(u) && !out.includes(u)) out.push(u);
    };
    push(gif?.__fgcOriginalSrc);
    push(gif?.__fgcOriginalUrl);
    if (!isBlobOrDataUrl(gif?.src)) push(gif?.src);
    if (!isBlobOrDataUrl(gif?.url)) push(gif?.url);
    push(remoteDisplaySrc(gif));
    push(remoteSendUrl(gif));
    return out;
}

function applyCacheSrc(gif: any, c: FavoriteGifCache | null): boolean {
    healStoreGif(gif, c);
    if (!c?.isInitialized() || !settings.store.rewriteFavoriteSrc) return false;
    if (isBlobOrDataUrl(gif.src) && c.isLiveBlobUrl(gif.src)) return false;

    let format = typeof gif.format === "number"
        ? gif.format
        : (typeof gif.__fgcOriginalFormat === "number" ? gif.__fgcOriginalFormat : undefined);
    if (typeof format !== "number") {
        const hint = gif.__fgcOriginalSrc || remoteDisplaySrc(gif);
        format = hint && isHeavyVideoUrl(hint) ? GIF_FORMAT_VIDEO : GIF_FORMAT_IMAGE;
    }

    for (const remote of remoteCandidates(gif)) {
        const hit = c.resolveDisplayHitSync(remote, { bumpUsage: false });
        if (!hit?.blobUrl?.startsWith("blob:")) continue;
        if (!c.isLiveBlobUrl(hit.blobUrl)) continue;
        if (!mimeMatchesFormat(format, hit.mimeType)) continue;
        if (gif.src === hit.blobUrl) return false;
        gif.src = hit.blobUrl;
        return true;
    }
    return false;
}

function refsFromFavorites(favorites: any[]): FavoriteGifRef[] {
    const refs: FavoriteGifRef[] = [];
    for (const g of favorites) {
        const url = remoteSendUrl(g) || (isRemoteHttpUrl(g?.url) ? g.url : "") || "";
        const src = remoteDisplaySrc(g) || (isRemoteHttpUrl(g?.src) ? g.src : "") || "";
        if (!url && !src) continue;
        refs.push({
            url: url || src,
            src: src || url,
            width: g?.width,
            height: g?.height,
            format: typeof g?.format === "number" ? g.format : undefined,
            order: g?.order,
        });
    }
    return refs;
}

function pinKeysForRefs(refs: FavoriteGifRef[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (k: string) => {
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(k);
    };
    for (const ref of refs) {
        for (const u of [ref.src, ref.url, pickCacheableUrl(ref)]) {
            if (!u) continue;
            add(cacheKeyForUrl(u));
            for (const k of mediaLookupKeys(u)) add(k);
        }
    }
    return out;
}

function restoreMediaElement(el: HTMLImageElement | HTMLVideoElement) {
    const orig = el.dataset.fgcSrc;
    if (!orig || orig === el.src) return;
    try {
        el.src = orig;
        if (el.tagName === "VIDEO") (el as HTMLVideoElement).load();
    } catch {
    }
}

function onBlobRevoking(blobUrl: string) {
    if (typeof document === "undefined") return;
    try {
        for (const node of document.querySelectorAll("img,video")) {
            const el = node as HTMLImageElement | HTMLVideoElement;
            if (el.src === blobUrl) restoreMediaElement(el);
        }
    } catch {
    }
}

function onPickerMediaError(ev: Event) {
    const el = ev.target as any;
    if (!el || (el.tagName !== "IMG" && el.tagName !== "VIDEO")) return;
    const src = el.currentSrc || el.src;
    if (!src || !String(src).startsWith("blob:")) return;
    restoreMediaElement(el);
}

function maybeSwapMedia(el: HTMLImageElement | HTMLVideoElement) {
    try {
        if (!settings.store.rewriteFavoriteSrc) return;
        const src = el.getAttribute("src") || el.src || "";
        if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
        if (!isRemoteHttpUrl(src) || !isLikelyGifMediaUrl(src)) return;
        if (favoritesSeeded && favoriteUrlSet.size > 0 && !isTrackedFavorite(src)) return;

        const c = cache;
        if (!c?.isInitialized()) return;
        const hit = c.resolveDisplayHitSync(src, { bumpUsage: false });
        if (!hit?.blobUrl?.startsWith("blob:") || !c.isLiveBlobUrl(hit.blobUrl)) return;

        const videoEl = el.tagName === "VIDEO";
        if (videoEl && !isVideoMime(hit.mimeType)) return;
        if (!videoEl && isVideoMime(hit.mimeType)) return;

        if (el.dataset.fgcSrc === src && el.src === hit.blobUrl) return;
        el.dataset.fgcSrc = src;
        el.src = hit.blobUrl;
    } catch {
    }
}

function scanPickerMedia() {
    if (typeof document === "undefined") return;
    try {
        for (const node of document.querySelectorAll("img,video")) {
            maybeSwapMedia(node as HTMLImageElement | HTMLVideoElement);
        }
    } catch {
    }
}

function ensureMediaObserver() {
    if (mediaObserver || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    mediaObserver = new MutationObserver(muts => {
        for (const m of muts) {
            if (m.type === "attributes" && m.target) {
                const t = m.target as any;
                if (t.tagName === "IMG" || t.tagName === "VIDEO") maybeSwapMedia(t);
            }
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                const el = n as Element;
                if (el.tagName === "IMG" || el.tagName === "VIDEO") {
                    maybeSwapMedia(el as any);
                }
                el.querySelectorAll?.("img,video").forEach(child => maybeSwapMedia(child as any));
            }
        }
    });
    mediaObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
    });
}

function bindMediaErrorHealer() {
    if (mediaErrorBound || typeof document === "undefined") return;
    document.addEventListener("error", onPickerMediaError, true);
    mediaErrorBound = true;
}

function unbindMediaErrorHealer() {
    if (!mediaErrorBound || typeof document === "undefined") return;
    document.removeEventListener("error", onPickerMediaError, true);
    mediaErrorBound = false;
    if (mediaObserver) {
        mediaObserver.disconnect();
        mediaObserver = null;
    }
}

function queueWrapWork(
    favorites: any[],
    refs: FavoriteGifRef[],
    visibleKeys: string[],
    newlyFavorited: string[],
) {
    wrapWorkPending = { favorites, refs, visibleKeys, newlyFavorited };
    if (wrapWork) return;
    wrapWork = (async () => {
        try {
            while (wrapWorkPending) {
                const job = wrapWorkPending;
                wrapWorkPending = null;
                await runWrapWork(job);
            }
        } finally {
            wrapWork = null;
        }
    })();
}

async function runWrapWork(job: {
    favorites: any[];
    refs: FavoriteGifRef[];
    visibleKeys: string[];
    newlyFavorited: string[];
}) {
    const c = getCache();
    await c.init();
    c.setRevokeListener(onBlobRevoking);
    c.setDisplayPinnedKeys(job.visibleKeys);

    for (const key of job.visibleKeys) {
        if (c.has(key) && !c.hasResidentData(key)) await c.hydrate(key);
        if (c.hasResidentData(key)) c.ensureBlobUrlSync(key, { bumpUsage: false });
    }
    for (const g of job.favorites) applyCacheSrc(g, c);
    scanPickerMedia();

    await cacheNewFavoriteRefs(newRefsForUrls(job.newlyFavorited, job.refs));

    let downloads = 0;
    for (const ref of job.refs) {
        if (downloads >= 10) break;
        for (const u of [ref.src, ref.url]) {
            if (!u || isAutoCacheDenied(u) || !shouldCacheFavoriteUrl(u)) continue;
            const key = cacheKeyForUrl(u);
            if (!c.has(key) && !c.has(u) && downloads < 10) {
                await ensureCached(c, u, { allowEvict: false, ...autoCacheOpts() });
                downloads += 1;
            }
            if (c.has(key) || c.has(u)) {
                await c.ensureBlobUrl(key, { bumpUsage: false });
            }
        }
    }
    for (const g of job.favorites) applyCacheSrc(g, c);
    scanPickerMedia();
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

    const tried = new Set<string>();
    const queue = [url];
    for (const g of lastFavorites) {
        const remotes = remoteCandidates(g);
        if (remotes.some(r => r === url || cacheKeyForUrl(r) === cacheKeyForUrl(url))) {
            for (const r of remotes) queue.push(r);
        }
    }

    for (const u of queue) {
        if (!u || tried.has(u)) continue;
        tried.add(u);
        try {
            const res = await cacheOnUserAction(c, u, fetch, {
                force: true,
                maxBytes: Number.MAX_SAFE_INTEGER,
            });
            if (res?.stored || c.has(cacheKeyForUrl(u)) || c.has(u)) {
                c.ensureBlobUrlSync(cacheKeyForUrl(u), { bumpUsage: true });
                toast("GIF Cached", Toasts.Type.SUCCESS);
                for (const g of lastFavorites) applyCacheSrc(g, c);
                scanPickerMedia();
                return;
            }
        } catch {
        }
    }
    toast("Could not cache GIF", Toasts.Type.FAILURE);
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


async function warmCachedFavoriteBlobs() {
    try {
        const c = getCache();
        await c.init();
        let refs = getFavoriteGifRefsFromFrecency();
        if (!refs.length) {
            requestFavoriteGifsLoad();
            refs = getFavoriteGifRefsFromFrecency();
        }
        if (refs.length) refreshFavoriteSet(refs);
        const keys = pinKeysForRefs(refs);
        c.setDisplayPinnedKeys(keys);
        for (const key of keys) {
            if (!c.has(key)) continue;
            try {
                await c.ensureBlobUrl(key, { bumpUsage: false });
            } catch {
            }
        }
        for (const g of lastFavorites) applyCacheSrc(g, c);
        scanPickerMedia();
    } catch {
    }
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
            for (const url of queue) {
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
            ensureMediaObserver();
            bindMediaErrorHealer();

            if (favorites.length === 0) {
                requestFavoriteGifsLoad();
                refreshFavoriteSet();
                scheduleEmptyRetry(instance);
                return favorites;
            }
            emptyRetryCount = 0;
            lastFavorites = favorites;

            const c = getCache();
            const ready = c.isInitialized() ? c : null;
            for (const g of favorites) applyCacheSrc(g, ready);

            const refs = refsFromFavorites(favorites);
            const { added } = refreshFavoriteSet(refs);
            enqueueFavoriteDiff(added, [], refs);
            const visibleKeys = pinKeysForRefs(refs);
            c.setDisplayPinnedKeys(visibleKeys);
            queueWrapWork(favorites, refs, visibleKeys, added);
            scanPickerMedia();
            return favorites;
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

            requestFavoriteGifsLoad();
            refreshFavoriteSet();
            hookFavoriteUpdates();
            bindMediaErrorHealer();
            ensureMediaObserver();
            void warmCachedFavoriteBlobs();
            if (favoritePoll) clearInterval(favoritePoll);
            favoritePoll = setInterval(() => {
                try { syncFromFrecency(); } catch { }
            }, 2000);

            const onSettings = () => {
                syncFromFrecency();
                void warmCachedFavoriteBlobs();
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
                        scanPickerMedia();
                        setTimeout(() => void prefetchFavorites().then(() => scanPickerMedia()), 8000);
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
        if (favoritePoll) {
            clearInterval(favoritePoll);
            favoritePoll = null;
        }
        pendingAddRefs.clear();
        pendingRemoveKeys.clear();
        unbindMediaErrorHealer();
        wrapWorkPending = null;
        cache = null;
        setActiveCache(null);
        favoriteUrlSet = new Set();
        favoritesSeeded = false;
        lastPickerInstance = null;
        lastFavorites = [];
        emptyRetryCount = 0;
    },
});

export {
    createFavoriteGifCache,
    DEFAULT_MAX_BYTES,
    FavoriteGifCache,
} from "./gifCache";
export { GifCacheCore } from "./cacheCore";
