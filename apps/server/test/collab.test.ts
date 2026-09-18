import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { toPlainText, validateDoc, type PMNode } from '@docforge/model';
import { FRAGMENT, readShared, seedShared } from '../src/collab/convert.js';
import { authHeader, createAndLogin, makeApp, registerFirstAdmin, type TestActor } from './helpers.js';

const rich: PMNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1, styleId: 'Heading1' }, content: [{ type: 'text', text: 'Purpose' }] },
    {
      type: 'paragraph',
      attrs: { textAlign: 'justify', indentLeft: 720 },
      content: [
        { type: 'text', text: 'Kept for ' },
        { type: 'text', text: 'seven', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#c00000' } }] },
        { type: 'text', text: ' years', marks: [{ type: 'link', attrs: { href: 'https://example.invalid/' } }] },
        { type: 'wordInline', attrs: { ref: 'abc', kind: 'footnote', label: '1' } },
        { type: 'hardBreak' },
        { type: 'text', text: 'next line' },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: [120], background: '#ffc000' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }],
            },
          ],
        },
      ],
    },
    { type: 'bulletList', attrs: { numId: '3', listFormat: 'bullet' }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
    { type: 'pageBreak' },
    { type: 'paragraph' },
  ],
};

describe('the shared form of a document', () => {
  it('comes back out as the document that went in', () => {
    const shared = new Y.Doc();
    seedShared(shared, rich);
    expect(readShared(shared)).toEqual(rich);
  });

  it('is the form the browser binding reads, so both ends see one document', () => {
    // The server writes the shared document without the library the browser
    // reads it with. If the two ever disagree about the mapping, everybody
    // opens a document that is quietly not the one that was stored.
    const shared = new Y.Doc();
    seedShared(shared, rich);
    const read = yXmlFragmentToProsemirrorJSON(shared.getXmlFragment(FRAGMENT)) as PMNode;
    expect(toPlainText(read)).toBe(toPlainText(rich));
    expect(JSON.stringify(read)).toContain('"styleId":"Heading1"');
    expect(JSON.stringify(read)).toContain('"href":"https://example.invalid/"');
    expect(JSON.stringify(read)).toContain('"colwidth":[120]');
  });
});

