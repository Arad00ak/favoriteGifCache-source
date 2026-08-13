/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    DEFAULT_MAX_BYTES,
    GifCacheCore,
    SOFT_MEMORY_BYTES,
    type CacheCoreOptions,
    type CacheEntry,
    type CacheMeta,
    type PutOptions,
    type PutResult,
} from "./cacheCore";
import { mediaLookupKeys } from "./hosts";
import { sniffMime } from "./sniffMime";
import {
    createDefaultBackend,
    MemoryStorageBackend,
    type StorageBackend,
} from "./storage";

export { DEFAULT_MAX_BYTES, SOFT_MEMORY_BYTES, GifCacheCore };
export type { CacheEntry, CacheMeta, PutOptions, PutResult, StorageBackend };
export { MemoryStorageBackend };

export interface FavoriteGifCacheOptions extends CacheCoreOptions {
    backend?: StorageBackend;
    
    smartEviction?: boolean;
}

export interface BlobUrlOptions {
    
    bumpUsage?: boolean;
}

export class FavoriteGifCache {
    private readonly core: GifCacheCore;
    private readonly backend: StorageBackend;
    private smartEviction: boolean;
    private ready: Promise<void> | null = null;
    private initDone = false;
    private blobUrls = new Map<string, string>();
    private metaPersistQueue = new Map<string, ReturnType<typeof setTimeout>>();
    private revokeListener: ((blobUrl: string) => void) | null = null;

    constructor(options: FavoriteGifCacheOptions = {}) {
        this.core = new GifCacheCore(options);
        this.backend = options.backend ?? createDefaultBackend();
        this.smartEviction = options.smartEviction !== false;
    }

    get backendName() {
        return this.backend.name;
    }

    getSmartEviction() {
        return this.smartEviction;
    }

    setSmartEviction(enabled: boolean) {
        this.smartEviction = enabled;
    }

    isInitialized() {
        return this.initDone;
    }

    setRevokeListener(fn: ((blobUrl: string) => void) | null) {
        this.revokeListener = fn;
    }

    async init() {
        if (!this.ready) {
            this.ready = (async () => {
                await this.backend.open();
                const all = await this.backend.getAll();

                for (const entry of all) {
                    this.core.loadEntry(entry);
                    this.core.ensureSoftMemory();
                }


                const before = new Set(this.core.keys());
                const removed = this.core.setMaxBytes(this.core.getMaxBytes());
                const gone = removed.length
                    ? removed
                    : [...before].filter(k => !this.core.has(k));
                if (gone.length) {
                    await this.backend.deleteMany(gone);
                    for (const k of gone) this.revokeBlob(k);
                }

                this.core.ensureSoftMemory();

                this.initDone = true;
            })();
        }
        await this.ready;
    }

    
    async hydrate(key: string): Promise<boolean> {
        await this.init();
        if (!this.core.has(key)) return false;
        if (this.core.hasResidentData(key)) return true;

        const fromDisk = await this.backend.get(key);
        if (!fromDisk || fromDisk.data.byteLength === 0) return false;
        this.core.loadEntry(fromDisk);
        this.core.ensureSoftMemory(key);
        return this.core.hasResidentData(key);
    }

    getMaxBytes() {
        return this.core.getMaxBytes();
    }

    async setMaxBytes(n: number) {
        await this.init();
        const before = new Set(this.core.keys());
        this.core.setMaxBytes(n);
        const removed = [...before].filter(k => !this.core.has(k));
        if (removed.length) {
            await this.backend.deleteMany(removed);
            for (const k of removed) this.revokeBlob(k);
        }
    }

    
    setProtectedKeys(keys: Iterable<string>) {
        this.core.setProtectedKeys(keys);
    }

    
    setDisplayPinnedKeys(keys: Iterable<string>) {
        this.core.setDisplayPinnedKeys(keys);
    }

    size() {
        return this.core.size();
    }

    bytes() {
        return this.core.bytes();
    }

    has(key: string) {
        return this.core.has(key);
    }

    hasResidentData(key: string) {
        return this.core.hasResidentData(key);
    }

    keys() {
        return this.core.keys();
    }

    listMeta() {
        return this.core.listMeta();
    }

    async get(key: string): Promise<CacheEntry | null> {
        await this.init();
        if (this.core.needsHydrate(key)) await this.hydrate(key);
        const entry = this.core.get(key);
        if (!entry || entry.data.byteLength === 0) return null;

        await this.backend.put(entry);
        return entry;
    }

    async peek(key: string) {
        await this.init();
        if (this.core.needsHydrate(key)) await this.hydrate(key);
        return this.core.peek(key);
    }

    peekSync(key: string) {
        return this.core.peek(key);
    }

    getMetaSync(key: string) {
        return this.core.getMeta(key);
    }

    touchSync(key: string) {
        const entry = this.core.get(key);
        if (!entry) return false;
        this.scheduleMetaPersist(entry);
        return true;
    }

    
    async put(
        key: string,
        data: Uint8Array,
        mimeType = "application/octet-stream",
        options: PutOptions = {},
    ): Promise<PutResult> {
        await this.init();
        const allowEvict = this.smartEviction && options.allowEvict === true;
        const result = this.core.put(key, data, mimeType, { allowEvict });

        if (result.evictedKeys.length) {
            await this.backend.deleteMany(result.evictedKeys);
            for (const k of result.evictedKeys) this.revokeBlob(k);
        }

        if (result.stored) {
            const stored = this.core.peek(key);
            if (stored && stored.data.byteLength > 0) {
                await this.backend.put(stored);
                if (!this.blobUrls.has(key)) {
                    this.ensureBlobUrlSync(key, { bumpUsage: false });
                }
            }
        }

        return result;
    }

