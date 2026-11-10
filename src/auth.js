// Passwords, sessions and invite codes, using only Web Crypto (available in Workers).

const SESSION_DAYS = 60;
// Workers caps PBKDF2 at 100,000 iterations. The count is stored in each hash,
// so it can be changed later without breaking existing passwords.
const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'pbkdf2-sha256' || !saltHex || !hashHex) return false;
  const expected = fromHex(hashHex);
  const actual = new Uint8Array(await pbkdf2(password, fromHex(saltHex), Number(iter)));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** A random, URL-safe secret (256 bits). */
export function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Hex SHA-256, used to store reset-link secrets without storing the secrets themselves. */
export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function createSession(db, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function userFromSession(db, token) {
  if (!token) return null;
  return db.get(
    `SELECT u.id, u.name, u.email, u.family_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`,
    token,
    new Date().toISOString()
  );
}

export async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', token);
}

/** Signs a person out on every device. */
export async function destroyAllSessions(db, userId) {
  await db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// Human-friendly invite codes: no 0/O/1/I confusion.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeInviteCode(length = 8) {
  let code = '';
  for (const b of crypto.getRandomValues(new Uint8Array(length))) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}
