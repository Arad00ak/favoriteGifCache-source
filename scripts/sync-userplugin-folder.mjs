/**
 * Copy modular plugin/ into an Equicord/Vencord userplugins/favoriteGifCache folder
 * (multi-file layout from the Equicord plugin-development docs).
 *
 * Usage:
 *   node scripts/sync-userplugin-folder.mjs [path-to-equicord-or-vencord-root]
 * Default: ../Equicord
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pluginSrc = path.join(root, "plugin");
const equicordRoot = path.resolve(process.argv[2] || path.join(root, "..", "Equicord"));
const dest = path.join(equicordRoot, "src", "userplugins", "favoriteGifCache");

if (!fs.existsSync(path.join(equicordRoot, "package.json"))) {
    console.error("Not an Equicord/Vencord root:", equicordRoot);
    process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(pluginSrc)) {
    fs.copyFileSync(path.join(pluginSrc, name), path.join(dest, name));
}
console.log("Synced", pluginSrc, "->", dest);
