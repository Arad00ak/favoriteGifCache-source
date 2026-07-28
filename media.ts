import type { FavoriteGifCache } from "./gifCache";
import {
    cacheKeyForUrl,
    isCacheableFavoriteUrl,
    isHeavyVideoMime,
    isHeavyVideoUrl,
    isLikelyGifMediaUrl,
} from "./favorites";
import { getPluginNative } from "./nativeApi";

const inflight = new Map<string, Promise<{ data: Uint8Array; mime: string; } | null>>();

/** Skip single files bigger than this (huge "gif" mp4s). */
export const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

function guessMime(url: string, contentType: string | null) {
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

/**
 * Pull bytes for a favorite media URL.
 * Prefers native (main process) so Discord renderer CORS cannot block Tenor/CDN.
 */
export async function downloadFavoriteMedia(
    url: string,
    fetchImpl: typeof fetch = fetch,
    maxBytes = MAX_ENTRY_BYTES,
): Promise<{ data: Uint8Array; mime: string; } | null> {
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
                        mime: guessMime(url, res.type || null),
                    };
                }
            }
        } catch {
            // fall through to renderer fetch
        }
    }

    try {
        const res = await fetchImpl(url, {
            // omit cors mode — let Electron use default; strict cors often fails here
            credentials: "include",
            cache: "force-cache",
        } as RequestInit);
        if (!res.ok) return null;
        const mime = guessMime(url, res.headers.get("content-type"));
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > maxBytes) return null;
        return { data: buf, mime };
    } catch {
        return null;
    }
}

export async function getCachedBytes(cache: FavoriteGifCache, url: string) {
    await cache.init();
    const key = cacheKeyForUrl(url);

    // peek first so miss path does not thrash metadata writes
    let entry = cache.peekSync(key);
    if (!entry && key !== url) entry = cache.peekSync(url);

    if (entry) {
        // record usage on real hit
        cache.touchSync(entry.key);
        if (isHeavyVideoMime(entry.mimeType) && entry.size > MAX_ENTRY_BYTES) {
            return null;
        }
        return { data: entry.data.slice(), mimeType: entry.mimeType, key: entry.key };
    }

    return null;
}

export type EnsureCachedOptions = {
    fetchImpl?: typeof fetch;
    allowEvict?: boolean;
    maxBytes?: number;
};

/**
 * Hit → local bytes.
 * Miss → download once (native preferred), store if under size/cap rules.
 */
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

    const key = cacheKeyForUrl(url);
    const hit = await getCachedBytes(cache, url);
    if (hit) {
        return { ...hit, fromCache: true as const, stored: true as const };
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                return await downloadFavoriteMedia(url, fetchImpl, maxBytes);
            } catch {
                return null;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, pending);
    }

    const downloaded = await pending;
    if (!downloaded) return null;

    // Skip only truly huge videos; normal Tenor "gif" mp4s under the cap are OK
    if (downloaded.data.byteLength > maxBytes) {
        return null;
    }

    await cache.put(key, downloaded.data, downloaded.mime, { allowEvict });

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
    };
}

export async function cacheOnUserAction(
    cache: FavoriteGifCache,
    url: string,
    fetchImpl: typeof fetch = fetch,
) {
    return ensureCached(cache, url, { fetchImpl, allowEvict: true });
}

export async function resolveDisplayUrl(
    cache: FavoriteGifCache,
    originalUrl: string,
    opts: { awaitMiss?: boolean; fetchImpl?: typeof fetch; allowEvict?: boolean } = {},
) {
    if (!originalUrl || originalUrl.startsWith("blob:") || originalUrl.startsWith("data:")) {
        return originalUrl;
    }

    const hot = cache.getCachedBlobUrl(cacheKeyForUrl(originalUrl))
        ?? cache.getCachedBlobUrl(originalUrl);
    if (hot) {
        cache.touchSync(cacheKeyForUrl(originalUrl));
        return hot;
    }

    const blob = await cache.getBlobUrl(cacheKeyForUrl(originalUrl));
    if (blob) return blob;
    if (originalUrl !== cacheKeyForUrl(originalUrl)) {
        const blob2 = await cache.getBlobUrl(originalUrl);
        if (blob2) return blob2;
    }

    const run = async () => {
        const ensured = await ensureCached(cache, originalUrl, {
            fetchImpl: opts.fetchImpl ?? fetch,
            allowEvict: opts.allowEvict,
        });
        if (!ensured) return originalUrl;
        if (ensured.stored) {
            const b = await cache.getBlobUrl(ensured.key);
            return b || originalUrl;
        }
        if (typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
            try {
                return URL.createObjectURL(new Blob([ensured.data], { type: ensured.mimeType }));
            } catch {
                return originalUrl;
            }
        }
        return originalUrl;
    };

    if (opts.awaitMiss) return run();
    void run();
    return originalUrl;
}

export function installFetchInterceptor(
    cache: FavoriteGifCache,
    isFavoriteUrl: (url: string) => boolean,
) {
    if (typeof globalThis.fetch !== "function") return () => {};

    const original = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
            const url = typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.href
                    : (input as Request).url;

            if (url && isFavoriteUrl(url)) {
                const hit = await getCachedBytes(cache, url);
                if (hit) {
                    return new Response(hit.data, {
                        status: 200,
                        statusText: "OK",
                        headers: {
                            "Content-Type": hit.mimeType,
                            "X-FavoriteGifCache": "HIT",
                        },
                    });
                }
            }
        } catch {
            // fall through
        }
        return original(input as any, init);
    };

    return () => {
        globalThis.fetch = original;
    };
}
