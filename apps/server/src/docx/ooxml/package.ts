/**
 * The parts of a .docx this reader needs, unpacked and parsed.
 *
 * A Word file is a zip of XML parts plus the pictures they refer to. This pulls
 * out the ones that carry content, leaving everything else alone.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { parseXml, type XmlElement } from './xml.js';

export interface WordPackage {
  document: XmlElement;
  styles?: XmlElement;
  numbering?: XmlElement;
  theme?: XmlElement;
  /** Review comments, and the part that says which are replies and which are resolved. */
  comments?: XmlElement;
  commentsExtended?: XmlElement;
  /** Relationship id to target, from word/_rels/document.xml.rels. */
  relationships: Map<string, { target: string; external: boolean }>;
  /** Picture bytes by part name, such as "media/image1.png". */
  media: Map<string, Uint8Array>;
  headers: XmlElement[];
  footers: XmlElement[];
}

const MAIN = 'word/document.xml';

export function readPackage(buffer: Buffer): WordPackage {
  const parts = unzipSync(new Uint8Array(buffer));
  const text = (name: string): string | undefined =>
    parts[name] ? strFromU8(parts[name]) : undefined;

  const main = text(MAIN);
  if (!main) throw new Error('that file has no main document part');

  const relationships = new Map<string, { target: string; external: boolean }>();
  const relsXml = text('word/_rels/document.xml.rels');
  if (relsXml) {
    for (const relationship of parseXml(relsXml).children) {
      if (!('name' in relationship) || relationship.name !== 'Relationship') continue;
      const id = relationship.attrs['Id'];
      const target = relationship.attrs['Target'];
      if (!id || !target) continue;
      relationships.set(id, {
        target: target.replace(/^\/?word\//u, '').replace(/^\.\//u, ''),
        external: relationship.attrs['TargetMode'] === 'External',
      });
    }
  }

  const media = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(parts)) {
    if (name.startsWith('word/media/')) media.set(name.slice('word/'.length), bytes);
  }

  const partsNamed = (pattern: RegExp): XmlElement[] =>
    Object.keys(parts)
      .filter((name) => pattern.test(name))
      .sort()
      .flatMap((name) => {
        const xml = text(name);
        return xml ? [parseXml(xml)] : [];
      });

  const optional = (name: string): XmlElement | undefined => {
    const xml = text(name);
    return xml ? parseXml(xml) : undefined;
  };

  return {
    document: parseXml(main),
    styles: optional('word/styles.xml'),
    numbering: optional('word/numbering.xml'),
    theme: optional('word/theme/theme1.xml'),
    comments: optional('word/comments.xml'),
    commentsExtended: optional('word/commentsExtended.xml'),
    relationships,
    media,
    headers: partsNamed(/^word\/header\d*\.xml$/u),
    footers: partsNamed(/^word\/footer\d*\.xml$/u),
  };
}
