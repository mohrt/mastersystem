import { GG_HEIGHT, GG_LEFT, GG_WIDTH, SCREEN_WIDTH } from '../vdp/vdp';

/** Master System pixels are a little wider than tall on a TV (the same pixel clock as the NES). */
const TV_PIXEL_ASPECT = 8 / 7;
/** The Master System's left column often holds scrolling junk; most games blank it, the rest can be cropped. */
export const LEFT_COLUMN = 8;

/** 12-bit colours (red in the low 4 bits) as canvas pixels (little-endian RGBA). */
const RGBA = Uint32Array.from({ length: 4096 }, (_, color) => {
  const r = (color & 0x0f) * 17;
  const g = ((color >> 4) & 0x0f) * 17;
  const b = ((color >> 8) & 0x0f) * 17;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
});

/** The part of the picture that is shown. */
interface View {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Turns finished frames (12-bit colours) into canvas pixels, showing the Game Gear's window or the whole picture. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image!: ImageData;
  private pixels!: Uint32Array;
  private view: View = { x: 0, y: 0, width: SCREEN_WIDTH, height: 192 };
  /** The height of the last picture: 192, 224 or 240 lines. */
  private lines = 192;
  private gameGear = false;
  private cropLeft = false;
  private hasNewFrame = false;
  /** Called with the width / height ratio the canvas should be shown at, whenever it changes. */
  onAspect: (aspect: number) => void = () => {};

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.resize(this.view);
  }

  /** Shows the Game Gear's 160 x 144 window rather than the Master System's whole picture. */
  setGameGear(gameGear: boolean): void {
    this.gameGear = gameGear;
    this.resize(this.viewFor(this.lines));
  }

  setCropLeftColumn(crop: boolean): void {
    this.cropLeft = crop;
    this.resize(this.viewFor(this.lines));
  }

  get aspect(): number {
    return (this.view.width * (this.gameGear ? 1 : TV_PIXEL_ASPECT)) / this.view.height;
  }

  private viewFor(lines: number): View {
    if (this.gameGear) return { x: GG_LEFT, y: (lines - GG_HEIGHT) >> 1, width: GG_WIDTH, height: GG_HEIGHT };
    const x = this.cropLeft ? LEFT_COLUMN : 0;
    return { x, y: 0, width: SCREEN_WIDTH - x, height: lines };
  }

  private resize(view: View): void {
    const sameSize = this.image !== undefined && view.width === this.view.width && view.height === this.view.height;
    this.view = view;
    if (sameSize) return;
    this.canvas.width = view.width;
    this.canvas.height = view.height;
    this.image = this.context.createImageData(view.width, view.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.hasNewFrame = true;
    this.onAspect(this.aspect);
  }

  /** Copies a finished frame (`lines` tall) to the canvas's pixels. */
  capture(frame: Uint16Array, lines: number): void {
    this.lines = lines;
    const view = this.viewFor(lines);
    if (view.height !== this.view.height || view.x !== this.view.x || view.y !== this.view.y) this.resize(view);
    const { pixels } = this;
    const { x, y, width, height } = this.view;
    let i = 0;
    for (let row = 0; row < height; row++) {
      const start = (y + row) * SCREEN_WIDTH + x;
      for (let column = 0; column < width; column++) pixels[i++] = RGBA[frame[start + column] & 0xfff];
    }
    this.hasNewFrame = true;
  }

  /** A dark screen with a faint scanline pattern, shown while no cartridge is in. */
  showIdle(): void {
    const { pixels } = this;
    const width = this.view.width;
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i / width) & 1 ? 0xff141414 : 0xff1c1c1c;
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
