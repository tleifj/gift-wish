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
- **Families.** Create a family and share the invite link (`/?invite=CODE`) or code. Each family can
  only see its own members' lists.

## Running it

Requires **Node.js 22.13+**. There are no dependencies: it uses Node's built-in `node:sqlite`.

```bash
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test           # API tests, including the no-spoilers rules
```

Configuration (environment variables):

| Variable         | Default               | Notes |
|------------------|-----------------------|-------|
| `PORT`           | `3000`                | |
| `DATABASE_FILE`  | `data/gift-wish.db`   | SQLite file. Back it up and keep it on persistent storage. |
| `SECURE_COOKIES` | `false`               | Set to `true` when serving over HTTPS. |

## Project layout

```
src/
  index.js    entry point (reads env, starts server)
  server.js   HTTP server, cookies, static files
  api.js      routes and the visibility rules (see present())
  auth.js     password hashing (scrypt), sessions, invite codes
  db.js       SQLite schema
public/       single-page front end (plain HTML/CSS/JS, no build step; Lucide icons vendored in icons.js)
test/         node:test API tests
```

## Ideas for later

- Belonging to more than one family group (for example your family and your partner's)
- Multiple lists per person (birthday, holidays) and occasion dates
- Splitting a gift between several people
- Secret items that others add to someone's list
- Email reminders and password reset
