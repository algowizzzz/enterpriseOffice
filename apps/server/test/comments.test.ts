import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync } from 'fflate';
import { anchorFor, locateAnchor, textBlocks, type PMNode } from '@docforge/model';
import { exportDocx } from '../src/docx/export.js';
import { importDocx } from '../src/docx/import.js';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

const paragraph = (text: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });

describe('where a comment is attached', () => {
  const policy = doc(
    paragraph('Records are kept for seven years.'),
    paragraph('Exceptions are kept for seven years too, with written approval.'),
  );

  it('finds the same words again', () => {
    const blocks = textBlocks(policy);
    const anchor = anchorFor(blocks, 1, 24, 35);
    expect(anchor?.quote).toBe('seven years');
    expect(locateAnchor(blocks, anchor!)).toEqual({ block: 1, from: 24, to: 35 });
  });

  it('tells two occurrences of the same words apart by what stands around them', () => {
    // Both paragraphs say "seven years". A comment on the second must not
    // drift to the first because the first comes first.
    const blocks = textBlocks(policy);
    const second = anchorFor(blocks, 1, 24, 35)!;
    // A paragraph is inserted above, so the block number is now wrong as well.
    const edited = textBlocks(doc(paragraph('New opening paragraph.'), ...(policy.content ?? [])));
    expect(locateAnchor(edited, second)).toEqual({ block: 2, from: 24, to: 35 });
  });

  it('survives an edit elsewhere in the same paragraph', () => {
    const anchor = anchorFor(textBlocks(policy), 0, 21, 32)!;
    const edited = textBlocks(doc(paragraph('All financial records are kept for seven years.')));
    const found = locateAnchor(edited, anchor);
    expect(edited[0]?.text.slice(found!.from, found!.to)).toBe('seven years');
  });

  it('reports a comment as detached when its words have been rewritten', () => {
    const anchor = anchorFor(textBlocks(policy), 0, 21, 32)!;
    expect(locateAnchor(textBlocks(doc(paragraph('Records are kept for a decade.'))), anchor)).toBeNull();
  });

  it('refuses to anchor to a picture or to nothing', () => {
    const withBreak = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'ab' }, { type: 'hardBreak' }, { type: 'text', text: 'cd' }],
    });
    expect(anchorFor(textBlocks(withBreak), 0, 1, 4)).toBeNull();
    expect(anchorFor(textBlocks(withBreak), 0, 1, 1)).toBeNull();
  });
});

describe('comments', () => {
  let app: FastifyInstance;
  let owner: TestActor;
  let reviewer: TestActor;
  let stranger: TestActor;
  let documentId: string;

  const call = (actor: TestActor, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: authHeader(actor), ...(payload === undefined ? {} : { payload }) });

  beforeEach(async () => {
    app = await makeApp();
    owner = await registerFirstAdmin(app);
    reviewer = await createAndLogin(app, owner, { email: 'rev@example.com', name: 'Rae Reviewer', role: 'viewer' });
    stranger = await createAndLogin(app, owner, { email: 'out@example.com', name: 'Sam Stranger' });
    const created = await call(owner, 'POST', '/api/documents', {
      title: 'Policy',
      content: doc(paragraph('Records are kept for seven years.')),
    });
    documentId = created.json().document.id;
    await call(owner, 'PUT', `/api/documents/${documentId}/shares`, { userId: reviewer.id, permission: 'view' });
  });

  afterEach(async () => {
    await app.close();
  });

  const anchor = { quote: 'seven years', prefix: 'Records are kept for ', suffix: '.', block: 0 };

  it('lets somebody who can only view the document comment on it', async () => {
    // The person asked to review a policy is very often somebody who must not
    // be able to change it. Requiring edit access to comment would have sent
    // every such review back to email.
    const added = await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, {
      body: 'Should this be ten?',
      anchor,
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().comment).toMatchObject({ authorName: 'Rae Reviewer', anchor, mine: true });
  });

  it('does not move the document on, so nobody else loses a save to it', async () => {
    const before = (await call(owner, 'GET', `/api/documents/${documentId}`)).json().document.revision;
    await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'A comment', anchor });
    const after = (await call(owner, 'GET', `/api/documents/${documentId}`)).json().document.revision;
    expect(after).toBe(before);
  });

  it('keeps replies under the comment they answer, and a reply to a reply in the same thread', async () => {
    const first = (await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Why seven?', anchor })).json().comment;
    const reply = (await call(owner, 'POST', `/api/documents/${documentId}/comments`, { body: 'Statute.', parentId: first.id })).json().comment;
    await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Which one?', parentId: reply.id });
    const { threads } = (await call(owner, 'GET', `/api/documents/${documentId}/comments`)).json();
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((entry: { body: string }) => entry.body)).toEqual(['Statute.', 'Which one?']);
  });

  it('takes a comment on the document as a whole, with no words under it', async () => {
    const added = await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Overall: needs an owner.' });
    expect(added.json().comment.anchor).toBeNull();
  });

  it('lets anybody in the thread resolve it, and reopen it', async () => {
    const first = (await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Fix this', anchor })).json().comment;
    const resolved = await call(owner, 'PATCH', `/api/documents/${documentId}/comments/${first.id}`, { resolved: true });
    expect(resolved.json().comment.resolvedAt).not.toBeNull();
    const reopened = await call(reviewer, 'PATCH', `/api/documents/${documentId}/comments/${first.id}`, { resolved: false });
    expect(reopened.json().comment.resolvedAt).toBeNull();
  });

  it('lets only its author change the words of a comment', async () => {
    const first = (await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Mine', anchor })).json().comment;
    expect((await call(owner, 'PATCH', `/api/documents/${documentId}/comments/${first.id}`, { body: 'Not mine' })).statusCode).toBe(403);
    expect((await call(reviewer, 'PATCH', `/api/documents/${documentId}/comments/${first.id}`, { body: 'Still mine' })).statusCode).toBe(200);
  });

  it('removes the whole thread with its first comment', async () => {
    const first = (await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'One', anchor })).json().comment;
    await call(owner, 'POST', `/api/documents/${documentId}/comments`, { body: 'Two', parentId: first.id });
    expect((await call(reviewer, 'DELETE', `/api/documents/${documentId}/comments/${first.id}`)).statusCode).toBe(200);
    expect((await call(owner, 'GET', `/api/documents/${documentId}/comments`)).json().threads).toEqual([]);
  });

  it('hides a document, and its comments, from somebody it is not shared with', async () => {
    await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Private', anchor });
    expect((await call(stranger, 'GET', `/api/documents/${documentId}/comments`)).statusCode).toBe(404);
    expect((await call(stranger, 'POST', `/api/documents/${documentId}/comments`, { body: 'x' })).statusCode).toBe(404);
  });

  it('refuses an empty comment and one signed by somebody else', async () => {
    expect((await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: '   ' })).statusCode).toBe(400);
    // The route does not accept a name at all: a comment is signed by its session.
    const forged = await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'x', authorName: 'The Chair' });
    expect(forged.statusCode).toBe(400);
  });

  it('records each comment in the audit trail', async () => {
    await call(reviewer, 'POST', `/api/documents/${documentId}/comments`, { body: 'Logged', anchor });
    const { entries } = (await call(owner, 'GET', '/api/audit')).json();
    expect(entries.some((entry: { action: string }) => entry.action === 'comment.added')).toBe(true);
  });
});

