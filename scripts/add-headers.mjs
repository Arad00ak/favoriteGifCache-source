import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "plugin");

const header = `/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Arad and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

`;

for (const name of fs.readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const p = path.join(dir, name);
    let src = fs.readFileSync(p, "utf8");
    if (src.includes("SPDX-License-Identifier")) {
        if (!src.startsWith("/*\n * Vencord, a Discord client mod")) {
            src = src.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
            src = header + src;
            fs.writeFileSync(p, src);
            console.log("normalized", name);
        } else {
            console.log("ok", name);
        }
        continue;
    }
    fs.writeFileSync(p, header + src);
    console.log("added", name);
}
