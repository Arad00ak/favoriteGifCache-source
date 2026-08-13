/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isGifProviderHost, mediaLookupKeys } from "./hosts";

export interface FavoriteGifRef {
    url: string;
    src: string;
    width?: number;
    height?: number;
    format?: number;
    
    order?: number;
}

type WebpackFind = (filter: (m: any) => boolean) => any;

function getWebpackFind(): WebpackFind | null {
    try {
        const w = (globalThis as any).Vencord?.Webpack?.find
            ?? (globalThis as any).Equicord?.Webpack?.find;
        if (typeof w === "function") return w;
    } catch {

    }
    return null;
}


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

export function favoriteRefsToPickerItems(refs: FavoriteGifRef[]): any[] {
    return refs.map(ref => ({
        url: ref.url || ref.src,
        src: ref.src || ref.url,
        width: ref.width,
        height: ref.height,
        format: ref.format,
        order: ref.order,
    })).filter(g => g.url || g.src);
}

export async function waitForFavoriteGifRefs(
    attempts = 12,
    delayMs = 350,
): Promise<FavoriteGifRef[]> {
    for (let i = 0; i < attempts; i++) {
        const refs = getFavoriteGifRefsFromFrecency();
        if (refs.length) return refs;
        await new Promise(r => setTimeout(r, delayMs));
    }
    return getFavoriteGifRefsFromFrecency();
}


export function sortFavoritesNewestFirst(refs: FavoriteGifRef[]): FavoriteGifRef[] {
    return [...refs].sort((a, b) => {
        const ao = typeof a.order === "number" ? a.order : Number.NEGATIVE_INFINITY;
        const bo = typeof b.order === "number" ? b.order : Number.NEGATIVE_INFINITY;
        if (bo !== ao) return bo - ao;

        const au = a.src || a.url || "";
        const bu = b.src || b.url || "";
        return bu < au ? -1 : bu > au ? 1 : 0;
    });
}


export const PREFETCH_WARM_NEWEST = 16;


export function prefetchTargetBytes(maxBytes: number): number {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return 0;
    return Math.max(1, Math.floor(maxBytes / 3));
}

export function cacheKeyForUrl(url: string) {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (isGifProviderHost(u.hostname)) {
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
        for (const k of mediaLookupKeys(ref.url)) keys.add(k);
    }
    if (ref.src) {
        for (const k of mediaLookupKeys(ref.src)) keys.add(k);
    }
    return [...keys];
}

export function isLikelyGifMediaUrl(url: string) {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("blob:") || url.startsWith("data:")) return false;
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return false;
        return isGifProviderHost(u.hostname);
    } catch {
        return false;
    }
}


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


export function isCacheableFavoriteUrl(url: string) {
    return isLikelyGifMediaUrl(url);
}
