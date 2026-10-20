import { LEGACY_COLLISION, LEGACY_PALETTE, renderLegacyLine } from './legacy';

export type TvSystem = 'ntsc' | 'pal';

export const SCREEN_WIDTH = 256;
/** The tallest picture (the 240-line mode); the framebuffer always has room for it. */
export const MAX_LINES = 240;
export const LINES_PER_FRAME: Record<TvSystem, number> = { ntsc: 262, pal: 313 };

/** The Game Gear's LCD shows a 160 x 144 window from the middle of the 256 x 192 picture. */
export const GG_WIDTH = 160;
export const GG_HEIGHT = 144;
export const GG_LEFT = 48;
export const GG_TOP = 24;

export const STATUS_FRAME = 0x80;
export const STATUS_OVERFLOW = 0x40;
export const STATUS_COLLISION = 0x20;

const VRAM_SIZE = 0x4000;
const SPRITE_TERMINATOR = 0xd0;
const MAX_SPRITES_PER_LINE = 8;
/** Sprite pixels in `spriteLine`: bit 7 marks a pixel some sprite has drawn; the low bits hold its colour (0-15). */
const SPRITE_DRAWN = 0x80;

/**
 * The V counter's values through a frame, as runs of [first value, last value]:
 * it counts up through the picture and the bottom border, then jumps back so
 * the frame takes the right number of lines.
 */
const V_COUNTER_RUNS: Record<TvSystem, Record<number, [number, number][]>> = {
  ntsc: {
    192: [[0x00, 0xda], [0xd5, 0xff]],
    224: [[0x00, 0xea], [0xe5, 0xff]],
    240: [[0x00, 0xff], [0x00, 0x05]],
  },
  pal: {
    192: [[0x00, 0xf2], [0xba, 0xff]],
    224: [[0x00, 0xff], [0x00, 0x02], [0xca, 0xff]],
    240: [[0x00, 0xff], [0x00, 0x0a], [0xd2, 0xff]],
  },
};

function vCounterTable(tv: TvSystem, lines: number): Uint8Array {
  const table = new Uint8Array(LINES_PER_FRAME[tv]);
  let line = 0;
  for (const [first, last] of V_COUNTER_RUNS[tv][lines]) {
    for (let value = first; value <= last; value++) table[line++] = value;
  }
  return table;
}

/** 2-bit Master System colour components widened to the Game Gear's 4 bits (0, 5, 10, 15). */
export function smsColorTo12Bit(color: number): number {
  const r = color & 3;
  const g = (color >> 2) & 3;
  const b = (color >> 4) & 3;
  return r * 5 | ((g * 5) << 4) | ((b * 5) << 8);
}

const SMS_COLORS = Uint16Array.from({ length: 64 }, (_, color) => smsColorTo12Bit(color));
const LEGACY_COLORS = Uint16Array.from(LEGACY_PALETTE, (color) => smsColorTo12Bit(color));

/**
 * The Master System's video chip (Sega's 315-5246, as in the Master System II,
 * and the Game Gear's version of it): a TMS9918A with Sega's mode 4 added.
 *
 * Mode 4 has 4-bit tiles from a 32 x 28 (or 32 x 32) name table with flipping
 * and per-tile priority, two 16-colour palettes in colour RAM, horizontal and
 * vertical scrolling with locks for the top rows and right columns, and 64
 * sprites, eight to a line. The TMS9918A's own modes are still there, drawn
 * with a fixed palette. A line counter can interrupt the CPU partway down the
 * picture, as well as the usual interrupt at the end of each frame.
 *
 * Pixels go into the framebuffer as 12-bit colours (4 bits each of red, green
 * and blue, red in the low bits): the Game Gear's palette, with the Master
 * System's 2-bit colours widened to match.
 */
