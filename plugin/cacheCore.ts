export const DEFAULT_MAX_ENTRIES = 500;
/** Soft size budget shown in settings and enforced with the entry cap. */
export const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

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
    maxEntries?: number;
    maxBytes?: number;
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
    private maxEntries: number;
    private maxBytes: number;
    private totalBytes = 0;
    private readonly now: () => number;
    /** Keys we try not to evict (usually still in Discord favorites). */
    private protectedKeys = new Set<string>();

    constructor(options: CacheCoreOptions = {}) {
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
        this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
        this.now = options.now ?? (() => Date.now());
    }

    getMaxEntries() {
        return this.maxEntries;
    }

    setMaxEntries(n: number) {
        this.maxEntries = Math.max(1, n);
        return this.enforceCap();
    }

    getMaxBytes() {
        return this.maxBytes;
    }

    setMaxBytes(n: number) {
        this.maxBytes = n > 0 ? n : Number.POSITIVE_INFINITY;
        return this.enforceCap();
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

    keys() {
        return [...this.entries.keys()];
    }

    has(key: string) {
        return this.entries.has(key);
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

        const needsSlot = !existing;
        const overCount = () => this.entries.size >= this.maxEntries && needsSlot
            || (existing ? this.entries.size > this.maxEntries : this.entries.size >= this.maxEntries);
        // after deleting existing, size is entries without this key
        while (
            (needsSlot && this.entries.size >= this.maxEntries)
            || this.totalBytes + size > this.maxBytes
        ) {
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

        if (
            (needsSlot && this.entries.size >= this.maxEntries)
            || this.totalBytes + size > this.maxBytes
        ) {
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
        const next: CacheEntry = {
            key: entry.key,
            data: payload,
            size: payload.byteLength,
            mimeType: entry.mimeType || "application/octet-stream",
            useCount: entry.useCount ?? 0,
            lastUsed: entry.lastUsed ?? this.now(),
            createdAt: entry.createdAt ?? this.now(),
        };
        this.entries.set(next.key, next);
        this.totalBytes += next.size;
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
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const victim = this.pickVictim();
            if (!victim) break;
            this.entries.delete(victim.key);
            this.totalBytes -= victim.size;
            evicted.push(victim.key);
        }
        return evicted;
    }
}
