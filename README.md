# FavoriteGifCache

Equicord / Vencord userplugin. Keeps your Discord GIF picker favorites on your machine so they don't have to re-download every time you open the picker.

## Install (users)

Do not clone **this** repo into `userplugins`. Use the install package (single `index.tsx` + `native.ts`):

https://github.com/Arad00ak/FavoriteGifCache-userplugin

That repo’s README has step-by-step install for Equicord and Vencord.

## How it works

Discord only stores a list of favorite GIF URLs. The actual files still come from Tenor/Discord CDN every time.

This plugin:

1. Downloads those files once
2. Saves them locally (IndexedDB by default, or a folder you pick on desktop)
3. Next time the picker opens, swaps the remote `src` for a local `blob:` URL when we already have the file

So the first view can still hit the network. After that, hits should be local and faster.

### On startup (if prefetch is on)

It walks your favorites from newest to older and downloads until the cache hits about **1/3** of max size (default 500 MB → ~167 MB). It does not fill the whole cache on boot on purpose.

### When you're using the picker

- **Scroll:** only fills free space. If the cache is full, it does not kick old stuff just because you scrolled.
- **New favorite / send:** can store the GIF. If the cache is full and smart eviction is on, it drops the least-used one first.
- **Right-click:** Cache GIF or Remove from cache. Remove also blocks auto-cache for that URL until you Cache it again.

### Desktop bits

`native.ts` runs in Electron (not the Discord page). That's used for:

- choosing a cache folder
- downloading media without renderer CORS issues

Without native helpers, it still falls back to IndexedDB + normal fetch.

### Tenor → Klipy

Favorites still pointing at Tenor media hosts are tried first. If the download fails (Tenor going away), the plugin retries the **same path** on Klipy CDN hosts (`media.klipy.com`, etc.) and stores under the original favorite key so the picker still resolves. New Discord favorites that already use Klipy URLs are cached the same way as Tenor/Giphy.

## This repo vs install repo

| Repo | Purpose |
|------|---------|
| **This one** | Source, tests, bundler |
| **FavoriteGifCache-userplugin** | What people clone into `userplugins` (`index.tsx` at root) |

Edit files under `plugin/`, then:

```bash
npm run bundle:userplugin
```

That rebuilds the single-file package in `../FavoriteGifCache-userplugin`.

## Dev

```bash
npm install
npm test
npm run smoke
```

## License

GPL-3.0-or-later
