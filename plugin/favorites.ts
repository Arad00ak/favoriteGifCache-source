export interface FavoriteGifRef {
    url: string;
    src: string;
    width?: number;
    height?: number;
    format?: number;
    /** Discord favorite order — higher usually means newer / more recent. */
    order?: number;
}

type WebpackFind = (filter: (m: any) => boolean) => any;

function getWebpackFind(): WebpackFind | null {
    try {
        const w = (globalThis as any).Vencord?.Webpack?.find
            ?? (globalThis as any).Equicord?.Webpack?.find;
        if (typeof w === "function") return w;
    } catch {
        // ignore
    }
    return null;
}

/** Pull favorite gif urls from Discord's frecency settings blob. */
export function getFavoriteGifRefsFromFrecency(): FavoriteGifRef[] {
    try {
        const find = getWebpackFind();
        if (!find) return [];

        const FrecencyUserSettings = find(
            (m: any) => typeof m?.ProtoClass?.typeName === "string"
                && m.ProtoClass.typeName.endsWith(".FrecencyUserSettings"),
        );
        if (!FrecencyUserSettings?.getCurrentValue) return [];

        const value = FrecencyUserSettings.getCurrentValue();
        const gifs = value?.favoriteGifs?.gifs;
        if (!gifs || typeof gifs !== "object") return [];

        const out: FavoriteGifRef[] = [];
        for (const [key, meta] of Object.entries(gifs as Record<string, any>)) {
            const url = typeof meta?.url === "string" ? meta.url : key;
            const src = typeof meta?.src === "string" ? meta.src : url;
            if (!url && !src) continue;
            out.push({
                url: url || src,
                src: src || url,
                width: meta?.width,
                height: meta?.height,
                format: meta?.format,
                order: meta?.order,
            });
        }
        return sortFavoritesNewestFirst(out);
    } catch {
        return [];
    }
}

/** Newest first (higher `order` first). Missing order sorts last. */
export function sortFavoritesNewestFirst(refs: FavoriteGifRef[]): FavoriteGifRef[] {
    return [...refs].sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : Number.NEGATIVE_INFINITY;
        const bo = typeof b.order === "number" ? b.order : Number.NEGATIVE_INFINITY;
        if (bo !== ao) return bo - ao;
        // stable-ish fallback: url string so sort is deterministic
        const au = a.src || a.url || "";
        const bu = b.src || b.url || "";
        return bu < au ? -1 : bu > au ? 1 : 0;
    });
}

/** How many newest favorites to mint blob URLs for after prefetch (not the whole 1/3 fill). */
export const PREFETCH_WARM_NEWEST = 16;

/**
 * Startup prefetch byte budget: 1/3 of max cache size (e.g. 500 MB → ~167 MB).
 * Bytes go to disk; soft RAM budget keeps the renderer heap safe.
 */
export function prefetchTargetBytes(maxBytes: number): number {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
    return Math.max(1, Math.floor(maxBytes / 3));
}

export function cacheKeyForUrl(url: string) {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (
            u.hostname.includes("tenor.com")
            || u.hostname.includes("giphy.com")
            || u.hostname.includes("discordapp")
            || u.hostname.includes("discord.com")
        ) {
            return `${u.origin}${u.pathname}`;
        }
        return u.href;
    } catch {
        return url;
    }
}

export function keysForFavorite(ref: FavoriteGifRef) {
    const keys = new Set<string>();
    if (ref.url) {
        keys.add(cacheKeyForUrl(ref.url));
        keys.add(ref.url);
    }
    if (ref.src) {
        keys.add(cacheKeyForUrl(ref.src));
        keys.add(ref.src);
    }
    return [...keys];
}

export function isLikelyGifMediaUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const u = new URL(url);
        const host = u.hostname;
        if (
            host.includes("tenor.com")
            || host.includes("giphy.com")
            || host.includes("media.discordapp")
            || host.includes("cdn.discordapp")
            || host.includes("discordapp.net")
        ) {
            return true;
        }
        return /\.(gif|mp4|webm|webp|png|jpe?g)(\?|$)/i.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * URL looks like an explicit video file.
 * Small Tenor mp4 "gifs" may still be cached if under the per-file size cap in media.ts.
 */
export function isHeavyVideoUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const path = new URL(url).pathname.toLowerCase();
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(path);
    } catch {
        return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url);
    }
}

export function isHeavyVideoMime(mime: string | null | undefined) {
    if (!mime) return false;
    const m = mime.toLowerCase().split(";")[0]!.trim();
    return m.startsWith("video/") || m === "application/mp4";
}

/** URL is a candidate for the favorite cache (size limits applied at download time). */
export function isCacheableFavoriteUrl(url: string) {
    return isLikelyGifMediaUrl(url);
}