export class Vdp {
  readonly vram = new Uint8Array(VRAM_SIZE);
  /** Colour RAM: 32 bytes on the Master System, 64 (32 little-endian 12-bit words) on the Game Gear. */
  readonly cram = new Uint8Array(64);
  readonly registers = new Uint8Array(16);
  status = 0;
  /** The 14-bit address used by the data port. */
  address = 0;
  /** What the data port writes to: 0-2 VRAM, 3 colour RAM (the control word's top two bits). */
  code = 0;
  /** True after the first byte of a two-byte control port write. */
  latched = false;
  /** The read-ahead buffer: data port reads return the byte fetched by the previous access. */
  readBuffer = 0;
  /** The Game Gear writes colours a byte at a time; the even byte waits here for the odd one. */
  cramLatch = 0;
  /** The line counter, reloaded from register 10. */
  lineCounter = 0xff;
  lineInterruptPending = false;
  /** Vertical scroll only takes effect from the next frame. */
  vScroll = 0;
  /** The Game Gear's chip: 12-bit colour RAM. */
  gameGear = false;
  tv: TvSystem = 'ntsc';
  /** The line being drawn or about to be (0 = the top of the picture). */
  line = 0;
  /** The picture's height for this frame: 192, 224 or 240 lines. */
  activeLines = 192;
  /** The height set by the mode registers, taking effect at the start of the next frame. */
  pendingLines = 192;
  /** The finished picture: SCREEN_WIDTH x activeLines 12-bit colours. */
  readonly framebuffer = new Uint16Array(SCREEN_WIDTH * MAX_LINES);
  /** Called whenever the INT output changes (it drives the Z80's IRQ line). */
  onInterrupt: (active: boolean) => void = () => {};
  private interruptActive = false;
  private vCounters = vCounterTable('ntsc', 192);
  /** One line of colour indexes, before they go through the palette. */
  private readonly lineBuffer = new Uint8Array(SCREEN_WIDTH);
  /** The background's priority bit for each pixel of the line (set where the tile is in front of sprites). */
  private readonly priority = new Uint8Array(SCREEN_WIDTH);
  private readonly spriteLine = new Uint8Array(SCREEN_WIDTH);

  reset(): void {
    this.registers.fill(0);
    // What the BIOS leaves behind, for games that start without it: mode 4, display off, the usual tables.
    this.registers.set([0x36, 0x80, 0xff, 0xff, 0xff, 0xff, 0xfb, 0x00, 0x00, 0x00, 0xff]);
    this.status = 0;
    this.address = 0;
    this.code = 0;
    this.latched = false;
    this.readBuffer = 0;
    this.cramLatch = 0;
    this.lineCounter = 0xff;
    this.lineInterruptPending = false;
    this.vScroll = 0;
    this.line = 0;
    this.updateMode();
    this.updateInterrupt();
  }

  setTv(tv: TvSystem): void {
    this.tv = tv;
    if (this.line >= LINES_PER_FRAME[tv]) this.line = 0;
    this.vCounters = vCounterTable(tv, this.activeLines);
  }

  get interrupt(): boolean {
    return this.interruptActive;
  }

  /** True in Sega's mode 4 (and its taller variants); false in the TMS9918A modes. */
  get mode4(): boolean {
    return (this.registers[0] & 0x04) !== 0;
  }

  // --- Ports ------------------------------------------------------------------------

  writeControl(value: number): void {
    if (!this.latched) {
      this.address = (this.address & 0x3f00) | value;
      this.latched = true;
      return;
    }
    this.latched = false;
    this.address = ((value & 0x3f) << 8) | (this.address & 0xff);
    this.code = value >> 6;
    if (this.code === 0) {
      // Setting up a read fetches the first byte straight away.
      this.readBuffer = this.vram[this.address];
      this.address = (this.address + 1) & 0x3fff;
    } else if (this.code === 2) {
      this.writeRegister(value & 0x0f, this.address & 0xff);
    }
  }

  private writeRegister(index: number, value: number): void {
    if (index > 10) return;
    this.registers[index] = value;
    if (index === 0 || index === 1) {
      this.updateMode();
      this.updateInterrupt();
    }
  }

  readStatus(): number {
    // In mode 4 the low bits aren't driven; in the TMS9918A modes they hold the fifth sprite's number.
    const value = this.mode4 ? this.status | 0x1f : this.status;
    this.status = 0;
    this.lineInterruptPending = false;
    this.latched = false;
    this.updateInterrupt();
    return value;
  }

  writeData(value: number): void {
    this.latched = false;
    if (this.code === 3) {
      if (!this.gameGear) {
        this.cram[this.address & 0x1f] = value & 0x3f;
      } else if ((this.address & 1) === 0) {
        this.cramLatch = value;
      } else {
        this.cram[this.address & 0x3e] = this.cramLatch;
        this.cram[this.address & 0x3f] = value & 0x0f;
      }
    } else {
      this.vram[this.address] = value;
    }
    this.readBuffer = value;
    this.address = (this.address + 1) & 0x3fff;
  }

