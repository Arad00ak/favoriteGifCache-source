# FavoriteGifCache

Caches Discord GIF picker favorites on disk so they load faster.

Works on **Equicord** and **Vencord** (userplugin).

## Install

Full userplugin guide:  
https://discord.com/channels/1015060230222131221/1257038407503446176

1. Open a terminal in your client mod’s `userplugins` folder:

   ```bash
   cd src/userplugins
   ```

2. Clone this repo:

   ```bash
   git clone https://github.com/Arad00ak/FavoriteGifCache
   ```

3. Rebuild and inject (e.g. `pnpm build` / your usual inject step).
4. Restart Discord.
5. Enable **FavoriteGifCache** under Plugins.

One plugin per repo — `index.tsx` is at the **repository root**, so a plain clone into `userplugins` is enough.

## What it does

- Saves favorite GIF media locally (IndexedDB by default, or a folder you pick on desktop)
- Survives Discord restarts
- Cap: ~500 entries / ~500 MB (settings)
- Prefetch on start: newest favorites first, until about **1/3** of max capacity
- Scroll does not thrash the cache when full
- Smart eviction (optional): replace least-used when full for new favorites/sends
- Right-click a GIF: **Cache GIF** / **Remove from cache** (remove also blocks auto-cache until you cache it again)

Right-click menu needs **ExtraContextMenusAPI** (ships with Equicord as a required API plugin).

## Settings

- **Cache usage** — size/count bars, clear cache, choose folder / use default
- **Max entries** / **Max megabytes**
- **Smart eviction**
- **Prefetch on start**
- **Rewrite favorite src** — use local `blob:` URLs when cached

## Notes

- First time a GIF is cached it still needs a network download.
- Files over ~12 MB are skipped so huge clips do not fill the cache.
- Downloads prefer the desktop native helper (avoids renderer CORS issues).
- No external API keys; media is loaded from the same hosts Discord/Tenor already use for the picker.
- Patches can break when Discord updates; failures fall back to normal remote loading.

## Dev (optional)

Not required to install the plugin.

```bash
npm install
npm test
npm run smoke
```

## License

GPL-3.0-or-later
