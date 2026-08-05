/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Soft size budget shown in settings and enforced on put / load (disk + catalog). */
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
/**
 * Hard cap on how much decoded media we keep in the renderer heap at once.
 * Disk can still hold up to maxBytes; cold entries unload payload and reload on demand.
 * Without this, a full 500 MB catalog OOMs Discord.
 */
export const SOFT_MEMORY_BYTES = 80 * 1024 * 1024;

export interface CacheMeta {
    key: string;
    useCount: number;
    lastUsed: number;
    size: number;
    mimeType: string;
    createdAt: number;
}

export interface CacheEntry extends CacheMeta {
    data: Uint8Array;
}

export interface CacheCoreOptions {
    maxBytes?: number;
    /** In-heap payload budget (default SOFT_MEMORY_BYTES). */
    softMemoryBytes?: number;
    now?: () => number;
}

export interface PutOptions {
    /**
     * When false (default), refuse to store a new key if the cache is already full.
     * Stops scroll/prefetch from kicking out stuff just to make room for something else.
     * When true, drop the least-used entry (prefer ones not marked protected).
     */
    allowEvict?: boolean;
}

export interface PutResult {
    stored: boolean;
    evictedKeys: string[];
    /** true when we skipped insert because the cache was full and eviction was off */
    skippedFull?: boolean;
}

export class GifCacheCore {
    private readonly entries = new Map<string, CacheEntry>();
    private maxBytes: number;
    private softMemoryBytes: number;
    private totalBytes = 0;
    private readonly now: () => number;
    /** Keys we try not to evict (usually still in Discord favorites). */
    private protectedKeys = new Set<string>();

    constructor(options: CacheCoreOptions = {}) {
        this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
        this.softMemoryBytes = options.softMemoryBytes ?? SOFT_MEMORY_BYTES;
        this.now = options.now ?? (() => Date.now());
    }

    getMaxBytes() {
        return this.maxBytes;
    }

    setMaxBytes(n: number) {
        this.maxBytes = n > 0 ? n : Number.POSITIVE_INFINITY;
        return this.enforceCap();
    }

    getSoftMemoryBytes() {
        return this.softMemoryBytes;
    }

    setProtectedKeys(keys: Iterable<string>) {
        this.protectedKeys = new Set(keys);
    }

    getProtectedKeys(): string[] {
        return [...this.protectedKeys];
    }

    size() {
        return this.entries.size;
    }

    bytes() {
        return this.totalBytes;
    }

    /** Bytes of payload currently resident in the renderer heap. */
    residentBytes() {
        let n = 0;
        for (const e of this.entries.values()) n += e.data.byteLength;
        return n;
    }

    keys() {
        return [...this.entries.keys()];
    }

    has(key: string) {
        return this.entries.has(key);
    }

    /** True when the key is cataloged but payload was unloaded to free RAM. */
    needsHydrate(key: string) {
        const entry = this.entries.get(key);
        return !!entry && entry.size > 0 && entry.data.byteLength === 0;
    }

    hasResidentData(key: string) {
        const entry = this.entries.get(key);
        return !!entry && entry.data.byteLength > 0;
    }

    get(key: string): CacheEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;

        entry.useCount += 1;
        entry.lastUsed = this.now();

