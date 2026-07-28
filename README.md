# FavoriteGifCache

Vencord / Equicord userplugin that keeps your Discord GIF picker favorites on disk so they open quickly.

Works on both Vencord and Equicord. Drop it in as a normal userplugin.

## What it does

Discord re-downloads favorite GIFs every time you open the picker. This plugin stores them in IndexedDB on your machine. After the first load, opening favorites uses local data.

The cache stays after you close Discord. Disabling the plugin only drops the in-memory layer; the on-disk store is left alone unless you clear site data yourself.

Default limit is 500 GIFs. At roughly a few hundred KB each that is usually well under a gigabyte, not multi-GB bloat.

When the cache is full:

- **Scrolling** the favorites grid does not kick anything out just to preview more GIFs. Free slots can still fill in the background.
- **Favoriting something new** downloads it and may replace the least-used cached GIF (or the least-used among ones you barely open).
- **Sending** a favorite that is not cached yet does the same: store it, and if full, drop least-used first.

Protected keys prefer to keep current Discord favorites when something must go.

## Install

1. Clone [Vencord](https://github.com/Vendicated/Vencord) or [Equicord](https://github.com/Equicord/Equicord) and set it up for development.
2. Copy this folder to:

   `src/userplugins/favoriteGifCache`

3. Build and inject as usual (`pnpm build`, then `pnpm inject` if needed).
4. Restart Discord and enable **FavoriteGifCache** under Plugins.

## Settings

- **Cache usage** — bars for GIF count and size (`X MB / 500 MB`), **Clear cache**, **Choose folder**, **Use default**
- **Max entries** — how many favorites to keep (default 500)
- **Max megabytes** — total size budget (default 500 MB)
- **Smart eviction** — when on, full cache can drop least-used GIFs for new favorites/sends; when off, nothing is deleted for new downloads
- **Prefetch on start** — after boot, download **newest** favorites first until the cache hits **1/3** of max capacity
- **Rewrite favorite src** — swap cached favorites onto local `blob:` URLs for display

### GIF picker

Right-click a GIF:

- **Cache GIF** — store it now (disabled if already cached). Clears any “never auto-cache” block for that GIF.
- **Remove from cache** — delete local copy and block auto/prefetch until you use **Cache GIF** again (disabled if not cached).

## Dev checks

No Discord needed for the pure cache tests:

```bash
npm install
npm test
npm run smoke
```

## Notes

First open of a brand-new favorite still needs the network once. Webpack renames in Discord can break the picker patch; if that happens, favorites fall back to normal remote loads instead of hard-failing the UI.

Downloads use the **desktop native helper** when possible (avoids Discord renderer CORS, which silently blocked caching before). Each file is capped (~12 MB) so giant videos are skipped; normal Tenor/Discord favorites still cache.