  readData(): number {
    this.latched = false;
    const value = this.readBuffer;
    this.readBuffer = this.vram[this.address];
    this.address = (this.address + 1) & 0x3fff;
    return value;
  }

  /** The V counter as the CPU reads it from port $7E. */
  get vCounter(): number {
    return this.vCounters[this.line];
  }

  private updateInterrupt(): void {
    const frame = (this.status & STATUS_FRAME) !== 0 && (this.registers[1] & 0x20) !== 0;
    const line = this.lineInterruptPending && (this.registers[0] & 0x10) !== 0;
    const active = frame || line;
    if (active === this.interruptActive) return;
    this.interruptActive = active;
    this.onInterrupt(active);
  }

  /** The 224- and 240-line modes need mode 4 with M2 and one of M1 or M3. */
  private updateMode(): void {
    const r0 = this.registers[0];
    const r1 = this.registers[1];
    let lines = 192;
    if ((r0 & 0x06) === 0x06) {
      const m1 = (r1 & 0x10) !== 0;
      const m3 = (r1 & 0x08) !== 0;
      // The Game Gear always shows the same 144 lines, but its chip still has the taller modes.
      if (m1 && !m3) lines = 224;
      else if (m3 && !m1) lines = 240;
    }
    // The height only changes between frames; a change made mid-frame waits for the next one.
    this.pendingLines = lines;
    if (this.line === 0) this.applyPendingLines();
  }

  private applyPendingLines(): void {
    if (this.pendingLines === this.activeLines) return;
    this.activeLines = this.pendingLines;
    this.vCounters = vCounterTable(this.tv, this.activeLines);
  }

  // --- Timing -----------------------------------------------------------------------

  /**
   * Starts line `this.line`: draws it if it is in the picture, then runs the
   * line counter and sets the frame flag at the end of the picture. Returns
   * true when the picture has just been finished.
   */
  startLine(): boolean {
    const line = this.line;
    if (line === 0) {
      this.applyPendingLines();
      this.vScroll = this.registers[9];
    }
    const active = this.activeLines;
    if (line < active) this.renderLine(line);
    if (line <= active) {
      if (this.lineCounter === 0) {
        this.lineCounter = this.registers[10];
        this.lineInterruptPending = true;
      } else {
        this.lineCounter--;
      }
    } else {
      this.lineCounter = this.registers[10];
    }
    if (line === active) this.status |= STATUS_FRAME;
    this.updateInterrupt();
    return line === active;
  }

  /** Moves on to the next line, wrapping round at the end of the frame. */
  endLine(): void {
    if (++this.line === LINES_PER_FRAME[this.tv]) this.line = 0;
  }

  // --- Drawing ----------------------------------------------------------------------

  private get backdropIndex(): number {
    return (this.registers[7] & 0x0f) | 0x10;
  }

  /** Draws `line` of the picture into the framebuffer. */
  renderLine(line: number): void {
    const out = line * SCREEN_WIDTH;
    const frame = this.framebuffer;
    if (!this.mode4) {
      const buffer = this.lineBuffer;
      const flags = renderLegacyLine(this.vram, this.registers, line, buffer);
      this.status |= flags & LEGACY_COLLISION;
      if ((this.status & STATUS_OVERFLOW) === 0) this.status = (this.status & 0xe0) | (flags & 0x5f);
      for (let x = 0; x < SCREEN_WIDTH; x++) frame[out + x] = LEGACY_COLORS[buffer[x]];
      return;
    }
    const buffer = this.lineBuffer;
    if ((this.registers[1] & 0x40) === 0) {
      buffer.fill(this.backdropIndex);
    } else {
      this.renderBackground(line);
      this.renderSprites(line);
      if (this.registers[0] & 0x20) buffer.fill(this.backdropIndex, 0, 8);
    }
    this.output(buffer, frame, out);
  }

