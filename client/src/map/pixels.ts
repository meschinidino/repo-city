export interface PixelData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export type Pt = [number, number];

export function createPixels(width: number, height: number): PixelData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}
export function clonePixels(src: PixelData): PixelData {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}
export function alphaAt(src: PixelData, x: number, y: number): number {
  return src.data[(y * src.width + x) * 4 + 3];
}
