import { openDatabase } from './db.js';
import { createAppServer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DATABASE_FILE || 'data/gift-wish.db';
const secureCookies = process.env.SECURE_COOKIES === 'true';

const db = openDatabase(dbFile);
createAppServer(db, { secureCookies }).listen(port, () => {
  console.log(`🎁 Gift Wish running at http://localhost:${port}  (database: ${dbFile})`);
});
