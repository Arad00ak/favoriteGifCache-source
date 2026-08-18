# FavoriteGifCache

Equicord / Vencord userplugin. Keeps your Discord GIF picker favorites on your machine so they don't have to re-download every time you open the picker.

## Install (users)

Don't clone this repo into `userplugins`. Use the install package:

https://github.com/Arad00ak/favoriteGifCache

```bash
cd src/userplugins
git clone https://github.com/Arad00ak/favoriteGifCache favoriteGifCache
```

Then rebuild, restart Discord, and turn the plugin on.

More detail: https://discord.com/channels/1015060230222131221/1257038407503446176

## How it works

Discord only stores a list of favorite GIF URLs. The actual files still come from Tenor/Discord CDN every time.

This plugin:

1. Downloads those files once
2. Saves them locally (IndexedDB by default, or a folder you pick on desktop)
3. Next time the picker opens, swaps the remote `src` for a local `blob:` URL when we already have the file

So the first view can still hit the network. After that, hits should be local and faster.

### On startup (if prefetch is on)

It walks your favorites from newest to older once and stops when the cache reaches its configured size limit.

### When you're using the picker

- **Scroll:** only fills free space. If the cache is full, it does not kick old stuff just because you scrolled.
- **New favorite / send:** can store the GIF. If the cache is full and smart eviction is on, it drops the least-used one first.
- **Right-click:** Cache GIF or Remove from cache. Remove also blocks auto-cache for that URL until you Cache it again.

## License

GPL-3.0-or-later
