/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

type Native = PluginNative<typeof import("./native")>;


export function getPluginNative(): Native | null {
    try {
        const helpers =
            (typeof VencordNative !== "undefined" && (VencordNative as any)?.pluginHelpers)
            || (globalThis as any).VencordNative?.pluginHelpers
            || (globalThis as any).EquicordNative?.pluginHelpers
            || null;

        if (!helpers || typeof helpers !== "object") return null;


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
