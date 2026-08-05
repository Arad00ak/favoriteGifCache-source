/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * GIF CDN host helpers.
 * Tenor (media CDN) is sunsetting third-party use; Discord and others move to Klipy.
 * We treat both as first-class and rewrite failed Tenor downloads to Klipy host candidates.
 */

/** Hosts / suffixes that count as Tenor media. */
export const TENOR_HOST_MARKERS = [
    "media.tenor.com",
    "c.tenor.com",
    "tenor.com",
] as const;

/**
 * Klipy media / CDN host candidates (Discord & partners may use any of these).
 * Host-swap fallbacks for dead Tenor URLs try these with the same path.
 * Prefer hosts that currently resolve publicly (static / api); keep others as
 * future-proof candidates for when Discord ships more CDN names.
 */
export const KLIPY_MEDIA_HOSTS = [
    "static.klipy.com",
    "api.klipy.com",
    "media.klipy.com",
    "cdn.klipy.com",
    "gifs.klipy.com",
    "i.klipy.com",
    "media1.klipy.com",
    "media2.klipy.com",
    "c.klipy.com",
    "klipy.com",
] as const;

export function hostnameOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

export function isTenorHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return h === "tenor.com"
        || h.endsWith(".tenor.com")
        || h.includes("tenor.com");
}

export function isKlipyHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return h === "klipy.com"
        || h.endsWith(".klipy.com")
        || h.includes("klipy.com");
}

export function isTenorUrl(url: string): boolean {
    const h = hostnameOf(url);
    return !!h && isTenorHost(h);
}

export function isKlipyUrl(url: string): boolean {
    const h = hostnameOf(url);
    return !!h && isKlipyHost(h);
}

/** Shared GIF provider hosts (Tenor, Klipy, Giphy, Discord CDN). */
export function isGifProviderHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (isTenorHost(h) || isKlipyHost(h)) return true;
    if (h.includes("giphy.com")) return true;
    if (
        h.includes("media.discordapp")
        || h.includes("cdn.discordapp")
        || h.includes("discordapp.net")
        || h.includes("images-ext-1.discordapp.net")
        || h.includes("images-ext-2.discordapp.net")
    ) {
        return true;
    }
    return false;
}

/**
 * When a Tenor media URL fails (CDN dead / blocked), try same path on Klipy hosts.
 * Path + query preserved. Original URL is NOT included (caller already tried it).
 */
export function tenorToKlipyFallbackUrls(url: string): string[] {
    if (!isTenorUrl(url)) return [];
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return [];
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (const host of KLIPY_MEDIA_HOSTS) {
        try {
            const u = new URL(parsed.href);
            u.hostname = host;
            // keep https
            u.protocol = "https:";
            const href = u.href;
            if (seen.has(href)) continue;
            seen.add(href);
            out.push(href);
        } catch {
            // skip bad host
        }
    }
    return out;
}

/**
 * Download / resolve candidate list: original first, then Klipy fallbacks for Tenor.
 * Deduped. Non-Tenor URLs return just the original.
 */
export function mediaDownloadCandidates(url: string): string[] {
    if (!url) return [];
    const out = [url];
    const seen = new Set([url]);
    for (const alt of tenorToKlipyFallbackUrls(url)) {
        if (seen.has(alt)) continue;
        seen.add(alt);
        out.push(alt);
    }
    return out;
}

/**
 * Cache lookup keys: original + host-normalized origin/path + Klipy rewrites of Tenor.
 * Lets a blob stored under a Klipy fallback still hit when Discord shows a Tenor favorite URL.
 */
export function mediaLookupKeys(url: string): string[] {
    if (!url) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    const add = (k: string) => {
        if (!k || seen.has(k)) return;
        seen.add(k);
        keys.push(k);
    };

    add(url);
    try {
        const u = new URL(url);
        if (isGifProviderHost(u.hostname)) {
            add(`${u.origin}${u.pathname}`);
        }
        add(u.href);
    } catch {
        // keep raw
    }

    for (const alt of tenorToKlipyFallbackUrls(url)) {
        add(alt);
        try {
            const u = new URL(alt);
            add(`${u.origin}${u.pathname}`);
        } catch {
            // skip
        }
    }

    return keys;
}
