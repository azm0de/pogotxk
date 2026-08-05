/**
 * Minimal intrinsic-dimension reader for JPEG and PNG.
 *
 * Enough to fill `media.width`/`media.height` at import time so the map popups
 * and gallery can reserve space and avoid layout shift. Returns null for
 * anything it does not recognise rather than guessing.
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readGif(bytes) ?? null;
}

function readPng(b: Uint8Array): { width: number; height: number } | null {
  // 89 50 4E 47 0D 0A 1A 0A, then an IHDR chunk whose data starts at byte 16.
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return null;

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readGif(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null; // "GIF"
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readJpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;

  while (i < b.length - 9) {
    if (b[i] !== 0xff) {
      i++; // resync past padding
      continue;
    }
    const marker = b[i + 1]!;

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan — past this point is entropy-coded data, no more headers.
    if (marker === 0xda) return null;

    const length = view.getUint16(i + 2);
    if (length < 2) return null;

    // SOF0..SOF15 hold the frame dimensions; C4 (Huffman), C8 (JPG ext) and
    // CC (arithmetic conditioning) share the range but are not frame headers.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }

    i += 2 + length;
  }

  return null;
}
