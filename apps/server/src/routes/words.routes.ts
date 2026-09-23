import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors.js';
import { now } from '../lib/ids.js';

/** Letters, marks, an apostrophe or a hyphen inside: a word, and nothing that is not one. */
const word = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[\p{L}][\p{L}\p{M}'’-]*$/u);
const MAX_WORDS = 5000;

/** The signed-in person's own additions to the spelling dictionary. */
export async function registerWordRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me/words', async (request) => {
    const user = await app.authenticate(request);
    const rows = app.db.prepare('SELECT word FROM user_words WHERE user_id = ? ORDER BY word').all(user.id) as {
      word: string;
    }[];
    return { words: rows.map((row) => row.word) };
  });

  app.post('/me/words', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await app.authenticate(request);
    const body = z.object({ word }).strict().parse(request.body);
    const count = app.db.prepare('SELECT COUNT(*) AS n FROM user_words WHERE user_id = ?').get(user.id) as { n: number };
    if (Number(count.n) >= MAX_WORDS) throw badRequest('Your word list is full');
    app.db
      .prepare('INSERT INTO user_words (user_id, word, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(user.id, body.word.replace(/’/gu, "'"), now());
    return reply.code(201).send({ ok: true });
  });

  app.delete('/me/words/:word', async (request) => {
    const user = await app.authenticate(request);
    const params = z.object({ word }).parse(request.params);
    app.db.prepare('DELETE FROM user_words WHERE user_id = ? AND word = ?').run(user.id, params.word);
    return { ok: true };
  });
}
