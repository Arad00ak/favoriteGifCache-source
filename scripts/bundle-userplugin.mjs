import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pluginDir = path.join(root, "plugin");
const destDir = path.resolve(root, "..", "FavoriteGifCache-userplugin");

const order = [
    "cacheCore.ts",
    "storage.ts",
    "gifCache.ts",
    "favorites.ts",
    "denylist.ts",
    "nativeApi.ts",
    "media.ts",
    "cacheAccess.ts",
    "settings.ts",
    "CacheUsageBar.tsx",
    "index.tsx",
];

function stripModule(src, filename) {
    let s = src.replace(/\r\n/g, "\n");
    s = s.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
    // remove imports
    s = s.replace(/^import\s[\s\S]*?from\s["'][^"']+["'];?\s*$/gm, "");
    s = s.replace(/^import\s["'][^"']+["'];?\s*$/gm, "");
    s = s.replace(/^export\s\{[^}]*\}\sfrom\s["'][^"']+["'];?\s*$/gm, "");
    s = s.replace(/^export\s\*\sfrom\s["'][^"']+["'];?\s*$/gm, "");
    if (filename !== "index.tsx") {
        s = s.replace(/^export\s+default\s+/gm, "");
    }
    s = s.replace(/^export\s\{[^}]+\};?\s*$/gm, "");
    s = s.replace(/^export\s+(async\s+)?function\b/gm, "$1function");
    s = s.replace(/^export\s+class\b/gm, "class");
    s = s.replace(/^export\s+const\b/gm, "const");
    s = s.replace(/^export\s+let\b/gm, "let");
    s = s.replace(/^export\s+var\b/gm, "var");
    s = s.replace(/^export\s+enum\b/gm, "enum");
    s = s.replace(/^export\s+type\b/gm, "type");
    s = s.replace(/^export\s+interface\b/gm, "interface");
    // denylist uses DataStore namespace import — keep usage, import is top-level
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim() + "\n";
}

const parts = [];
parts.push(`/*
 * Vencord / Equicord userplugin — FavoriteGifCache
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Single-file install. Source: https://github.com/Arad00ak/FavoriteGifCache
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import type { PluginNative } from "@utils/types";
import { Menu, Toasts, useEffect, useState } from "@webpack/common";

`);

for (const file of order) {
    const full = path.join(pluginDir, file);
    const src = fs.readFileSync(full, "utf8");
    parts.push(`// ----- ${file} -----\n`);
    parts.push(stripModule(src, file));
    parts.push("\n");
}

fs.mkdirSync(destDir, { recursive: true });
const outPath = path.join(destDir, "index.tsx");
const out = parts.join("");
fs.writeFileSync(outPath, out);

// native.ts is Vencord's separate Node entry (not a plugin module folder)
fs.copyFileSync(path.join(pluginDir, "native.ts"), path.join(destDir, "native.ts"));

// remove leftover multi-file sources from install package if any
for (const name of fs.readdirSync(destDir)) {
    if (["index.tsx", "native.ts", "README.md", "LICENSE", ".git", ".gitignore"].includes(name)) continue;
    const p = path.join(destDir, name);
    fs.rmSync(p, { recursive: true, force: true });
}

console.log("Wrote", outPath, `(${out.split("\n").length} lines)`);
console.log("Wrote native.ts + cleaned install package");
