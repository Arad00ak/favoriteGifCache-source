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
        description: "Storage",
        component: () => (usageComponent ? usageComponent() : null),
    },
    maxEntries: {
        type: OptionType.NUMBER,
        description: "Max number of GIFs to save",
        default: DEFAULT_MAX_ENTRIES,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    maxMegabytes: {
        type: OptionType.NUMBER,
        description: "Max space the cache can use (MB)",
        default: 500,
        onChange: () => settingsHooks.onLimitsChange(),
    },
    skipLargeFiles: {
        type: OptionType.BOOLEAN,
        description: "Don't save files bigger than 12 MB",
        default: true,
    },
    // set via Choose folder button only
    cacheDirectory: {
        type: OptionType.STRING,
        description: "Cache folder",
        default: "",
        hidden: true,
        onChange: () => settingsHooks.onCacheDirectoryChange(),
    },
    smartEviction: {
        type: OptionType.BOOLEAN,
        description: "When full, delete least-used GIFs to make room",
        default: true,
        onChange: () => settingsHooks.onSmartEvictionChange(),
    },
    prefetchOnStart: {
        type: OptionType.BOOLEAN,
        description: "Download some favorites in the background after Discord starts",
        default: true,
    },
    rewriteFavoriteSrc: {
        type: OptionType.BOOLEAN,
        description: "Load cached GIFs from disk instead of the internet",
        default: true,
    },
});
