import type { CacheEntry } from "./cacheCore";

export interface StorageBackend {
    readonly name: string;
    open(): Promise<void>;
    close(): Promise<void>;
    getAll(): Promise<CacheEntry[]>;
    get(key: string): Promise<CacheEntry | null>;
    put(entry: CacheEntry): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    deleteMany(keys: string[]): Promise<void>;
}

// Stable name so closing Discord does not wipe the DB
const DB_NAME = "FavoriteGifCache";
const DB_VERSION = 1;
const STORE = "gifs";

function toEntry(raw: any): CacheEntry {
    let data: Uint8Array;
    if (raw.data instanceof Uint8Array) {
        data = raw.data;
    } else if (raw.data instanceof ArrayBuffer) {
        data = new Uint8Array(raw.data);
    } else if (ArrayBuffer.isView(raw.data)) {
        data = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
    } else {
        data = new Uint8Array(0);
    }

    return {
        key: String(raw.key),
        data,
        size: typeof raw.size === "number" ? raw.size : data.byteLength,
        mimeType: raw.mimeType || "application/octet-stream",
        useCount: Number(raw.useCount) || 0,
        lastUsed: Number(raw.lastUsed) || 0,
        createdAt: Number(raw.createdAt) || 0,
    };
}

/** In-memory backend for tests / environments without IDB. */
export class MemoryStorageBackend implements StorageBackend {
    readonly name = "memory";
    private map = new Map<string, CacheEntry>();

    async open() {}
    async close() {}

    async getAll() {
        return [...this.map.values()].map(e => ({ ...e, data: e.data.slice() }));
    }

    async get(key: string) {
        const e = this.map.get(key);
        return e ? { ...e, data: e.data.slice() } : null;
    }

    async put(entry: CacheEntry) {
        this.map.set(entry.key, {
            ...entry,
            data: entry.data.slice(),
            size: entry.data.byteLength,
        });
    }

    async delete(key: string) {
        this.map.delete(key);
    }

    async clear() {
        this.map.clear();
    }

    async deleteMany(keys: string[]) {
        for (const k of keys) this.map.delete(k);
    }
}

/**
 * IndexedDB store. Lives in the Discord profile, survives restarts.
 * Plugin disable only drops the in-memory layer; this stays put.
 */
export class IndexedDBStorageBackend implements StorageBackend {
    readonly name = "indexeddb";
    private db: IDBDatabase | null = null;

    async open() {
        if (typeof indexedDB === "undefined") {
            throw new Error("IndexedDB unavailable");
        }
        if (this.db) return;

        this.db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: "key" });
                    store.createIndex("useCount", "useCount", { unique: false });
                    store.createIndex("lastUsed", "lastUsed", { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    async close() {
        this.db?.close();
        this.db = null;
    }

    private store(mode: IDBTransactionMode) {
        if (!this.db) throw new Error("IndexedDB not open");
        return this.db.transaction(STORE, mode).objectStore(STORE);
    }

    async getAll() {
        await this.open();
        return new Promise<CacheEntry[]>((resolve, reject) => {
            const req = this.store("readonly").getAll();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(((req.result as any[]) || []).map(toEntry));
        });
    }

    async get(key: string) {
        await this.open();
        return new Promise<CacheEntry | null>((resolve, reject) => {
            const req = this.store("readonly").get(key);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result ? toEntry(req.result) : null);
        });
    }

    async put(entry: CacheEntry) {
        await this.open();
        const record = {
            key: entry.key,
            data: entry.data.slice().buffer,
            size: entry.data.byteLength,
            mimeType: entry.mimeType,
            useCount: entry.useCount,
            lastUsed: entry.lastUsed,
            createdAt: entry.createdAt,
        };
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").put(record);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async delete(key: string) {
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").delete(key);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async clear() {
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const req = this.store("readwrite").clear();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
        });
    }

    async deleteMany(keys: string[]) {
        if (!keys.length) return;
        await this.open();
        return new Promise<void>((resolve, reject) => {
            const tx = this.db!.transaction(STORE, "readwrite");
            const store = tx.objectStore(STORE);
            for (const k of keys) store.delete(k);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

/**
 * Folder on disk via plugin native.ts (desktop only).
 * Each entry is a blob file + meta.json row.
 */
export class FileStorageBackend implements StorageBackend {
    readonly name = "filesystem";
    constructor(
        private readonly dir: string,
        private readonly api: {
            ensureCacheDir(dir: string): Promise<unknown>;
            loadAllEntries(dir: string): Promise<Array<{
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            }>>;
            putEntry(dir: string, entry: {
                key: string;
                data: ArrayBuffer;
                mimeType: string;
                useCount: number;
                lastUsed: number;
                createdAt: number;
                size: number;
            }): Promise<unknown>;
            deleteEntry(dir: string, key: string): Promise<unknown>;
            deleteEntries(dir: string, keys: string[]): Promise<unknown>;
            clearCacheDir(dir: string): Promise<unknown>;
        },
    ) {}

    get directory() {
        return this.dir;
    }

    async open() {
        await this.api.ensureCacheDir(this.dir);
    }

    async close() {}

    async getAll(): Promise<CacheEntry[]> {
        const rows = await this.api.loadAllEntries(this.dir);
        return rows.map(r => toEntry({
            key: r.key,
            data: r.data,
            mimeType: r.mimeType,
            useCount: r.useCount,
            lastUsed: r.lastUsed,
            createdAt: r.createdAt,
            size: r.size,
        }));
    }

    async get(key: string) {
        const all = await this.getAll();
        return all.find(e => e.key === key) ?? null;
    }

    async put(entry: CacheEntry) {
        const copy = entry.data.slice();
        await this.api.putEntry(this.dir, {
            key: entry.key,
            data: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
            mimeType: entry.mimeType,
            useCount: entry.useCount,
            lastUsed: entry.lastUsed,
            createdAt: entry.createdAt,
            size: entry.data.byteLength,
        });
    }

    async delete(key: string) {
        await this.api.deleteEntry(this.dir, key);
    }

    async clear() {
        await this.api.clearCacheDir(this.dir);
    }

    async deleteMany(keys: string[]) {
        if (!keys.length) return;
        await this.api.deleteEntries(this.dir, keys);
    }
}

export function createDefaultBackend(): StorageBackend {
    if (typeof indexedDB !== "undefined") return new IndexedDBStorageBackend();
    return new MemoryStorageBackend();
}

export function createBackendForPath(
    cacheDir: string | undefined | null,
    nativeApi: FileStorageBackend["api"] | null,
): StorageBackend {
    const dir = (cacheDir || "").trim();
    if (dir && nativeApi) {
        return new FileStorageBackend(dir, nativeApi);
    }
    return createDefaultBackend();
}
