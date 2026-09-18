import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

describe('authentication', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await makeApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports that a fresh instance needs setup', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ needsSetup: true });
  });

  it('makes the first registered account an administrator', async () => {
    const admin = await registerFirstAdmin(app);
    expect(admin.role).toBe('admin');

    const bootstrap = await app.inject({ method: 'GET', url: '/api/auth/bootstrap' });
    expect(bootstrap.json()).toEqual({ needsSetup: false });
  });

  it('closes registration once an account exists', async () => {
    await registerFirstAdmin(app);
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'intruder@example.com', name: 'Intruder', password: 'Correct-Horse-9' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.message).toMatch(/Registration is closed/u);
  });

  it('rejects a weak password at registration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'weak@example.com', name: 'Weak', password: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/at least 12 characters/u);
  });

  it('rejects a malformed email address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', name: 'Nobody', password: 'Correct-Horse-9' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('signs in with correct credentials and sets an http-only cookie', async () => {
    await registerFirstAdmin(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'Correct-Horse-9' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().token).toBeTypeOf('string');
    const cookie = response.cookies.find((c) => c.name === 'docforge_session');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('strict');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await registerFirstAdmin(app);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'Wrong-Horse-9999' },
    });
    const unknownUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@example.com', password: 'Wrong-Horse-9999' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
  });

  it('matches an email address regardless of case', async () => {
    await registerFirstAdmin(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ADMIN@Example.COM', password: 'Correct-Horse-9' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses unauthenticated access to protected endpoints', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a fabricated bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/documents',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const admin = await registerFirstAdmin(app);
    const before = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(admin),
    });
    expect(before.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: authHeader(admin) });

    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(admin),
    });
    expect(after.statusCode).toBe(401);
  });

  it('changes a password and revokes existing sessions', async () => {
    const admin: TestActor = await registerFirstAdmin(app);
    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: authHeader(admin),
      payload: { currentPassword: 'Correct-Horse-9', newPassword: 'Another-Horse-42' },
    });
    expect(change.statusCode).toBe(200);

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(admin),
    });
    expect(oldSession.statusCode).toBe(401);

    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'Another-Horse-42' },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('rejects a password change with the wrong current password', async () => {
    const admin = await registerFirstAdmin(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: authHeader(admin),
      payload: { currentPassword: 'Not-The-Password-1', newPassword: 'Another-Horse-42' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a body-less POST that declares a JSON content type', async () => {
    // Regression: the browser client sets a JSON content type on every request.
    // Sign out sends no body, and rejecting that broke sign out in the real app.
    const admin = await registerFirstAdmin(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...authHeader(admin), 'content-type': 'application/json' },
      payload: '',
    });
    expect(response.statusCode).toBe(200);
  });

  it('still rejects a body that is not valid JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
  });

  it('serves a health check without authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});
