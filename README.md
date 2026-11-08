# Gift Wish

A family gift wish list app. Everyone makes a wish list with links to where to buy each thing.
Everyone else in the family can see it and mark **"I'll get this"**, then **"Mark bought"**, so nobody
buys the same gift twice. **The list owner never sees who is buying what.** No spoilers.

## How it works

| You are…                    | You can…                                                                 |
|-----------------------------|--------------------------------------------------------------------------|
| Looking at **your own list** | Add, edit and remove wishes (title, link, price, notes, how much you want it). You see **no** claim info. |
| Looking at **someone else's list** | See every item's status: free, *Dad is getting this*, or ~~bought by Kid~~. Claim an item, mark it bought, or release your claim. |
| On **My shopping**          | See everything you've claimed, grouped by person, and what's still left to buy. |

Details:

- **No spoilers, enforced by the server.** Claim data is removed from API responses for the owner's own
  items, so it can't be found in browser dev tools either. Owners also can't claim or unclaim their own items.
- **No double-buying.** Each item can be claimed by one person. Others see who has it, and only that
  person can release it.
- **Removed items.** If the owner removes an item someone already claimed or bought, that person sees
  "Removed from the list" (so they know to return it or pick something else). The owner gets the same
  response either way, so removing something doesn't tell them whether it was claimed.
- **Import from Amazon.** On your list, choose *Import from Amazon* and paste a public or shared wish list
  link. You'll see every item (name, price, link, Amazon priority and comment), can uncheck or rename
  anything, and only then are they added. Items already on your list are unchecked. If Amazon blocks the
  request (it sometimes shows a robot check to servers), paste product links instead, or save the wish list
  page from your browser and upload it.
- **Families.** Create a family and share the invite link (`/?invite=CODE`) or code. Each family can
  only see its own members' lists.

## How it runs

The app runs on **Cloudflare Workers** with a **D1** database (Cloudflare's hosted SQLite).

- `public/` is served as static files. Only requests to `/api/*` run the Worker (`src/worker.js`).
- All data lives in the D1 database `gift-wish`. Deploying new code never touches it.
- Schema changes are numbered files in `migrations/`. `npm run deploy` applies any new ones
  before deploying the code.

## Deploying from GitHub (Workers Builds)

1. In the Cloudflare dashboard, go to **Workers & Pages**, choose **Create**, then **Import a repository**,
   and pick this repo and the branch to deploy.
2. Leave the build command empty, and set the **deploy command** to:
   ```
   npm run deploy
   ```
   (The default, `npx wrangler deploy`, would skip the database migrations.)
3. Deploy. On the first deploy, Wrangler creates the `gift-wish` D1 database and the tables.
   After that, every push to the branch redeploys the app and keeps the data.

Your family can then use the `*.workers.dev` address Cloudflare shows, or you can add your own domain
under the Worker's **Settings > Domains & Routes**.

**Plan note:** passwords are hashed with PBKDF2 (100,000 rounds), which can take more than the free plan's
10 ms of CPU per request. If sign-in or sign-up sometimes fails with a "CPU time exceeded" error on the free
plan, the Workers Paid plan ($5/month) fixes it.

**Backups:** D1 Time Travel can restore the database to any point in the last 7 days (30 days on the paid plan):
`npx wrangler d1 time-travel restore gift-wish --timestamp=<when>`.

## Developing locally

Requires **Node.js 22+**.

```bash
npm install
npm run dev        # creates a local D1 database, then serves http://localhost:8787
npm test           # runs the Worker in Miniflare against a fresh database
```

Local data is kept in `.wrangler/` (not committed). Changing the schema: add `migrations/0002_....sql`,
then `npm run db:migrate:local` to apply it locally. `npm run deploy` applies it to the live database.

## Project layout

```
src/
  worker.js   Worker entry: cookies, request parsing, hands /api/* to api.js
  api.js      routes and the visibility rules (see present())
  amazon.js   reads Amazon wish lists, pasted links and saved pages for import
  auth.js     password hashing (PBKDF2 via Web Crypto), sessions, invite codes
migrations/   D1 schema, one numbered SQL file per change
scripts/      deploy.mjs: apply migrations, then deploy
public/       single-page front end (plain HTML/CSS/JS, no build step; Lucide icons vendored in icons.js)
test/         node:test tests; helpers.js starts the Worker in Miniflare
wrangler.jsonc  Cloudflare config (static assets, D1 binding)
```

## Ideas for later

- Belonging to more than one family group (for example your family and your partner's)
- Multiple lists per person (birthday, holidays) and occasion dates
- Splitting a gift between several people
- Secret items that others add to someone's list
- Email reminders and password reset
