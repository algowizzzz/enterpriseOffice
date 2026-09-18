import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Peer } from '../collab/rooms.js';
import { accessFor } from '../services/documents.js';

const params = z.object({
  // "<document id>.<epoch>": the epoch is how a browser holding the history of
  // a document that has since been replaced is told to reload instead of merge.
  room: z.string().regex(/^[0-9a-f-]{36}\.\d{1,9}$/u),
});

/**
 * The socket a browser keeps open while it has a document open.
 *
 * Signed in like everything else, by the session cookie the browser sends with
 * the upgrade request. Somebody with view access joins and sees the others; what
 * they send to change the document is dropped by the room.
 */
export async function registerCollabRoutes(app: FastifyInstance): Promise<void> {
  app.get('/collab/:room', { websocket: true }, (socket, request) => {
    // Messages can arrive before the sign-in check has finished. They are held,
    // in order, rather than being lost or handled before anybody knows who sent them.
    const early: Uint8Array[] = [];
    let documentId: string | null = null;
    let joined = false;

    const peer: Peer = {
      send: (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      },
      close: (code, reason) => socket.close(code, reason),
    };

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const data = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (joined && documentId) app.rooms.receive(documentId, peer, bytes);
      else if (early.length < 64) early.push(bytes.slice());
    });
    socket.on('close', () => {
      if (joined && documentId) app.rooms.leave(documentId, peer);
    });
    socket.on('error', () => socket.close());

    void (async () => {
      try {
        const user = await app.authenticate(request);
        const parsed = params.safeParse(request.params);
        if (!parsed.success) return socket.close(4400, 'Not a document.');
        const [id, epoch] = parsed.data.room.split('.') as [string, string];
        const access = accessFor(app.db, id, user);
        if (access === 'none') return socket.close(4404, 'That document is not there.');
        documentId = id;
        joined = app.rooms.join(id, Number(epoch), peer, {
          user: { id: user.id, role: user.role, name: user.name },
          canWrite: access === 'owner' || access === 'edit',
        });
        if (!joined) return undefined;
        for (const bytes of early.splice(0)) app.rooms.receive(id, peer, bytes);
        return undefined;
      } catch {
        return socket.close(4401, 'Sign in first.');
      }
    })();
  });
}
