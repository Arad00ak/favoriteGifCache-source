# FavoriteGifCache (source)

Development / source monorepo for the FavoriteGifCache Equicord & Vencord userplugin.

**Install for users** is a **separate** repo (plugin files only at the root for `git clone` into `userplugins`).

User install repo: https://github.com/Arad00ak/FavoriteGifCache-userplugin  
(If that URL is not up yet, create it and push from `../FavoriteGifCache-userplugin`.)

Install guide (Equicord):  
https://discord.com/channels/1015060230222131221/1257038407503446176

## Layout

```
plugin/          # userplugin sources (synced to the install repo)
tests/           # unit tests
scripts/         # smoke runner
package.json
```

## Develop

```bash
npm install
npm test
npm run smoke
```

Copy or symlink `plugin/` into an Equicord/Vencord tree:

```text
src/userplugins/FavoriteGifCache  →  contents of plugin/
```

Or clone the **userplugin** install repo into `src/userplugins` (recommended for end users).

## License

GPL-3.0-or-later