    async delete(key: string) {
        await this.init();
        const ok = this.core.delete(key);
        if (ok) {
            await this.backend.delete(key);
            this.revokeBlob(key);
        }
        return ok;
    }

    
    async pruneNotIn(keepKeys: Iterable<string>) {
        await this.init();
        const keep = new Set(keepKeys);
        const drop: string[] = [];
        for (const key of this.core.keys()) {
            if (!keep.has(key)) drop.push(key);
        }
        for (const key of drop) {
            this.core.delete(key);
            this.revokeBlob(key);
        }
        if (drop.length) await this.backend.deleteMany(drop);
        return drop;
    }

    async clear() {
        await this.init();
        for (const k of [...this.blobUrls.keys()]) this.revokeBlob(k);
        this.core.clear();
        await this.backend.clear();
    }

    ensureBlobUrlSync(key: string, opts: BlobUrlOptions = {}): string | null {
        if (!key) return null;
        if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
            return null;
        }

        const bump = opts.bumpUsage !== false;
        const existing = this.blobUrls.get(key);
        if (existing) {
            if (bump) this.touchSync(key);
            return existing;
        }


        if (this.core.needsHydrate(key)) return null;

        const entry = bump ? this.core.get(key) : this.core.peek(key);
        if (!entry || entry.data.byteLength === 0) return null;
        if (bump) this.scheduleMetaPersist(entry);

        try {

            const copy = entry.data.slice();
            const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
            const mime = sniffMime(copy, entry.mimeType || "application/octet-stream");
            const blob = new Blob([ab], { type: mime || "application/octet-stream" });
            if (blob.size <= 0) return null;
            const url = URL.createObjectURL(blob);
            this.blobUrls.set(key, url);

            if (mime && mime !== entry.mimeType) {
                entry.mimeType = mime;
            }
            return url;
        } catch {
            return null;
        }
    }

    
    async ensureBlobUrl(key: string, opts: BlobUrlOptions = {}): Promise<string | null> {
        await this.init();
        if (this.core.needsHydrate(key)) {
            await this.hydrate(key);
        }
        return this.ensureBlobUrlSync(key, opts);
    }

    resolveDisplayUrlSync(remoteUrl: string): string | null {
        const hit = this.resolveDisplayHitSync(remoteUrl);
        return hit?.blobUrl ?? null;
    }

    
    resolveDisplayHitSync(remoteUrl: string, opts: BlobUrlOptions = {}): { blobUrl: string; mimeType?: string; key: string; } | null {
        if (!remoteUrl || remoteUrl.startsWith("blob:") || remoteUrl.startsWith("data:")) {
            return null;
        }

        const bump = opts.bumpUsage !== false;
        const candidates = mediaLookupKeys(remoteUrl);

        for (const key of candidates) {
            const hot = this.blobUrls.get(key);
            if (hot) {
                if (bump) this.touchSync(key);
                const meta = this.core.getMeta(key);
                return { blobUrl: hot, mimeType: meta?.mimeType, key };
            }
        }

        for (const key of candidates) {
            const created = this.ensureBlobUrlSync(key, { bumpUsage: bump });
            if (created) {
                const meta = this.core.getMeta(key);
                return { blobUrl: created, mimeType: meta?.mimeType, key };
            }
        }

        return null;
    }

    
    warmAllBlobUrls(keys?: string[]) {
        const list = keys ?? this.core.keys();
        let n = 0;
        for (const key of list) {
            if (!this.core.hasResidentData(key)) continue;
            if (this.ensureBlobUrlSync(key, { bumpUsage: false })) n += 1;
        }
        return n;
    }

    async getBlobUrl(key: string) {
        return this.ensureBlobUrl(key, { bumpUsage: true });
    }

    getCachedBlobUrl(key: string) {
        return this.blobUrls.get(key);
    }

    
    isLiveBlobUrl(blobUrl: string) {
        if (!blobUrl || !blobUrl.startsWith("blob:")) return false;
        for (const u of this.blobUrls.values()) {
            if (u === blobUrl) return true;
        }
        return false;
    }

    private scheduleMetaPersist(entry: CacheEntry) {

        if (entry.data.byteLength === 0 && entry.size > 0) return;

        const prev = this.metaPersistQueue.get(entry.key);
        if (prev) clearTimeout(prev);

        const t = setTimeout(() => {
            this.metaPersistQueue.delete(entry.key);
            const latest = this.core.peek(entry.key);
            if (!latest || (latest.data.byteLength === 0 && latest.size > 0)) return;
            void this.backend.put(latest).catch(() => {});
        }, 50);
        this.metaPersistQueue.set(entry.key, t);
    }

    private revokeBlob(key: string) {
        const url = this.blobUrls.get(key);
        if (url) {
            try {
                this.revokeListener?.(url);
            } catch {
            }
            if (typeof URL !== "undefined" && URL.revokeObjectURL) {
                try {
                    URL.revokeObjectURL(url);
                } catch {
                }
            }
        }
        this.blobUrls.delete(key);
    }

    getCoreForTests() {
        return this.core;
    }
}

export function createFavoriteGifCache(options: FavoriteGifCacheOptions = {}) {
    return new FavoriteGifCache({
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        softMemoryBytes: options.softMemoryBytes ?? SOFT_MEMORY_BYTES,
        backend: options.backend,
        now: options.now,
        smartEviction: options.smartEviction,
    });
}