  private output(buffer: Uint8Array, frame: Uint16Array, out: number): void {
    const cram = this.cram;
    if (this.gameGear) {
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        const index = buffer[x] << 1;
        frame[out + x] = cram[index] | (cram[index + 1] << 8);
      }
    } else {
      for (let x = 0; x < SCREEN_WIDTH; x++) frame[out + x] = SMS_COLORS[cram[buffer[x]]];
    }
  }

  private renderBackground(line: number): void {
    const { vram, registers, lineBuffer, priority } = this;
    const tall = this.activeLines > 192;
    // In the taller modes the name table is 32 rows and sits at a slightly different place.
    const names = tall ? ((registers[2] & 0x0c) << 10) | 0x0700 : (registers[2] & 0x0e) << 10;
    const rows = tall ? 256 : 224;
    const hScroll = (registers[0] & 0x40) !== 0 && line < 16 ? 0 : registers[8];
    const lockRight = (registers[0] & 0x80) !== 0;
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const vScroll = lockRight && x >= 192 ? 0 : this.vScroll;
      const y = (line + vScroll) % rows;
      const bgX = (x - hScroll) & 0xff;
      const entryAddress = names + ((y >> 3) << 6) + ((bgX >> 3) << 1);
      const entry = vram[entryAddress & 0x3fff] | (vram[(entryAddress + 1) & 0x3fff] << 8);
      const tile = entry & 0x1ff;
      const row = entry & 0x400 ? 7 - (y & 7) : y & 7;
      const column = entry & 0x200 ? bgX & 7 : 7 - (bgX & 7);
      const base = (tile << 5) + (row << 2);
      const color =
        ((vram[base] >> column) & 1) |
        (((vram[base + 1] >> column) & 1) << 1) |
        (((vram[base + 2] >> column) & 1) << 2) |
        (((vram[base + 3] >> column) & 1) << 3);
      lineBuffer[x] = color | (entry & 0x800 ? 0x10 : 0);
      priority[x] = entry & 0x1000 && color !== 0 ? 1 : 0;
    }
  }

  /**
   * Draws the sprites on `line`: lower-numbered sprites win, eight fit on a
   * line (a ninth sets the overflow flag), and two sprites' pixels meeting
   * sets the collision flag. Tiles with their priority bit set stay in front.
   */
  private renderSprites(line: number): void {
    const { vram, registers, lineBuffer, priority, spriteLine } = this;
    const attributes = (registers[5] & 0x7e) << 7;
    const tileBase = (registers[6] & 0x04) << 6;
    const tall = (registers[1] & 0x02) !== 0;
    const zoom = (registers[1] & 0x01) !== 0 ? 1 : 0;
    const height = (tall ? 16 : 8) << zoom;
    const shift = registers[0] & 0x08 ? 8 : 0;
    spriteLine.fill(0);
    let visible = 0;
    for (let sprite = 0; sprite < 64; sprite++) {
      const rawY = vram[attributes + sprite];
      if (rawY === SPRITE_TERMINATOR && this.activeLines === 192) break;
      let y = rawY + 1;
      if (y > 240) y -= 256;
      const row = line - y;
      if (row < 0 || row >= height) continue;
      if (visible === MAX_SPRITES_PER_LINE) {
        this.status |= STATUS_OVERFLOW;
        break;
      }
      visible++;
      const x = vram[attributes + 0x80 + sprite * 2] - shift;
      let tile = vram[attributes + 0x81 + sprite * 2] | tileBase;
      if (tall) tile &= ~1;
      const base = (tile << 5) + ((row >> zoom) << 2);
      const planes = [vram[base & 0x3fff], vram[(base + 1) & 0x3fff], vram[(base + 2) & 0x3fff], vram[(base + 3) & 0x3fff]];
      for (let px = 0; px < 8 << zoom; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= SCREEN_WIDTH) continue;
        const bit = 7 - (px >> zoom);
        const color =
          ((planes[0] >> bit) & 1) | (((planes[1] >> bit) & 1) << 1) | (((planes[2] >> bit) & 1) << 2) | (((planes[3] >> bit) & 1) << 3);
        if (color === 0) continue;
        if (spriteLine[sx] & SPRITE_DRAWN) {
          this.status |= STATUS_COLLISION;
          continue;
        }
        spriteLine[sx] = SPRITE_DRAWN | color;
        if (!priority[sx]) lineBuffer[sx] = color | 0x10;
      }
    }
  }
}
