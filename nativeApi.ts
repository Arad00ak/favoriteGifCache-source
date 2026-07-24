import type { PluginNative } from "@utils/types";

type Native = PluginNative<typeof import("./native")>;

export function getPluginNative(): Native | null {
    try {
        const helpers = (VencordNative as any)?.pluginHelpers
            ?? (globalThis as any).VencordNative?.pluginHelpers
            ?? (globalThis as any).EquicordNative?.pluginHelpers;
        const n = helpers?.favoriteGifCache as Native | undefined;
        return n ?? null;
    } catch {
        return null;
    }
}

export function hasFileNative() {
    const n = getPluginNative();
    return !!(n && typeof n.pickCacheDirectory === "function");
}
