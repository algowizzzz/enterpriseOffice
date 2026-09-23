/**
 * Rooms: one shared document per open file, kept in memory while anybody has it
 * open, and written back into the ordinary stored form as people work.
 *
 * The stored form stays the truth. The exporter, the validator, the version
 * history, the comments and the comparison all read the JSON snapshot and know
 * nothing about this file. A room is how several people arrive at the next
 * snapshot together; when the last of them leaves it is written down and gone.
 */
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { repairDocument, validateDoc } from '@docforge/model';
import type { Database } from '../db.js';
import { now } from '../lib/ids.js';
import { updateDocument } from '../services/documents.js';
import { savePictures, takePicturesOut } from '../services/media.js';
import type { Role } from '../services/users.js';
import { readShared, seedShared } from './convert.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Write a snapshot this long after the typing stops, and at least this often while it does not. */
const SNAPSHOT_IDLE_MS = 3000;
const SNAPSHOT_MAX_MS = 30000;

/** Close codes the browser acts on. */
export const CLOSE_STALE = 4409;
export const CLOSE_GONE = 4404;

export interface Peer {
  send: (data: Uint8Array) => void;
  close: (code: number, reason: string) => void;
}

interface Member {
  user: { id: string; role: Role; name: string };
  canWrite: boolean;
  /** Awareness clients this connection has announced, to retire when it goes. */
  clients: Set<number>;
}

interface Room {
  id: string;
  epoch: number;
  shared: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  members: Map<Peer, Member>;
  dirty: boolean;
  lastEditor: Member['user'] | null;
  idle: ReturnType<typeof setTimeout> | null;
  ceiling: ReturnType<typeof setTimeout> | null;
}

interface CollabRow extends Record<string, unknown> {
  epoch: number;
  revision: number;
  state: Uint8Array | null;
}