describe('comments through Word', () => {
  const body = doc(paragraph('Records are kept for seven years.'), paragraph('Second paragraph.'));
  const threads = [
    {
      author: 'Rae Reviewer',
      date: '2026-09-18T10:00:00.000Z',
      body: 'Should this be ten?\nThe statute changed.',
      anchor: { quote: 'seven years', prefix: 'Records are kept for ', suffix: '.', block: 0 },
      resolved: true,
      replies: [{ author: 'Ada Admin', date: '2026-09-18T11:00:00.000Z', body: 'Agreed, changing it.' }],
    },
    { author: 'Ada Admin', date: '2026-09-18T12:00:00.000Z', body: 'Whole document: add an owner.', anchor: null, resolved: false, replies: [] },
  ];

  it('writes them where Word keeps comments, on the words they were made on', async () => {
    const parts = unzipSync(new Uint8Array(await exportDocx(body, { title: 'T', comments: threads })));
    const main = strFromU8(parts['word/document.xml']!);
    expect(main).toMatch(/<w:commentRangeStart w:id="0"\/>.*seven years.*<w:commentRangeEnd w:id="0"\/>/su);
    const comments = strFromU8(parts['word/comments.xml']!);
    expect(comments).toContain('w:author="Rae Reviewer"');
    expect(comments).toContain('The statute changed.');
    expect(strFromU8(parts['word/commentsExtended.xml']!)).toMatch(/w15:paraIdParent=/u);
    expect(strFromU8(parts['[Content_Types].xml']!)).toContain('comments+xml');
  });

  it('reads them back as the same threads, signed and resolved as they were', async () => {
    const back = await importDocx(await exportDocx(body, { title: 'T', comments: threads }));
    const first = back.comments?.find((comment) => comment.body.startsWith('Should this'));
    expect(first).toMatchObject({ author: 'Rae Reviewer', resolved: true, parentWordId: null });
    expect(first?.anchor?.quote).toBe('seven years');
    expect(first?.body).toBe('Should this be ten?\nThe statute changed.');
    const reply = back.comments?.find((comment) => comment.body === 'Agreed, changing it.');
    expect(reply?.parentWordId).toBe(first?.wordId);
    // And the text is the text: no marker is left in it.
    expect(JSON.stringify(back.content)).not.toContain('__comment');
    expect(textBlocks(back.content)[0]?.text).toBe('Records are kept for seven years.');
  });

  it('removes the comments part when the last comment has gone', async () => {
    const withComments = await exportDocx(body, { title: 'T', comments: threads });
    const imported = await importDocx(withComments);
    const parts = unzipSync(
      new Uint8Array(await exportDocx(imported.content, { title: 'T', source: withComments, fragments: imported.fragments, comments: [] })),
    );
    expect(parts['word/comments.xml']).toBeUndefined();
    expect(strFromU8(parts['word/document.xml']!)).not.toContain('commentRangeStart');
  });
});
