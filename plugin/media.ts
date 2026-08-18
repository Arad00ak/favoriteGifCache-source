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
import { isDirectMediaUrl, mediaLookupKeys } from "./hosts";
import { getPluginNative } from "./nativeApi";
import { sniffMime } from "./sniffMime";

const inflight = new Map<string, Promise<{ data: Uint8Array; mime: string; } | null>>();
const failedAutoDownloads = new WeakMap<FavoriteGifCache, Map<string, string>>();
const fullCacheStates = new WeakMap<FavoriteGifCache, string>();


export const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

function cacheState(cache: FavoriteGifCache) {
    return `${cache.bytes()}:${cache.getMaxBytes()}:${cache.isSmartEvictionEnabled()}`;
}

function rememberAutoFailure(cache: FavoriteGifCache, key: string, state = "session") {
    let failures = failedAutoDownloads.get(cache);
    if (!failures) failedAutoDownloads.set(cache, failures = new Map());
    failures.set(key, state);
}

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
    fetchImpl: typeof fetch,
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
        const res = await fetchImpl(url, {
            credentials: "omit",
            cache: "no-store",
            mode: "cors",
            redirect: "error",
            signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
                ? AbortSignal.timeout(30_000)
                : undefined,
        } as RequestInit);
        if (!res.ok) {
            try { await res.body?.cancel(); } catch { }
            return null;
        }
        const lenHeader = res.headers.get("content-length");
        if (lenHeader) {
            const len = Number(lenHeader);
            if (Number.isFinite(len) && len > maxBytes) {
                try { await res.body?.cancel(); } catch { }
                return null;
            }
        }

        const reader = res.body?.getReader();
        if (!reader) return null;

        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                try { await reader.cancel(); } catch { }
                return null;
            }
            chunks.push(value);
        }
        if (!total) return null;
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { data, mime: guessMime(url, res.headers.get("content-type"), data) };
    } catch {
        return null;
    }
}


async function downloadFavoriteMedia(
    url: string,
    fetchImpl: typeof fetch = fetch,
    maxBytes = MAX_ENTRY_BYTES,
): Promise<{ data: Uint8Array; mime: string; } | null> {
    return downloadOneUrl(url, fetchImpl, maxBytes);
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
    const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes! > 0
        ? opts.maxBytes!
        : MAX_ENTRY_BYTES;
    const force = opts.force === true;

    if (!force && opts.isDenied?.(url)) return null;

    const key = cacheKeyForUrl(url);
    const hit = await getCachedBytes(cache, url);
    if (hit) {
        return { ...hit, fromCache: true as const, stored: true as const };
    }

    const state = cacheState(cache);
    const canEvict = allowEvict && cache.isSmartEvictionEnabled();
    const failedState = failedAutoDownloads.get(cache)?.get(key);
    if (!force && (
        failedState === "session"
        || failedState === state
        || fullCacheStates.get(cache) === state
    )) {
        return null;
    }

    const availableBytes = canEvict
        ? cache.getMaxBytes()
        : cache.getMaxBytes() - cache.bytes();
    const downloadMaxBytes = Number.isFinite(availableBytes)
        ? Math.min(maxBytes, availableBytes)
        : maxBytes;
    if (downloadMaxBytes <= 0) {
        fullCacheStates.set(cache, state);
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
        if (!force) {
            rememberAutoFailure(
                cache,
                key,
                !canEvict && downloadMaxBytes < maxBytes ? cacheState(cache) : "session",
            );
            if (!canEvict && downloadMaxBytes < Math.min(maxBytes, MAX_ENTRY_BYTES)) {
                fullCacheStates.set(cache, cacheState(cache));
            }
        }
        return null;
    }


    if (downloaded.data.byteLength > maxBytes) {
        if (!force) rememberAutoFailure(cache, key);
        return null;
    }


    const put = await cache.put(key, downloaded.data, downloaded.mime, { allowEvict });
    if (!put.stored && !force) {
        rememberAutoFailure(cache, key, put.skippedFull ? cacheState(cache) : "session");
    }
    if (put.skippedFull) fullCacheStates.set(cache, cacheState(cache));
    if (put.stored) {
        failedAutoDownloads.get(cache)?.delete(key);
        fullCacheStates.delete(cache);
    }

    const entry = cache.peekSync(key);

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
