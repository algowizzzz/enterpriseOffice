import { Doc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';

export type Connection = 'connecting' | 'live' | 'offline';

export interface Presence {
  name: string;
  color: string;
}

export interface SharedSession {
  document: Doc;
  provider: WebsocketProvider;
  user: Presence;
  /** Stop, and forget the shared document. */
  close: () => void;
}

/** Colours that can be told apart beside each other and read on white. */
const COLOURS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#e67e22', '#17a2b8', '#c2185b', '#6d4c41'];

const colourFor = (name: string): string => {
  let hash = 0;
  for (const letter of name) hash = (hash * 31 + (letter.codePointAt(0) ?? 0)) >>> 0;
  return COLOURS[hash % COLOURS.length] as string;
};

/** Close codes the server uses to say "do not come back as you are". */
const FINAL = new Set([4400, 4401, 4404, 4409]);

/**
 * Join the shared form of a document.
 *
 * The connection is to this origin and nowhere else, over the same session
 * cookie as every other request. When it drops, the text stays editable: what
 * is typed is held and sent when the connection returns, which is the point of
 * the shared document being one that merges.
 */
export function joinShared(
  documentId: string,
  epoch: number,
  name: string,
  handlers: { onConnection: (state: Connection) => void; onReplaced: () => void },
): SharedSession {
  const document = new Doc();
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new WebsocketProvider(
    `${scheme}://${window.location.host}/api/collab`,
    `${documentId}.${epoch}`,
    document,
    // Presence that has gone quiet is dropped by the library after thirty
    // seconds; resyncing now and then covers a message lost on a bad network.
    { resyncInterval: 60000, maxBackoffTime: 10000 },
  );
  const user = { name, color: colourFor(name) };

  provider.on('status', ({ status }: { status: string }) => {
    handlers.onConnection(status === 'connected' ? 'live' : status === 'connecting' ? 'connecting' : 'offline');
  });
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (!event || !FINAL.has(event.code)) return;
    // Reconnecting would be refused again, for the same reason, for ever.
    provider.shouldConnect = false;
    if (event.code === 4409) handlers.onReplaced();
    else handlers.onConnection('offline');
  });

  return {
    document,
    provider,
    user,
    close: () => {
      provider.destroy();
      document.destroy();
    },
  };
}

/** Everybody else who has the document open, once each however many tabs they have. */
export function othersPresent(session: SharedSession): Presence[] {
  const seen = new Map<string, Presence>();
  session.provider.awareness.getStates().forEach((state, client) => {
    if (client === session.document.clientID) return;
    const user = (state as { user?: Partial<Presence> }).user;
    if (user?.name && !seen.has(user.name)) seen.set(user.name, { name: user.name, color: user.color ?? '#555' });
  });
  seen.delete(session.user.name);
  return [...seen.values()];
}