/** The epoch of a document's shared form, creating its row if there is none. */
export function collabEpoch(db: Database, documentId: string): number {
  const row = db.prepare('SELECT epoch FROM document_collab WHERE document_id = ?').get(documentId) as
    | { epoch: number }
    | undefined;
  if (row) return Number(row.epoch);
  db.prepare('INSERT INTO document_collab (document_id, epoch, revision, state, updated_at) VALUES (?, 1, 0, NULL, ?)').run(
    documentId,
    now(),
  );
  return 1;
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly db: Database,
    private readonly log: { warn: (detail: object, message: string) => void },
  ) {}

  /** How many people have a document open, for the tests and for the health of the instance. */
  membersOf(documentId: string): number {
    return this.rooms.get(documentId)?.members.size ?? 0;
  }

  /**
   * The stored content was replaced by something other than the editor. Whoever
   * has the document open is holding a history that no longer applies.
   */
  reset(documentId: string): void {
    const epoch = collabEpoch(this.db, documentId) + 1;
    this.db
      .prepare('UPDATE document_collab SET epoch = ?, state = NULL, revision = 0, updated_at = ? WHERE document_id = ?')
      .run(epoch, now(), documentId);
    const room = this.rooms.get(documentId);
    if (!room) return;
    this.rooms.delete(documentId);
    this.clearTimers(room);
    for (const peer of room.members.keys()) peer.close(CLOSE_STALE, 'The document was replaced. Reload it.');
    room.shared.destroy();
  }

  private open(documentId: string): Room | null {
    const existing = this.rooms.get(documentId);
    if (existing) return existing;

    const document = this.db
      .prepare('SELECT content, revision FROM documents WHERE id = ? AND deleted_at IS NULL')
      .get(documentId) as { content: string; revision: number } | undefined;
    if (!document) return null;
    const epoch = collabEpoch(this.db, documentId);
    const kept = this.db
      .prepare('SELECT epoch, revision, state FROM document_collab WHERE document_id = ?')
      .get(documentId) as CollabRow | undefined;

    const shared = new Y.Doc();
    if (kept?.state && Number(kept.revision) === Number(document.revision)) {
      Y.applyUpdate(shared, new Uint8Array(kept.state), 'load');
    } else {
      seedShared(shared, JSON.parse(document.content) as Parameters<typeof seedShared>[1]);
    }

    const awareness = new awarenessProtocol.Awareness(shared);
    awareness.setLocalState(null);
    const room: Room = {
      id: documentId, epoch, shared, awareness,
      members: new Map(), dirty: false, lastEditor: null, idle: null, ceiling: null,
    };

    shared.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const peer of room.members.keys()) peer.send(message);
      const member = room.members.get(origin as Peer);
      if (member) {
        room.lastEditor = member.user;
        this.schedule(room);
      }
    });

    awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const member = room.members.get(origin as Peer);
        if (member) {
          for (const id of [...added, ...updated]) member.clients.add(id);
          for (const id of removed) member.clients.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
        );
        const message = encoding.toUint8Array(encoder);
        for (const peer of room.members.keys()) peer.send(message);
      },
    );

    this.rooms.set(documentId, room);
    return room;
  }

  /** Somebody has opened the document. Returns false if there is nothing to join. */
  join(documentId: string, epoch: number, peer: Peer, member: Omit<Member, 'clients'>): boolean {
    const room = this.open(documentId);
    if (!room) {
      peer.close(CLOSE_GONE, 'That document is not there.');
      return false;
    }
    if (epoch !== room.epoch) {
      peer.close(CLOSE_STALE, 'The document was replaced. Reload it.');
      if (room.members.size === 0) this.leaveEmpty(room);
      return false;
    }
    room.members.set(peer, { ...member, clients: new Set() });

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.shared);
    peer.send(encoding.toUint8Array(encoder));

    const states = room.awareness.getStates();
    if (states.size > 0) {
      const present = encoding.createEncoder();
      encoding.writeVarUint(present, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(present, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      peer.send(encoding.toUint8Array(present));
    }
    return true;
  }

  receive(documentId: string, peer: Peer, data: Uint8Array): void {
    const room = this.rooms.get(documentId);
    const member = room?.members.get(peer);
    if (!room || !member) return;
    try {
      const decoder = decoding.createDecoder(data);
      const kind = decoding.readVarUint(decoder);
      if (kind === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), peer);
        return;
      }
      if (kind !== MESSAGE_SYNC) return;

      // Somebody who may only read is answered, and not listened to: they can
      // ask for the document, and what they send to change it is dropped here
      // whatever their browser was persuaded to send.
      if (!member.canWrite) {
        const peek = decoding.createDecoder(data);
        decoding.readVarUint(peek);
        if (decoding.readVarUint(peek) !== syncProtocol.messageYjsSyncStep1) return;
      }
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, reply, room.shared, peer);
      if (encoding.length(reply) > 1) peer.send(encoding.toUint8Array(reply));
    } catch (error) {
      this.log.warn({ documentId, error: (error as Error).message }, 'A collaboration message could not be read');
    }
  }

  leave(documentId: string, peer: Peer): void {
    const room = this.rooms.get(documentId);
    const member = room?.members.get(peer);
    if (!room || !member) return;
    room.members.delete(peer);
    awarenessProtocol.removeAwarenessStates(room.awareness, [...member.clients], null);
    if (room.members.size === 0) this.leaveEmpty(room);
  }

  private leaveEmpty(room: Room): void {
    this.clearTimers(room);
    this.snapshot(room);
    this.rooms.delete(room.id);
    room.shared.destroy();
  }

  private clearTimers(room: Room): void {
    if (room.idle) clearTimeout(room.idle);
    if (room.ceiling) clearTimeout(room.ceiling);
    room.idle = null;
    room.ceiling = null;
  }

  private schedule(room: Room): void {
    room.dirty = true;
    if (room.idle) clearTimeout(room.idle);
    room.idle = setTimeout(() => this.snapshot(room), SNAPSHOT_IDLE_MS);
    room.ceiling ??= setTimeout(() => this.snapshot(room), SNAPSHOT_MAX_MS);
  }

  /**
   * Write the shared document down as the stored form.
   *
   * It goes through the same repair and the same check as every other save.
   * Two edits that are each fine can merge into something that is not (two
   * people emptying the same list from either end), and the stored form must
   * never be one the editor cannot open.
   */
  private snapshot(room: Room): void {
    this.clearTimers(room);
    if (!room.dirty || !room.lastEditor) return;
    room.dirty = false;
    try {
      const repaired = repairDocument(readShared(room.shared)).doc;
      if (!validateDoc(repaired).ok) throw new Error('the merged document did not pass validation');
      // A picture pasted into a shared session travels inside the text like any
      // other; it is moved into the picture store as it is written down.
      const light = takePicturesOut(repaired);
      const saved = updateDocument(this.db, room.lastEditor, room.id, { content: light.doc });
      savePictures(this.db, room.id, light.pictures);
      this.db
        .prepare('UPDATE document_collab SET state = ?, revision = ?, updated_at = ? WHERE document_id = ?')
        .run(Y.encodeStateAsUpdate(room.shared), saved.revision, now(), room.id);
    } catch (error) {
      // Still in memory and still with everybody who has it open; tried again
      // on the next change.
      room.dirty = true;
      this.log.warn({ documentId: room.id, error: (error as Error).message }, 'A collaboration snapshot failed');
    }
  }

  /** Write everything down. Called when the server is stopping. */
  flush(): void {
    for (const room of [...this.rooms.values()]) this.snapshot(room);
  }
}
