// Decoding an image file in the page (the worker gets the pixels), and carrying it in a project as
// a data: URL. The browser only decodes; grey levels and shrinking happen in core/raster.ts, the
// same in every browser. Images larger than 4096 px on a side are first shrunk by the browser.
const MAX_DECODE = 4096;

export async function decodeImage(bytes: Uint8Array, mime: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime || 'application/octet-stream' });
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const scale = Math.min(1, MAX_DECODE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

export function dataUrlToBytes(url: string): { bytes: Uint8Array; mime: string } | null {
  const m = url.match(/^data:([^;,]*);base64,(.*)$/s);
  if (!m) return null;
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime: m[1] };
}
