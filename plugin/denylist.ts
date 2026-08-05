/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { cacheKeyForUrl } from "./favorites";

const STORE_KEY = "FavoriteGifCache.autoCacheDenylist";

let denied = new Set<string>();
let loaded = false;

function keysFor(url: string) {
    const k = cacheKeyForUrl(url);
    return k === url ? [url] : [k, url];
}

export async function loadDenylist() {
    try {
        const arr = (await DataStore.get(STORE_KEY)) as string[] | undefined;
        denied = new Set(Array.isArray(arr) ? arr : []);
    } catch {
        denied = new Set();
    }
    loaded = true;
}

async function persist() {
    await DataStore.set(STORE_KEY, [...denied]);
}

export function isAutoCacheDenied(url: string) {
    if (!url) return false;
    for (const k of keysFor(url)) {
        if (denied.has(k)) return true;
    }
    return false;
}

/** Block auto/prefetch/scroll caching until user manually caches again. */
export async function denyAutoCache(url: string) {
    for (const k of keysFor(url)) denied.add(k);
    await persist();
}

/** Allow auto-cache again (and used when user clicks Cache GIF). */
export async function allowAutoCache(url: string) {
    for (const k of keysFor(url)) denied.delete(k);
    await persist();
}

export function denylistSize() {
    return denied.size;
}

export function isDenylistLoaded() {
    return loaded;
}
