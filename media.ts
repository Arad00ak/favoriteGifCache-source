import type { FavoriteGifCache } from "./gifCache";
import {
    cacheKeyForUrl,
    isCacheableFavoriteUrl,
    isHeavyVideoMime,
    isHeavyVideoUrl,
    isLikelyGifMediaUrl,
} from "./favorites";

const inflight = new Map<string, Promise<Uint8Array | null>>();

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

export async function getCachedBytes(cache: FavoriteGifCache, url: string) {
    const key = cacheKeyForUrl(url);
    const entry = await cache.get(key);
    if (entry) return { data: entry.data, mimeType: entry.mimeType, key };

    if (key !== url) {
        const entry2 = await cache.get(url);
        if (entry2) return { data: entry2.data, mimeType: entry2.mimeType, key: url };
    }
    return null;
}

export type EnsureCachedOptions = {
    fetchImpl?: typeof fetch;
    /**
     * If the cache is full, still try to store by evicting.
     * Default false: when full we leave existing entries alone and skip the write.
     */
    allowEvict?: boolean;
};

/**
 * Hit → local bytes.
 * Miss → download once; store only if there is room (or allowEvict).
 * When full without eviction we still return the downloaded bytes for this paint,
 * but we do not kick anything out of the cache.
 */
export async function ensureCached(
    cache: FavoriteGifCache,
    url: string,
    fetchImplOrOpts: typeof fetch | EnsureCachedOptions = fetch,
) {
    // Never pull mp4/webm into the cache — too fat for a GIF album
    if (!url || !isCacheableFavoriteUrl(url) || isHeavyVideoUrl(url)) return null;

    const opts: EnsureCachedOptions = typeof fetchImplOrOpts === "function"
        ? { fetchImpl: fetchImplOrOpts }
        : fetchImplOrOpts;
    const fetchImpl = opts.fetchImpl ?? fetch;
    const allowEvict = opts.allowEvict === true;

    const key = cacheKeyForUrl(url);
    const hit = await getCachedBytes(cache, url);
    if (hit) {
        // legacy bad entry (video stored before this rule) — don't keep serving as "good"
        if (isHeavyVideoMime(hit.mimeType)) return null;
        return { ...hit, fromCache: true as const, stored: true as const };
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                const res = await fetchImpl(url, { credentials: "omit", mode: "cors" as RequestMode });
                if (!res.ok) return null;
                const mime = guessMime(url, res.headers.get("content-type"));
                if (isHeavyVideoMime(mime) || isHeavyVideoUrl(url)) {
                    // don't even buffer the body into our cache path
                    return null;
                }
                const buf = new Uint8Array(await res.arrayBuffer());
                if (!buf.byteLength) return null;
                await cache.put(key, buf, mime, { allowEvict });
                return buf;
            } catch {
                return null;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, pending);
    }

    const data = await pending;
    if (!data) return null;

    // Another call may have fetched with allowEvict:false while full.
    // If we need a durable slot now, force a put with eviction.
    let entry = await cache.peek(key);
    if (!entry && allowEvict) {
        const mime = guessMime(url, null);
        if (isHeavyVideoMime(mime)) return null;
        await cache.put(key, data, mime, { allowEvict: true });
        entry = await cache.peek(key);
    }

    return {
        data,
        mimeType: entry?.mimeType || guessMime(url, null),
        key,
        fromCache: false as const,
        stored: !!entry,
    };
}

/**
 * Cache a favorite for a deliberate user action (new favorite or send).
 * May evict least-used when full. Scroll/prefetch should keep using allowEvict:false.
 */
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
        void cache.get(cacheKeyForUrl(originalUrl));
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
        // downloaded but not stored (cache full) — one-shot blob, not kept
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
            // fall through to network
        }
        return original(input as any, init);
    };

    return () => {
        globalThis.fetch = original;
    };
}
