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

## License

GPL-3.0-or-later
