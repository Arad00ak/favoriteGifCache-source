/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const KLIPY_MEDIA_HOSTS = [
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

const ALL_ALLOWED_HOSTS = [
    "media.tenor.com",
    "c.tenor.com",
    "tenor.com",
    ...KLIPY_MEDIA_HOSTS,
    "media.giphy.com",
    "media0.giphy.com",
    "media1.giphy.com",
    "media2.giphy.com",
    "media3.giphy.com",
    "media4.giphy.com",
    "i.giphy.com",
    "giphy.com",
    "media.discordapp.net",
    "cdn.discordapp.com",
    "images-ext-1.discordapp.net",
    "images-ext-2.discordapp.net",
    "discord.com",
    "discordapp.com",
    "discordapp.net",
] as const;

export function hostAllowed(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    if (!h) return false;
    for (const allowed of ALL_ALLOWED_HOSTS) {
        if (h === allowed || h.endsWith("." + allowed)) return true;
    }
    return false;
}

function isTenorUrl(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
        return h === "tenor.com" || h.endsWith(".tenor.com");
    } catch {
        return false;
    }
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

const lookupMemo = new Map<string, string[]>();

export function mediaLookupKeys(url: string): string[] {
    if (!url) return [];
    const hit = lookupMemo.get(url);
    if (hit) return hit;

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
        if (hostAllowed(u.hostname)) add(`${u.origin}${u.pathname}`);
        add(u.href);
    } catch {
    }

    if (lookupMemo.size > 1500) lookupMemo.clear();
    lookupMemo.set(url, keys);
    return keys;
}
