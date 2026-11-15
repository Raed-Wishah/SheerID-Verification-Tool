import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const PACKS = [3, 10, 25];
const TICKET_TTL_MS = 15 * 60 * 1000;

function ticketHash(ticket) {
  return createHash('sha256').update(ticket).digest('hex');
}

export function validTicket(ticket) {
  return typeof ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ticket);
}

export class CreditStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS wallets (
        user_id INTEGER PRIMARY KEY,
        balance INTEGER NOT NULL CHECK (balance >= 0)
      );
      CREATE TABLE IF NOT EXISTS shop_tickets (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        credits INTEGER
      );
      CREATE TABLE IF NOT EXISTS exercises (
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        scenario TEXT NOT NULL,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        PRIMARY KEY (user_id, message_id)
      );
    `);
  }

  balance(userId) {
    return this.db.prepare('SELECT balance FROM wallets WHERE user_id = ?')
      .get(userId)?.balance ?? 0;
  }

  issueTicket(userId, now = Date.now()) {
    const ticket = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM shop_tickets WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO shop_tickets VALUES (?, ?, ?, NULL)')
      .run(ticketHash(ticket), userId, now + TICKET_TTL_MS);
    return ticket;
  }

  findTicket(ticket, now) {
    if (!validTicket(ticket)) return null;
    return this.db.prepare('SELECT user_id, credits FROM shop_tickets WHERE token_hash = ? AND expires_at > ?')
      .get(ticketHash(ticket), now) ?? null;
  }

  shopStatus(ticket, now = Date.now()) {
    const record = this.findTicket(ticket, now);
    return record && { credits: record.credits, balance: this.balance(record.user_id) };
  }

  redeem(ticket, credits, now = Date.now()) {
    if (!PACKS.includes(credits)) throw new RangeError('Unknown demo pack');

    return this.transaction(() => {
      const record = this.findTicket(ticket, now);
      if (!record) return null;

      if (record.credits === null) {
        this.db.prepare(`
          INSERT INTO wallets (user_id, balance) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance
        `).run(record.user_id, credits);
        this.db.prepare('UPDATE shop_tickets SET credits = ? WHERE token_hash = ?')
          .run(credits, ticketHash(ticket));
      }

      return { credits: record.credits ?? credits, balance: this.balance(record.user_id) };
    });
  }

  runExercise(userId, messageId, scenario) {
    return this.transaction(() => {
      let exercise = this.db.prepare('SELECT scenario, completed FROM exercises WHERE user_id = ? AND message_id = ?')
        .get(userId, messageId);

      if (!exercise) {
        const debit = this.db.prepare('UPDATE wallets SET balance = balance - 1 WHERE user_id = ? AND balance > 0')
          .run(userId);
        exercise = { scenario, completed: debit.changes };
        this.db.prepare('INSERT INTO exercises VALUES (?, ?, ?, ?)')
          .run(userId, messageId, scenario, exercise.completed);
      }

      return { ...exercise, balance: this.balance(userId) };
    });
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