describe('editing a document together', () => {
  let app: FastifyInstance;
  let base: string;
  let owner: TestActor;
  let editor: TestActor;
  let viewer: TestActor;
  let documentId: string;
  const open: WebsocketProvider[] = [];

  const paragraph = (text: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

  /** Join as somebody. The session travels as a header, as the cookie does from a browser. */
  const join = async (actor: TestActor, epoch = 1): Promise<{ doc: Y.Doc; provider: WebsocketProvider; closed: Promise<number> }> => {
    class Signed extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers: authHeader(actor) });
      }
    }
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${base}/api/collab`, `${documentId}.${epoch}`, doc, {
      WebSocketPolyfill: Signed as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    open.push(provider);
    const closed = new Promise<number>((resolve) => {
      provider.on('connection-close', (event: { code?: number } | null) => {
        if (event?.code && event.code >= 4000) {
          provider.shouldConnect = false;
          resolve(event.code);
        }
      });
    });
    await Promise.race([
      new Promise<void>((resolve) => provider.on('sync', (synced: boolean) => synced && resolve())),
      closed.then(() => undefined),
    ]);
    return { doc, provider, closed };
  };

  const type = (doc: Y.Doc, text: string): void => {
    const added = new Y.XmlElement('paragraph');
    added.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment(FRAGMENT).push([added]);
  };
  const until = async (check: () => boolean, ms = 4000): Promise<void> => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > ms) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const stored = async (): Promise<{ content: PMNode; revision: number; collab: { epoch: number } }> =>
    (await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: authHeader(owner) })).json().document;

  beforeEach(async () => {
    app = await makeApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    owner = await registerFirstAdmin(app);
    editor = await createAndLogin(app, owner, { email: 'ed@example.com', name: 'Edie Editor' });
    viewer = await createAndLogin(app, owner, { email: 'vi@example.com', name: 'Vic Viewer', role: 'viewer' });
    const created = await app.inject({
      method: 'POST', url: '/api/documents', headers: authHeader(owner),
      payload: { title: 'Shared', content: { type: 'doc', content: [paragraph('Opening line.')] } },
    });
    documentId = created.json().document.id;
    for (const [actor, permission] of [[editor, 'edit'], [viewer, 'view']] as const) {
      await app.inject({ method: 'PUT', url: `/api/documents/${documentId}/shares`, headers: authHeader(owner), payload: { userId: actor.id, permission } });
    }
  });

  afterEach(async () => {
    for (const provider of open.splice(0)) provider.destroy();
    await app.close();
  });

  it('shows each person what the other types, as they type it', async () => {
    const a = await join(owner);
    const b = await join(editor);
    expect(toPlainText(readShared(b.doc))).toBe('Opening line.');
    type(a.doc, 'From the owner.');
    type(b.doc, 'From the editor.');
    await until(() => toPlainText(readShared(a.doc)).includes('From the editor.') && toPlainText(readShared(b.doc)).includes('From the owner.'));
    expect(toPlainText(readShared(a.doc))).toBe(toPlainText(readShared(b.doc)));
  });

  it('writes what they typed into the stored document when the last of them leaves', async () => {
    const a = await join(owner);
    const before = (await stored()).revision;
    type(a.doc, 'Typed together.');
    await until(() => app.rooms.membersOf(documentId) === 1);
    a.provider.destroy();
    await until(() => app.rooms.membersOf(documentId) === 0);
    const after = await stored();
    expect(toPlainText(after.content)).toBe('Opening line.\nTyped together.');
    expect(after.revision).toBeGreaterThan(before);
    expect(validateDoc(after.content).ok).toBe(true);
  });

  it('lets somebody with view access watch, and drops anything they send to change it', async () => {
    const a = await join(owner);
    const v = await join(viewer);
    type(v.doc, 'A viewer should not be able to write this.');
    type(a.doc, 'The owner can.');
    await until(() => toPlainText(readShared(v.doc)).includes('The owner can.'));
    // Give the viewer's update every chance to arrive before looking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(toPlainText(readShared(a.doc))).not.toContain('viewer should not');
  });

  it('refuses somebody the document is not shared with, and somebody not signed in', async () => {
    const stranger = await createAndLogin(app, owner, { email: 'out@example.com', name: 'Sam Stranger' });
    expect(await (await join(stranger)).closed).toBe(4404);
    expect(await (await join({ ...owner, token: 'not-a-session' })).closed).toBe(4401);
  });

  it('tells a browser holding an old history to reload rather than merge it in', async () => {
    // A version is restored while somebody has the document open. Merging their
    // history into the restored text would put every paragraph in twice.
    const a = await join(owner);
    type(a.doc, 'Later work.');
    await until(() => app.rooms.membersOf(documentId) === 1);
    await app.inject({ method: 'POST', url: `/api/documents/${documentId}/versions/1/restore`, headers: authHeader(owner) });
    expect(await a.closed).toBe(4409);
    const next = await stored();
    expect(next.collab.epoch).toBe(2);
    expect(await (await join(owner, 1)).closed).toBe(4409);
    const fresh = await join(owner, 2);
    expect(toPlainText(readShared(fresh.doc))).toBe('Opening line.');
  });

  it('picks up where it left off after everybody has gone and come back', async () => {
    const a = await join(owner);
    type(a.doc, 'First sitting.');
    a.provider.destroy();
    await until(() => app.rooms.membersOf(documentId) === 0);
    const b = await join(editor);
    expect(toPlainText(readShared(b.doc))).toBe('Opening line.\nFirst sitting.');
  });
});
