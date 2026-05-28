# nodeaitry.com Cloudflare-Native Mode

This project follows the public architecture described by missuo.me:

- Static site: Hugo on Cloudflare Pages
- Theme: PaperMod
- Image storage: Cloudflare R2
- CDN: Cloudflare
- Comment backend: Cloudflare Workers + D1
- Comment moderation: Telegram Bot
- Writing flow: Markdown files in `content/posts`, committed to Git, deployed by Cloudflare Pages

## Writing Flow

Create each article as a Hugo page bundle:

```txt
content/posts/my-post/index.md
content/posts/my-post/images/example.png
```

Write in any Markdown editor such as Obsidian, VS Code, or MWeb. Commit and push the Markdown source to GitHub. Cloudflare Pages builds the site from Git.

## Cloudflare Pages

Use GitHub integration and connect the repository.

Build settings:

```txt
Framework preset: Hugo
Build command: hugo --gc --minify
Build output directory: public
Root directory: /
```

Environment variables:

```txt
HUGO_VERSION=0.162.0
HUGO_ENV=production
```

Custom domain:

```txt
nodeaitry.com
www.nodeaitry.com
```

## Cloudflare R2

Recommended bucket and public domain:

```txt
Bucket: nodeaitry-images
Public domain: images.nodeaitry.com
```

Apply CORS from:

```txt
cloudflare/r2-cors.json
```

For a uPic-style flow, configure an S3-compatible uploader with:

```txt
Endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
Bucket: nodeaitry-images
Custom domain: https://images.nodeaitry.com
Path prefix: blog/
```

Then insert uploaded image URLs directly in Markdown.

## D1 Comments

Create a D1 database:

```sh
npx wrangler d1 create nodeaitry-comments
```

Copy the returned `database_id` into:

```txt
worker/wrangler.toml
```

Apply schema:

```sh
npm run db:migrate:remote
```

## Worker Comments API

Deploy:

```sh
npm run worker:deploy
```

Recommended route:

```txt
comments.nodeaitry.com/*
```

Set these secrets in Cloudflare:

```sh
cd worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_ADMIN_IDS
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put MODERATION_TOKEN
```

Set Telegram webhook:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://comments.nodeaitry.com/v1/telegram/<TELEGRAM_WEBHOOK_SECRET>" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

## Comment Behavior

The Worker implements the same public behavior described by missuo.me:

- `POST /v1/comments`: create comment
- `GET /v1/comments`: list approved comments with pagination
- `GET /v1/stats`: approved comment count
- `AUTO_APPROVE=false`: new comments are pending by default
- Telegram notification includes moderation buttons
- Reserved admin emails are blocked from public submission
- Telegram replies from admin accounts create approved admin replies
- D1 stores pages, comments, threading metadata, moderation status, Gravatar URL, user agent metadata, and best-effort IP metadata

## Required Values Before Production

Replace placeholders before deploying:

```txt
worker/wrangler.toml database_id
worker/wrangler.toml ADMIN_EMAILS
Cloudflare Pages GitHub repository
Cloudflare Pages custom domain
R2 bucket and custom domain
Telegram Bot Token
Telegram admin user ID
```
