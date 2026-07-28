# FavoriteGifCache (source)

Source monorepo for the FavoriteGifCache userplugin.

## User install (separate single-file repo)

Users do **not** clone this repo into `userplugins`.

Install package (root `index.tsx`, like other userplugins):

**https://github.com/Arad00ak/FavoriteGifCache-userplugin**

```bash
cd src/userplugins
git clone https://github.com/Arad00ak/FavoriteGifCache-userplugin FavoriteGifCache
```

Guide: https://discord.com/channels/1015060230222131221/1257038407503446176

## Layout

```
plugin/     # modular sources (edit here)
tests/
scripts/
  bundle-userplugin.mjs   # packs plugin/ → ../FavoriteGifCache-userplugin/index.tsx
```

## Develop

```bash
npm install
npm test
npm run smoke
npm run bundle:userplugin   # refresh the install package
```

## License

GPL-3.0-or-later
