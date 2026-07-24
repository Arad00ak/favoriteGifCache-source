import { Button } from "@components/Button";
import { useEffect, useState } from "@webpack/common";
import { Toasts } from "@webpack/common";

import { getActiveCache, rebuildActiveCache } from "./cacheAccess";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES } from "./gifCache";
import { getPluginNative, hasFileNative } from "./nativeApi";
import { settings } from "./settings"; // settings.store only — no cycle through this component

function formatMB(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) return "0.0";
    return (bytes / (1024 * 1024)).toFixed(1);
}

function barColor(pct: number) {
    if (pct >= 90) return "var(--status-danger, #f23f43)";
    if (pct >= 70) return "var(--status-warning, #f0b232)";
    return "var(--brand-500, #5865f2)";
}

function toast(message: string, type: any) {
    try {
        Toasts.show({
            message,
            type,
            id: Toasts.genId(),
        });
    } catch {
        // ignore
    }
}

function UsageBar(props: {
    label: string;
    valueText: string;
    percent: number;
}) {
    const pct = Math.max(0, Math.min(100, props.percent));
    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
                gap: 8,
            }}>
                <span style={{
                    color: "var(--header-secondary)",
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.02em",
                }}>
                    {props.label}
                </span>
                <span style={{
                    color: "var(--text-default)",
                    fontSize: 12,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                }}>
                    {props.valueText}
                </span>
            </div>
            <div style={{
                height: 8,
                borderRadius: 4,
                background: "var(--background-modifier-accent, #3f4147)",
                overflow: "hidden",
            }}>
                <div style={{
                    width: `${pct}%`,
                    height: "100%",
                    borderRadius: 4,
                    background: barColor(pct),
                    transition: "width 0.35s ease, background 0.35s ease",
                }} />
            </div>
        </div>
    );
}

export function CacheUsageBar() {
    const [count, setCount] = useState(0);
    const [bytes, setBytes] = useState(0);
    const [maxEntries, setMaxEntries] = useState(DEFAULT_MAX_ENTRIES);
    const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pathLabel, setPathLabel] = useState("");
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let alive = true;

        (async () => {
            try {
                const cache = getActiveCache() ?? await rebuildActiveCache().catch(() => null);
                if (!cache) {
                    if (alive) {
                        setReady(false);
                        setCount(0);
                        setBytes(0);
                    }
                    return;
                }
                await cache.init();
                if (!alive) return;
                setCount(cache.size());
                setBytes(cache.bytes());
                setMaxEntries(cache.getMaxEntries());
                const mb = cache.getMaxBytes();
                setMaxBytes(Number.isFinite(mb) ? mb : DEFAULT_MAX_BYTES);
                const dir = (settings.store.cacheDirectory || "").trim();
                setPathLabel(dir || "IndexedDB (default Discord profile storage)");
                setReady(true);
            } catch {
                if (alive) setReady(false);
            }
        })();

        return () => {
            alive = false;
        };
    }, [tick]);

    const entryPct = maxEntries > 0 ? (count / maxEntries) * 100 : 0;
    const bytePct = maxBytes > 0 ? (bytes / maxBytes) * 100 : 0;
    const usedMB = formatMB(bytes);
    const maxMB = formatMB(maxBytes);
    const leftMB = formatMB(Math.max(0, maxBytes - bytes));
    const canPickFolder = hasFileNative();

    const onClear = async () => {
        setBusy(true);
        try {
            const cache = getActiveCache() ?? await rebuildActiveCache();
            await cache.clear();
            toast("Favorite GIF cache cleared", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch {
            toast("Failed to clear cache", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const onBrowse = async () => {
        const native = getPluginNative();
        if (!native) {
            toast("Folder pick needs the desktop client", Toasts.Type.FAILURE);
            return;
        }
        setBusy(true);
        try {
            const current = (settings.store.cacheDirectory || "").trim()
                || await native.getDefaultCacheDir();
            const picked = await native.pickCacheDirectory(current);
            if (!picked) {
                setBusy(false);
                return;
            }
            await native.ensureCacheDir(picked);
            settings.store.cacheDirectory = picked;
            await rebuildActiveCache();
            toast("Cache folder updated", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch (e) {
            toast(e instanceof Error ? e.message : "Could not set folder", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    const onUseDefault = async () => {
        setBusy(true);
        try {
            settings.store.cacheDirectory = "";
            await rebuildActiveCache();
            toast("Using default IndexedDB storage", Toasts.Type.SUCCESS);
            setTick(t => t + 1);
        } catch {
            toast("Failed to reset storage", Toasts.Type.FAILURE);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            marginTop: 4,
            marginBottom: 8,
            padding: 12,
            borderRadius: 8,
            background: "var(--background-secondary-alt, #2b2d31)",
            border: "1px solid var(--background-modifier-accent, #3f4147)",
        }}>
            <div style={{
                color: "var(--header-primary)",
                fontSize: 14,
                fontWeight: 600,
                marginBottom: 4,
            }}>
                Cache usage
            </div>
            <div style={{
                marginBottom: 12,
                color: "var(--text-muted)",
                fontSize: 13,
                lineHeight: "18px",
            }}>
                {ready
                    ? `${leftMB} MB free · snapshot when you open this page`
                    : "Enable the plugin (or wait a moment) to load stats."}
            </div>

            <UsageBar
                label="GIFs"
                valueText={`${count} / ${maxEntries}`}
                percent={entryPct}
            />
            <UsageBar
                label="Size"
                valueText={`${usedMB} MB / ${maxMB} MB`}
                percent={bytePct}
            />

            <div style={{
                marginBottom: 10,
                color: "var(--text-muted)",
                fontSize: 12,
                wordBreak: "break-all",
            }}>
                <span style={{ fontWeight: 600, color: "var(--header-secondary)" }}>Location: </span>
                {pathLabel || "—"}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button
                    size="small"
                    variant="dangerPrimary"
                    disabled={busy || !ready}
                    onClick={() => void onClear()}
                >
                    Clear cache
                </Button>
                {canPickFolder && (
                    <>
                        <Button
                            size="small"
                            variant="primary"
                            disabled={busy}
                            onClick={() => void onBrowse()}
                        >
                            Choose folder
                        </Button>
                        <Button
                            size="small"
                            variant="secondary"
                            disabled={busy || !(settings.store.cacheDirectory || "").trim()}
                            onClick={() => void onUseDefault()}
                        >
                            Use default
                        </Button>
                    </>
                )}
            </div>
            {!canPickFolder && (
                <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 12 }}>
                    Custom folders need the desktop Equicord/Vencord client (native helpers).
                </div>
            )}
        </div>
    );
}
