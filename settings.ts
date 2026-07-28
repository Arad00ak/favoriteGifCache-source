import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { DEFAULT_MAX_ENTRIES } from "./gifCache";

// component plugged in from index to avoid circular imports
let usageComponent: (() => any) | null = null;

export function setUsageBarComponent(fn: () => any) {
    usageComponent = fn;
}

/** Wired from index.tsx after cache helpers exist. */
export const settingsHooks = {
    onLimitsChange: () => {},
    onSmartEvictionChange: () => {},
    onCacheDirectoryChange: () => {},
};

export const settings = definePluginSettings({
    cacheUsage: {
        type: OptionType.COMPONENT,
        description: "Cache usage and actions",
        component: () => (usageComponent ? usageComponent() : null),
    },
    maxEntries: {
        type: OptionType.NUMBER,
        description: "How many favorite GIFs to keep on disk (default 500)",
        default: DEFAULT_MAX_ENTRIES,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    maxMegabytes: {
        type: OptionType.NUMBER,
        description: "Max total cache size in MB (default 500)",
        default: 500,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    // Path is only set via Choose folder button — keep store, hide text field
    cacheDirectory: {
        type: OptionType.STRING,
        description: "Cache folder path",
        default: "",
        hidden: true,
        onChange: () => settingsHooks.onCacheDirectoryChange(),
    },
    smartEviction: {
        type: OptionType.BOOLEAN,
        description: "When full, replace least-used GIFs for new favorites / sends. Off = never delete for new downloads",
        default: true,
        onChange: () => settingsHooks.onSmartEvictionChange(),
    },
    prefetchOnStart: {
        type: OptionType.BOOLEAN,
        description: "On start, download newest favorites first until cache reaches 1/3 of max capacity",
        default: true,
    },
    rewriteFavoriteSrc: {
        type: OptionType.BOOLEAN,
        description: "Point favorite thumbnails at local blob URLs when we have them cached",
        default: true,
    },
    showCacheBadges: {
        type: OptionType.BOOLEAN,
        description: "Dev: show LOCAL / BLOCKED badges on GIFs in the picker",
        default: false,
    },
});
