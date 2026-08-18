/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FavoriteGifCache } from "./gifCache";
import {
    cacheKeyForUrl,
    isLikelyGifMediaUrl,
} from "./favorites";
import { isDirectMediaUrl, mediaDownloadCandidates, mediaLookupKeys } from "./hosts";
import { getPluginNative } from "./nativeApi";
import { sniffMime } from "./sniffMime";

const inflight = new Map<string, Promise<{ data: Uint8Array; mime: string; } | null>>();
const failedAutoDownloads = new WeakMap<FavoriteGifCache, { state: string; keys: Set<string>; }>();
const fullCacheStates = new WeakMap<FavoriteGifCache, string>();


export const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

function guessMime(url: string, contentType: string | null, data?: Uint8Array) {

    if (data && data.byteLength >= 4) {
        const sniffed = sniffMime(data, "");
        if (sniffed) return sniffed;
    }
    if (contentType && !contentType.includes("octet-stream")) {
        return contentType.split(";")[0]!.trim();
    }
    const path = url.split("?")[0]!.toLowerCase();
    if (path.endsWith(".mp4")) return "video/mp4";
    if (path.endsWith(".webm")) return "video/webm";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    return "image/gif";
}


async function downloadOneUrl(
    url: string,
    _fetchImpl: typeof fetch,
    maxBytes: number,
): Promise<{ data: Uint8Array; mime: string; } | null> {
    if (!isDirectMediaUrl(url)) return null;

    const native = getPluginNative();
    if (native && typeof (native as any).fetchMedia === "function") {
        try {
            const res = await (native as any).fetchMedia(url, maxBytes);
            if (res?.data) {
                const data = res.data instanceof ArrayBuffer
                    ? new Uint8Array(res.data)
                    : new Uint8Array(res.data);
                if (data.byteLength && data.byteLength <= maxBytes) {
                    return {
                        data,
                        mime: guessMime(url, res.type || null, data),
                    };
                }
            }
        } catch {
        }
        return null;
    }

    try {
        const res = await _fetchImpl(url, {
            credentials: "omit",
            cache: "no-store",
            mode: "cors",
            redirect: "error",
        } as RequestInit);
        if (!res.ok) return null;
        const lenHeader = res.headers.get("content-length");
        if (lenHeader) {
            const len = Number(lenHeader);
            if (Number.isFinite(len) && len > maxBytes) return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > maxBytes) return null;
        const mime = guessMime(url, res.headers.get("content-type"), buf);
        return { data: buf, mime };
    } catch {
        return null;
    }
}


async function downloadFavoriteMedia(
    url: string,
    fetchImpl: typeof fetch = fetch,
    maxBytes = MAX_ENTRY_BYTES,
): Promise<{ data: Uint8Array; mime: string; fromUrl?: string; } | null> {
    const candidates = mediaDownloadCandidates(url);
    for (const candidate of candidates) {
        const hit = await downloadOneUrl(candidate, fetchImpl, maxBytes);
        if (hit) return { ...hit, fromUrl: candidate };
    }
    return null;
}

async function getCachedBytes(cache: FavoriteGifCache, url: string) {
    await cache.init();


    for (const key of mediaLookupKeys(url)) {
        if (!cache.has(key)) continue;
        if (!cache.hasResidentData(key)) {
            await cache.hydrate(key);
        }
        const entry = cache.peekSync(key);
        if (entry && entry.data.byteLength > 0) {
            cache.touchSync(entry.key);
            return { data: entry.data.slice(), mimeType: entry.mimeType, key: entry.key };
        }
    }

    return null;
}

export type EnsureCachedOptions = {
    fetchImpl?: typeof fetch;
    allowEvict?: boolean;
    maxBytes?: number;
    
    force?: boolean;
    
    isDenied?: (url: string) => boolean;
};


export async function ensureCached(
    cache: FavoriteGifCache,
    url: string,
    fetchImplOrOpts: typeof fetch | EnsureCachedOptions = fetch,
) {
    if (!url || !isLikelyGifMediaUrl(url)) return null;

    const opts: EnsureCachedOptions = typeof fetchImplOrOpts === "function"
        ? { fetchImpl: fetchImplOrOpts }
        : fetchImplOrOpts;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const allowEvict = opts.allowEvict === true;
    const maxBytes = opts.maxBytes ?? MAX_ENTRY_BYTES;
    const force = opts.force === true;

    if (!force && opts.isDenied?.(url)) return null;

    const key = cacheKeyForUrl(url);
    const hit = await getCachedBytes(cache, url);
    if (hit) {
        return { ...hit, fromCache: true as const, stored: true as const };
    }

    const cacheState = `${cache.bytes()}:${cache.getMaxBytes()}`;
    const failed = failedAutoDownloads.get(cache);
    if (!allowEvict && (
        (failed?.state === cacheState && failed.keys.has(key))
        || fullCacheStates.get(cache) === cacheState
    )) {
        return null;
    }

    const remainingBytes = cache.getMaxBytes() - cache.bytes();
    const downloadMaxBytes = !allowEvict && Number.isFinite(remainingBytes)
        ? Math.min(maxBytes, remainingBytes)
        : maxBytes;
    if (downloadMaxBytes <= 0) {
        fullCacheStates.set(cache, cacheState);
        return null;
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                return await downloadFavoriteMedia(url, fetchImpl, downloadMaxBytes);
            } catch {
                return null;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, pending);
    }

    const downloaded = await pending;
    if (!downloaded) {
        if (!allowEvict) {
            if (failed?.state === cacheState) failed.keys.add(key);
            else failedAutoDownloads.set(cache, { state: cacheState, keys: new Set([key]) });
            if (downloadMaxBytes < Math.min(maxBytes, MAX_ENTRY_BYTES)) {
                fullCacheStates.set(cache, cacheState);
            }
        }
        return null;
    }


    if (downloaded.data.byteLength > maxBytes) {
        return null;
    }


    const put = await cache.put(key, downloaded.data, downloaded.mime, { allowEvict });
    if (!allowEvict && put.skippedFull) fullCacheStates.set(cache, cacheState);
    if (put.stored) {
        failedAutoDownloads.delete(cache);
        fullCacheStates.delete(cache);
    }


    const fromKey = downloaded.fromUrl ? cacheKeyForUrl(downloaded.fromUrl) : null;
    if (fromKey && fromKey !== key) {
        await cache.put(fromKey, downloaded.data, downloaded.mime, { allowEvict: false });
    }

    let entry = cache.peekSync(key);
    if (!entry && allowEvict) {
        await cache.put(key, downloaded.data, downloaded.mime, { allowEvict: true });
        entry = cache.peekSync(key);
    }

    return {
        data: downloaded.data,
        mimeType: entry?.mimeType || downloaded.mime,
        key,
        fromCache: false as const,
        stored: !!entry,
        skippedFull: put.skippedFull === true,
    };
}

export async function cacheOnUserAction(
    cache: FavoriteGifCache,
    url: string,
    fetchImpl: typeof fetch = fetch,
    opts: {
        force?: boolean;
        isDenied?: (url: string) => boolean;
        maxBytes?: number;
    } = {},
) {
    return ensureCached(cache, url, {
        fetchImpl,
        allowEvict: true,
        force: opts.force === true,
        isDenied: opts.isDenied,
        maxBytes: opts.maxBytes,
    });
}