        return { ...entry, data: entry.data.slice() };
    }

    peek(key: string): CacheEntry | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        return { ...entry, data: entry.data.slice() };
    }

    getMeta(key: string): CacheMeta | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        const { data: _d, ...meta } = entry;
        return { ...meta };
    }

    listMeta(): CacheMeta[] {
        return [...this.entries.values()].map(({ data: _d, ...meta }) => ({ ...meta }));
    }

    /**
     * Store bytes for a key.
     * Overwrite of an existing key never grows the entry count.
     * New keys only push others out when allowEvict is true.
     */
    put(
        key: string,
        data: Uint8Array,
        mimeType = "application/octet-stream",
        options: PutOptions = {},
    ): PutResult {
        if (!key) return { stored: false, evictedKeys: [] };

        const allowEvict = options.allowEvict === true;
        const payload = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
        const size = payload.byteLength;
        const evictedKeys: string[] = [];

        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.size;
            this.entries.delete(key);
        }

        if (size > this.maxBytes && this.maxBytes !== Number.POSITIVE_INFINITY) {
            return { stored: false, evictedKeys };
        }

        while (this.totalBytes + size > this.maxBytes) {
            if (!allowEvict) {
                // put existing back if we stripped it for rewrite and can't finish
                if (existing) {
                    this.entries.set(existing.key, existing);
                    this.totalBytes += existing.size;
                }
                return { stored: false, evictedKeys, skippedFull: true };
            }
            const victim = this.pickVictim(key);
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evictedKeys.push(victim.key);
        }

        if (this.totalBytes + size > this.maxBytes) {
            if (existing) {
                this.entries.set(existing.key, existing);
                this.totalBytes += existing.size;
            }
            return { stored: false, evictedKeys, skippedFull: true };
        }

        const t = this.now();
        const entry: CacheEntry = {
            key,
            data: payload,
            size,
            mimeType: mimeType || "application/octet-stream",
            useCount: existing?.useCount ?? 0,
            lastUsed: t,
            createdAt: existing?.createdAt ?? t,
        };

        this.entries.set(key, entry);
        this.totalBytes += size;
        this.ensureSoftMemory(key);
        return { stored: true, evictedKeys };
    }

    delete(key: string) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this.totalBytes -= entry.size;
        return true;
    }

    clear() {
        this.entries.clear();
        this.totalBytes = 0;
    }

    /** Load from disk without touching use counts. */
    loadEntry(entry: CacheEntry) {
        const payload = entry.data instanceof Uint8Array
            ? entry.data.slice()
            : new Uint8Array(entry.data);
        const prev = this.entries.get(entry.key);
        if (prev) {
            this.totalBytes -= prev.size;
            this.entries.delete(entry.key);
        }
        // Prefer stored size when present so unloaded shells (data empty) still account disk usage
        const size = payload.byteLength > 0
            ? payload.byteLength
            : (typeof entry.size === "number" && entry.size > 0 ? entry.size : payload.byteLength);
        const next: CacheEntry = {
            key: entry.key,
            data: payload,
            size,
            mimeType: entry.mimeType || "application/octet-stream",
            useCount: entry.useCount ?? 0,
            lastUsed: entry.lastUsed ?? this.now(),
            createdAt: entry.createdAt ?? this.now(),
        };
        this.entries.set(next.key, next);
        this.totalBytes += next.size;
    }

    /**
     * Drop cold payloads from the heap until under softMemoryBytes.
     * Catalog (size/meta) stays; disk copy is untouched. Returns unloaded keys.
     */
    ensureSoftMemory(keepKey?: string): string[] {
        const unloaded: string[] = [];
        while (this.residentBytes() > this.softMemoryBytes) {
            const victim = this.pickDataVictim(keepKey);
            if (!victim) break;
            if (victim.data.byteLength === 0) break;
            victim.data = new Uint8Array(0);
            unloaded.push(victim.key);
        }
        return unloaded;
    }

    /** Prefer cold, unprotected, resident payloads for RAM unload (not full eviction). */
    private pickDataVictim(exceptKey?: string): CacheEntry | null {
        let bestUnprotected: CacheEntry | null = null;
        let bestAny: CacheEntry | null = null;

        for (const entry of this.entries.values()) {
            if (exceptKey && entry.key === exceptKey) continue;
            if (entry.data.byteLength === 0) continue;

            if (!this.protectedKeys.has(entry.key)) {
                if (!bestUnprotected || this.isWorse(entry, bestUnprotected)) {
                    bestUnprotected = entry;
                }
            }
            if (!bestAny || this.isWorse(entry, bestAny)) {
                bestAny = entry;
            }
        }

        return bestUnprotected ?? bestAny;
    }

    /**
     * Least-used first, then oldest lastUsed.
     * Prefer kicking unprotected keys (not in the current favorites set).
     */
    pickVictim(exceptKey?: string): CacheEntry | null {
        let bestUnprotected: CacheEntry | null = null;
        let bestAny: CacheEntry | null = null;

        for (const entry of this.entries.values()) {
            if (exceptKey && entry.key === exceptKey) continue;

            if (!this.protectedKeys.has(entry.key)) {
                if (!bestUnprotected || this.isWorse(entry, bestUnprotected)) {
                    bestUnprotected = entry;
                }
            }
            if (!bestAny || this.isWorse(entry, bestAny)) {
                bestAny = entry;
            }
        }

        return bestUnprotected ?? bestAny;
    }

    private isWorse(a: CacheEntry, b: CacheEntry) {
        if (a.useCount !== b.useCount) return a.useCount < b.useCount;
        if (a.lastUsed !== b.lastUsed) return a.lastUsed < b.lastUsed;
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
        return a.key < b.key;
    }

    private enforceCap(): string[] {
        const evicted: string[] = [];
        while (this.totalBytes > this.maxBytes) {
            const victim = this.pickVictim();
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evicted.push(victim.key);
        }
        return evicted;
    }
}
