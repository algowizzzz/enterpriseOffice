import { deflateSync } from 'node:zlib';

/**
 * A decoded picture as pdf.js hands it over in Node: raw samples and a `kind`
 * saying how they are packed. The numbers are pdf.js's own ImageKind values.
 */
export interface RawImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

export const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

/**
 * More samples than this and the picture is left out rather than encoded. The
 * encoder runs on the request path, and one poster-sized scan would otherwise
 * hold the whole server for seconds.
 */
const MAX_PIXELS = 40_000_000;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * Shrink by a whole factor, averaging each block of samples.
 *
 * A PDF often carries a photograph at print resolution for a space a few
 * centimetres wide. Kept whole, a handful of those made a document of tens of
 * megabytes that every save then had to carry. The page only ever shows the
 * picture at the size the PDF placed it, so anything far beyond that is weight
 * with nothing to show for it.
 */
function shrink(image: RawImage, channels: number, factor: number): RawImage {
  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const data = new Uint8Array(width * height * channels);
  const area = factor * factor;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy += 1) {
          const row = ((y * factor + dy) * image.width + x * factor) * channels + c;
          for (let dx = 0; dx < factor; dx += 1) sum += image.data[row + dx * channels] ?? 0;
        }
        data[(y * width + x) * channels + c] = Math.round(sum / area);
      }
    }
  }
  return { width, height, kind: image.kind, data };
}

/**
 * Encode a decoded picture as a PNG, or return null when it cannot be done
 * honestly (an unknown packing, a buffer shorter than its size claims, or a
 * picture too large to encode on the request path).
 *
 * Written by hand on `node:zlib` because the server may carry no native
 * modules, and every image library worth using is one.
 *
 * `targetWidth` is the width in pixels the picture will be shown at. A source
 * more than twice as detailed as that is shrunk first.
 */
export function encodePng(source: RawImage, targetWidth?: number): Buffer | null {
  let image = source;
  const { kind } = image;
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) return null;
  if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_PIXELS) return null;

  let channels: number;
  let colourType: number;
  let bitDepth = 8;
  if (kind === IMAGE_KIND.RGB_24BPP) {
    channels = 3;
    colourType = 2;
  } else if (kind === IMAGE_KIND.RGBA_32BPP) {
    channels = 4;
    colourType = 6;
  } else if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    channels = 1;
    colourType = 0;
    bitDepth = 1;
  } else {
    return null;
  }

  const stride =
    bitDepth === 1 ? Math.ceil(image.width / 8) : image.width * channels;
  if (image.data.length < stride * image.height) return null;

  if (bitDepth === 8 && targetWidth !== undefined && targetWidth > 0) {
    const factor = Math.floor(image.width / (targetWidth * 2));
    if (factor >= 2) image = shrink(image, channels, Math.min(factor, 16));
  }
  const rowBytes = bitDepth === 1 ? Math.ceil(image.width / 8) : image.width * channels;

  // Each row is written with the Sub filter when it holds whole bytes: for a
  // photograph the difference from the pixel to the left compresses far better
  // than the pixel itself, and it costs one pass.
  const raw = Buffer.alloc((rowBytes + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const from = y * rowBytes;
    const to = y * (rowBytes + 1);
    if (bitDepth === 1) {
      raw[to] = 0;
      for (let i = 0; i < rowBytes; i += 1) raw[to + 1 + i] = image.data[from + i] ?? 0;
    } else {
      raw[to] = 1;
      for (let i = 0; i < rowBytes; i += 1) {
        const left = i >= channels ? (image.data[from + i - channels] ?? 0) : 0;
        raw[to + 1 + i] = ((image.data[from + i] ?? 0) - left) & 0xff;
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = bitDepth;
  header[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
