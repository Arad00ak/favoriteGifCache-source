/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const TENOR_HOSTS = [
    "media.tenor.com",
    "c.tenor.com",
    "tenor.com",
] as const;

export const KLIPY_MEDIA_HOSTS = [
    "static.klipy.com",
    "media.klipy.com",
    "cdn.klipy.com",
    "gifs.klipy.com",
    "i.klipy.com",
    "media1.klipy.com",
    "media2.klipy.com",
    "c.klipy.com",
    "klipy.com",
] as const;

export const GIPHY_HOSTS = [
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
    "i.giphy.com",
    "giphy.com",
] as const;

export const DISCORD_MEDIA_HOSTS = [
    "media.discordapp.net",
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
] as const;

const ALL_ALLOWED_HOSTS: readonly string[] = [
    ...TENOR_HOSTS,
    ...KLIPY_MEDIA_HOSTS,
    ...GIPHY_HOSTS,
    ...DISCORD_MEDIA_HOSTS,
    "discord.com",
    "discordapp.com",
    "discordapp.net",
];

export function hostnameOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

export function hostAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (const allowed of ALL_ALLOWED_HOSTS) {
        if (h === allowed || h.endsWith("." + allowed)) return true;
    }
    return false;
}

export function isTenorHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    return h === "tenor.com" || h.endsWith(".tenor.com");
}

export function isKlipyHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    return h === "klipy.com" || h.endsWith(".klipy.com");
}

export function isTenorUrl(url: string): boolean {
    const h = hostnameOf(url);
    return !!h && isTenorHost(h);
}

export function isKlipyUrl(url: string): boolean {
    const h = hostnameOf(url);
    return !!h && isKlipyHost(h);
}

export function isGifProviderHost(hostname: string): boolean {
    return hostAllowed(hostname);
}

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
            u.protocol = "https:";
            const href = u.href;
            if (seen.has(href)) continue;
            seen.add(href);
            out.push(href);
        } catch {
        }
    }
    return out;
}

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
    }

    for (const alt of tenorToKlipyFallbackUrls(url)) {
        add(alt);
        try {
            const u = new URL(alt);
            add(`${u.origin}${u.pathname}`);
        } catch {
        }
    }

    return keys;
}
