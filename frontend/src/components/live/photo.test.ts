import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RESULT_PHOTO_BYTES, MAX_RESULT_PHOTO_EDGE, MAX_SOURCE_PHOTO_BYTES, prepareResultPhoto, validatePhotoFile } from './photo';

afterEach(() => vi.restoreAllMocks());

describe('result photo preparation', () => {
  it('accepts browser image formats and rejects unsupported or oversized files with useful guidance', () => {
    expect(validatePhotoFile({ type: 'image/jpeg', size: 10 } as File)).toBeNull();
    expect(validatePhotoFile({ type: 'image/heic', size: 10 } as File)).toMatch(/HEIC photos are not supported/i);
    expect(validatePhotoFile({ type: 'image/png', size: MAX_SOURCE_PHOTO_BYTES + 1 } as File)).toMatch(/smaller than 20 MB/i);
  });

  it('orients through browser decoding, scales to 1600px, and outputs a bounded JPEG data URL', async () => {
    const close = vi.fn();
    const bitmap = { width: 2400, height: 1200, close } as unknown as ImageBitmap;
    const createBitmap = vi.fn().mockResolvedValue(bitmap);
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: createBitmap });
    const fillRect = vi.fn();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect, drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg bytes'], { type: 'image/jpeg' })));

    const result = await prepareResultPhoto(new File(['image'], 'mix.png', { type: 'image/png' }));
    expect(createBitmap).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' });
    expect(result).toMatchObject({ width: 1600, height: 800, dataUrl: 'data:image/jpeg;base64,anBlZyBieXRlcw==' });
    expect(result.blob.type).toBe('image/jpeg');
    expect(result.blob.size).toBeLessThanOrEqual(MAX_RESULT_PHOTO_BYTES);
    expect(fillRect).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 800);
    expect(close).toHaveBeenCalledOnce();
    expect(MAX_RESULT_PHOTO_EDGE).toBe(1600);
  });

  it('keeps reducing quality and dimensions until the JPEG is under one megabyte', async () => {
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: vi.fn().mockResolvedValue({ width: 3200, height: 1800, close: vi.fn() }) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const sizes = [MAX_RESULT_PHOTO_BYTES + 5, MAX_RESULT_PHOTO_BYTES + 1, 10];
    const qualities: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, _type, quality) => {
      qualities.push(Number(quality));
      callback(new Blob([new Uint8Array(sizes.shift() ?? 10)], { type: 'image/jpeg' }));
    });
    const result = await prepareResultPhoto(new File(['image'], 'large.webp', { type: 'image/webp' }));
    expect(qualities.length).toBeGreaterThan(1);
    expect(result.blob.size).toBeLessThanOrEqual(MAX_RESULT_PHOTO_BYTES);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_RESULT_PHOTO_EDGE);
  });
});
