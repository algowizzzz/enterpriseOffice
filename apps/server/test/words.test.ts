import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe("somebody's own spelling dictionary", () => {
  let app: FastifyInstance;
  let one: TestActor;
  let other: TestActor;
  const call = (actor: TestActor, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: authHeader(actor), ...(payload === undefined ? {} : { payload }) });
  beforeEach(async () => {
    app = await makeApp();
    one = await registerFirstAdmin(app);
    other = await createAndLogin(app, one, { email: 'b@example.com', name: 'Bea' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('remembers a word for the person who added it, and for nobody else', async () => {
    expect((await call(one, 'POST', '/api/me/words', { word: 'Okonkwo' })).statusCode).toBe(201);
    await call(one, 'POST', '/api/me/words', { word: 'Okonkwo' });
    expect((await call(one, 'GET', '/api/me/words')).json().words).toEqual(['Okonkwo']);
    expect((await call(other, 'GET', '/api/me/words')).json().words).toEqual([]);
  });

  it('forgets a word when asked', async () => {
    await call(one, 'POST', '/api/me/words', { word: 'Okonkwo' });
    await call(one, 'DELETE', '/api/me/words/Okonkwo');
    expect((await call(one, 'GET', '/api/me/words')).json().words).toEqual([]);
  });

  it('takes words, and nothing that is not one', async () => {
    for (const word of ['<script>', 'two words', 'x', '1234']) {
      expect((await call(one, 'POST', '/api/me/words', { word })).statusCode).toBe(400);
    }
  });
});
