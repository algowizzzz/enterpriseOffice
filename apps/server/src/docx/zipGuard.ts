/**
 * A cheap look at what a .docx claims it will expand to.
 *
 * A Word file is a zip, and a small zip can declare an enormous payload. The
 * converter expands the whole archive into memory, so a 25 MB upload can become
 * tens of gigabytes and take the process down with it.
 *
 * This reads the sizes out of the central directory, which costs nothing
 * because it does not decompress anything.
 *
 * Be clear about what it does not do: the sizes are written by whoever made the
 * archive, so an attacker who crafts one can lie about them. It stops the
 * ordinary case, which is a real archive that genuinely expands enormously, and
 * it is not the last line of defence. The upload cap, the rate limit on the
 * conversion route and a memory limit on the process are what contain a
 * deliberately forged one.
 */

/** Signatures, little endian, as they appear in the file. */
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP64_LOCATOR = 0x07064b50;

/** The end record is at most this far from the end, allowing for a comment. */
const MAX_COMMENT = 0xffff;

export interface ArchiveClaim {
  /** What the archive says its contents expand to, in bytes. */
  declaredBytes: number;
  entries: number;
  /** True when the archive uses the 64-bit format, whose sizes are elsewhere. */
  zip64: boolean;
}

/**
 * Read the declared uncompressed size, or null when the archive cannot be read
 * far enough to tell. A null means "no opinion", not "safe".
 */
export function readArchiveClaim(data: Buffer): ArchiveClaim | null {
  const searchFrom = Math.max(0, data.length - MAX_COMMENT - 22);
  let end = -1;
  for (let offset = data.length - 22; offset >= searchFrom; offset -= 1) {
    if (data.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) return null;

  const zip64 = hasZip64Locator(data, end);
  const entries = data.readUInt16LE(end + 10);
  const directoryOffset = data.readUInt32LE(end + 16);
  if (directoryOffset >= data.length) return null;

  let declaredBytes = 0;
  let offset = directoryOffset;
  let seen = 0;
  while (seen < entries && offset + 46 <= data.length) {
    if (data.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) break;
    declaredBytes += data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
    seen += 1;
  }

  return { declaredBytes, entries: seen, zip64 };
}

function hasZip64Locator(data: Buffer, endOffset: number): boolean {
  const locator = endOffset - 20;
  if (locator < 0) return false;
  return data.readUInt32LE(locator) === ZIP64_LOCATOR;
}

/**
 * Whether an archive should be handed to the converter at all.
 *
 * A 64-bit archive is refused outright rather than guessed at: nothing this
 * product writes produces one, and the sizes it would need are in a record this
 * does not read.
 */
export function archiveIsReasonable(
  data: Buffer,
  limitBytes: number,
): { ok: true } | { ok: false; reason: string } {
  const claim = readArchiveClaim(data);
  if (!claim) return { ok: true };

  if (claim.zip64) {
    return { ok: false, reason: 'That file uses a zip format this server does not read.' };
  }
  if (claim.declaredBytes > limitBytes) {
    const megabytes = Math.round(limitBytes / (1024 * 1024));
    return {
      ok: false,
      reason: `That file expands to more than ${megabytes} MB, which is too large to convert.`,
    };
  }
  return { ok: true };
}
