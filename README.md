# nodeaitry.com

Hugo site for `nodeaitry.com`, built in the same Cloudflare-native pattern used by missuo.me:

- Static site: Hugo + PaperMod on Cloudflare Pages
- Image storage: Cloudflare R2
- CDN: Cloudflare
- Comment backend: Cloudflare Workers + D1
- Moderation: Telegram Bot

## Theme

The theme is pulled from:

https://github.com/adityatelange/hugo-PaperMod/

It lives in `themes/hugo-PaperMod`, matching the PaperMod example site layout.

## Local Development

PaperMod currently requires Hugo `v0.146.0+`.

```sh
npm run dev
```

## Build

```sh
npm run build
```

## Comments

Local comment API:

```sh
npm --prefix worker install
npm run db:migrate:local
npm run worker:dev
```

Production deployment details are in [docs/missuo-mode.md](docs/missuo-mode.md).
Secrets should be copied from [worker/.dev.vars.example](worker/.dev.vars.example) into Cloudflare Worker secrets.
Never commit real tokens.
