import type { PluginNative } from "@utils/types";

type Native = PluginNative<typeof import("./native")>;

/** Plugin helpers are keyed by definePlugin name and sometimes folder name. */
export function getPluginNative(): Native | null {
    try {
        const helpers =
            (typeof VencordNative !== "undefined" && (VencordNative as any)?.pluginHelpers)
            || (globalThis as any).VencordNative?.pluginHelpers
            || (globalThis as any).EquicordNative?.pluginHelpers
            || null;

        if (!helpers || typeof helpers !== "object") return null;

        // Keyed by definePlugin({ name }) — see other plugins (OpenInApp, FileUpload, …)
        const n =
            helpers.FavoriteGifCache
            ?? helpers.favoriteGifCache
            ?? null;

        if (n && typeof n.pickCacheDirectory === "function") return n as Native;
        return null;
    } catch {
        return null;
    }
}

export function hasFileNative() {
    return getPluginNative() != null;
}
