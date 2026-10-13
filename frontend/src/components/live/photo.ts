export const MAX_SOURCE_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_RESULT_PHOTO_BYTES = 1024 * 1024;
export const MAX_RESULT_PHOTO_EDGE = 1600;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type PreparedPhoto = { blob: Blob; dataUrl: string; width: number; height: number };

export function validatePhotoFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return 'Choose a JPEG, PNG, or WebP photo. HEIC photos are not supported yet.';
  }
  if (!file.size) return 'This photo is empty. Choose another image.';
  if (file.size > MAX_SOURCE_PHOTO_BYTES) return 'Choose a photo smaller than 20 MB.';
  return null;
}

async function decodePhoto(file: File): Promise<{ image: CanvasImageSource; width: number; height: number; close?: () => void }> {
  if (typeof window.createImageBitmap === 'function') {
    try {
      const bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* Fall back to Image, whose decode follows browser orientation handling. */ }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('This photo could not be prepared. Try another image.')), 'image/jpeg', quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  });
}

export async function prepareResultPhoto(file: File): Promise<PreparedPhoto> {
  const fileError = validatePhotoFile(file);
  if (fileError) throw new Error(fileError);

  let decoded: Awaited<ReturnType<typeof decodePhoto>>;
  try { decoded = await decodePhoto(file); }
  catch { throw new Error('This photo could not be opened. Choose a JPEG, PNG, or WebP image.'); }
  try {
    if (!decoded.width || !decoded.height) throw new Error('This photo has no readable image data. Try another image.');
    const initialScale = Math.min(1, MAX_RESULT_PHOTO_EDGE / Math.max(decoded.width, decoded.height));
    let width = Math.max(1, Math.round(decoded.width * initialScale));
    let height = Math.max(1, Math.round(decoded.height * initialScale));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not prepare this photo. Try another browser.');

    let blob: Blob | null = null;
    let quality = 0.82;
    while (width > 0 && height > 0) {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(decoded.image, 0, 0, width, height);
      blob = await canvasBlob(canvas, quality);
      if (blob.size <= MAX_RESULT_PHOTO_BYTES) break;
      if (quality > 0.5) quality = Math.max(0.5, quality - 0.1);
      else {
        width = Math.floor(width * 0.82);
        height = Math.floor(height * 0.82);
        quality = 0.82;
      }
    }
    if (!blob || blob.size > MAX_RESULT_PHOTO_BYTES) throw new Error('This photo is too detailed to prepare. Choose a simpler or smaller image.');
    return { blob, dataUrl: await blobToDataUrl(blob), width, height };
  } finally {
    decoded.close?.();
  }
}
