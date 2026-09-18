/**
 * Read the pixel size out of an embedded image.
 *
 * Without this every picture was written back into Word at a fixed 400 by 300,
 * so a round trip resized and distorted every image in the document. Only the
 * four formats the exporter can write are handled, which is the same set the
 * importer accepts.
 *
 * Each reader looks only at the header, so the cost does not grow with the size
 * of the picture.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** PNG: the IHDR chunk is always first, at a fixed offset. */
function pngSize(data: Buffer): ImageSize | null {
  if (data.length < 24) return null;
  if (data.readUInt32BE(0) !== 0x89504e47) return null;
  if (data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** GIF: the logical screen descriptor follows the six-byte signature. */
function gifSize(data: Buffer): ImageSize | null {
  if (data.length < 10) return null;
  const signature = data.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
}

/** BMP: the DIB header carries the dimensions as signed values. */
function bmpSize(data: Buffer): ImageSize | null {
  if (data.length < 26) return null;
  if (data.toString('latin1', 0, 2) !== 'BM') return null;
  const width = data.readInt32LE(18);
  const height = data.readInt32LE(22);
  // A negative height means the rows are stored top down.
  return { width: Math.abs(width), height: Math.abs(height) };
}

/**
 * JPEG: walk the segment markers to the start-of-frame, which is the only
 * place the dimensions appear. Segments carrying no length, and the restart
 * markers, are stepped over rather than parsed.
 */
function jpegSize(data: Buffer): ImageSize | null {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (marker === undefined) return null;

    // Padding, and the markers that carry no payload.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return null;

    // Start of frame, in any of its forms except the ones that are not frames.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > data.length) return null;
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** Guard against a header that claims an implausible size. */
const MAX_DIMENSION = 20000;

function plausible(size: ImageSize | null): ImageSize | null {
  if (!size) return null;
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

/** The pixel size of an image given as a data URI, or null if it cannot be read. */
export function measureImage(dataUri: string): ImageSize | null {
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.*)$/iu.exec(dataUri);
  if (!match) return null;

  let data: Buffer;
  try {
    data = Buffer.from(match[2] ?? '', 'base64');
  } catch {
    return null;
  }
  if (data.length === 0) return null;

  const subtype = (match[1] ?? '').toLowerCase();
  if (subtype === 'png') return plausible(pngSize(data));
  if (subtype === 'gif') return plausible(gifSize(data));
  if (subtype === 'bmp') return plausible(bmpSize(data));
  if (subtype === 'jpg' || subtype === 'jpeg') return plausible(jpegSize(data));
  return null;
}
