/**
 * The TMS9918A modes the Master System's video chip kept for the SG-1000's
 * games: Graphics I and II, Multicolor and Text, with the TMS9918A's 32
 * sprites. Ported from the ColecoVision emulator's TMS9918A.
 */

/** The fixed palette used in these modes: the TMS9918A's 16 colours as the nearest Master System colours. */
export const LEGACY_PALETTE: readonly number[] = [
  0x00, 0x00, 0x08, 0x0c, 0x10, 0x30, 0x01, 0x3c, 0x02, 0x03, 0x05, 0x0f, 0x04, 0x33, 0x15, 0x3f,
];

export const LEGACY_FIFTH_SPRITE = 0x40;
export const LEGACY_COLLISION = 0x20;

const SPRITE_TERMINATOR = 0xd0;
const MAX_SPRITES_PER_LINE = 4;
const WIDTH = 256;

const spriteLine = new Uint8Array(WIDTH);

/**
 * Draws `line` (0-191) into `out` as colour indexes (0-15, with transparent
 * pixels showing the backdrop). Returns the sprite status: LEGACY_FIFTH_SPRITE
 * with the fifth sprite's number in the low bits, and LEGACY_COLLISION.
 */
export function renderLegacyLine(vram: Uint8Array, registers: Uint8Array, line: number, out: Uint8Array): number {
  const r0 = registers[0];
  const r1 = registers[1];
  const backdrop = registers[7] & 0x0f;
  if ((r1 & 0x40) === 0 || line >= 192) {
    out.fill(backdrop);
    return 0;
  }
  if (r1 & 0x10) {
    renderText(vram, registers, line, out, backdrop);
    return 0; // No sprites in Text mode.
  }
  if (r1 & 0x08) renderMulticolor(vram, registers, line, out, backdrop);
  else if (r0 & 0x02) renderGraphics2(vram, registers, line, out, backdrop);
  else renderGraphics1(vram, registers, line, out, backdrop);
  return renderSprites(vram, registers, line, out);
}

/** Eight pixels of a pattern byte in two colours (0 = the backdrop). */
function drawPattern(out: Uint8Array, x: number, pattern: number, foreground: number, background: number, backdrop: number): void {
  const fg = foreground || backdrop;
  const bg = background || backdrop;
  for (let bit = 0; bit < 8; bit++) out[x + bit] = pattern & (0x80 >> bit) ? fg : bg;
}

function renderGraphics1(vram: Uint8Array, registers: Uint8Array, line: number, out: Uint8Array, backdrop: number): void {
  const names = (registers[2] & 0x0f) << 10;
  const colors = registers[3] << 6;
  const patterns = (registers[4] & 0x07) << 11;
  const row = names + (line >> 3) * 32;
  for (let column = 0; column < 32; column++) {
    const name = vram[row + column];
    const color = vram[colors + (name >> 3)];
    drawPattern(out, column * 8, vram[patterns + name * 8 + (line & 7)], color >> 4, color & 0x0f, backdrop);
  }
}

function renderGraphics2(vram: Uint8Array, registers: Uint8Array, line: number, out: Uint8Array, backdrop: number): void {
  const names = (registers[2] & 0x0f) << 10;
  // R3 and R4 hold a base bit and masks that let a screen third reuse another's tables.
  const colorBase = (registers[3] & 0x80) << 6;
  const colorMask = ((registers[3] & 0x7f) << 6) | 0x3f;
  const patternBase = (registers[4] & 0x04) << 11;
  const patternMask = ((registers[4] & 0x03) << 11) | 0x7ff;
  const row = names + (line >> 3) * 32;
  const third = (line >> 6) << 8;
  for (let column = 0; column < 32; column++) {
    const offset = (((third | vram[row + column]) << 3) | (line & 7)) & 0x1fff;
    const color = vram[colorBase | (offset & colorMask)];
    drawPattern(out, column * 8, vram[patternBase | (offset & patternMask)], color >> 4, color & 0x0f, backdrop);
  }
}

function renderMulticolor(vram: Uint8Array, registers: Uint8Array, line: number, out: Uint8Array, backdrop: number): void {
  const names = (registers[2] & 0x0f) << 10;
  const patterns = (registers[4] & 0x07) << 11;
  const row = names + (line >> 3) * 32;
  const byteInPattern = ((line >> 3) & 3) * 2 + ((line >> 2) & 1);
  for (let column = 0; column < 32; column++) {
    const colors = vram[patterns + vram[row + column] * 8 + byteInPattern];
    const x = column * 8;
    out.fill(colors >> 4 || backdrop, x, x + 4);
    out.fill(colors & 0x0f || backdrop, x + 4, x + 8);
  }
}

/** 40 columns of 6-pixel characters, with 8 pixels of backdrop either side. */
function renderText(vram: Uint8Array, registers: Uint8Array, line: number, out: Uint8Array, backdrop: number): void {
  const names = (registers[2] & 0x0f) << 10;
  const patterns = (registers[4] & 0x07) << 11;
  const fg = registers[7] >> 4 || backdrop;
  out.fill(backdrop, 0, 8);
  out.fill(backdrop, 248, WIDTH);
  const row = names + (line >> 3) * 40;
  for (let column = 0; column < 40; column++) {
    const pattern = vram[patterns + vram[row + column] * 8 + (line & 7)];
    const x = 8 + column * 6;
    for (let bit = 0; bit < 6; bit++) out[x + bit] = pattern & (0x80 >> bit) ? fg : backdrop;
  }
}

/**
 * Lower-numbered sprites win, only four fit on a line (the fifth is
 * reported), and any two sprites' set pixels meeting is a collision.
 */
function renderSprites(vram: Uint8Array, registers: Uint8Array, line: number, out: Uint8Array): number {
  const attributes = (registers[5] & 0x7f) << 7;
  const patterns = (registers[6] & 0x07) << 11;
  const large = (registers[1] & 0x02) !== 0;
  const magnify = (registers[1] & 0x01) !== 0 ? 1 : 0;
  const size = (large ? 16 : 8) << magnify;
  spriteLine.fill(0);
  let flags = 0;
  let visible = 0;
  let sprite = 0;
  for (; sprite < 32; sprite++) {
    const entry = attributes + sprite * 4;
    const rawY = vram[entry];
    if (rawY === SPRITE_TERMINATOR) break;
    const y = rawY > SPRITE_TERMINATOR ? rawY - 256 : rawY;
    const row = line - (y + 1);
    if (row < 0 || row >= size) continue;
    if (visible === MAX_SPRITES_PER_LINE) {
      flags |= LEGACY_FIFTH_SPRITE | sprite;
      break;
    }
    visible++;
    const color = vram[entry + 3];
    const x = vram[entry + 1] - (color & 0x80 ? 32 : 0);
    const name = large ? vram[entry + 2] & 0xfc : vram[entry + 2];
    const patternRow = row >> magnify;
    const left = vram[patterns + name * 8 + patternRow];
    const bits = large ? (left << 8) | vram[patterns + name * 8 + 16 + patternRow] : left << 8;
    const width = large ? 16 : 8;
    const ink = color & 0x0f;
    for (let px = 0; px < width << magnify; px++) {
      if ((bits & (0x8000 >> (px >> magnify))) === 0) continue;
      const sx = x + px;
      if (sx < 0 || sx >= WIDTH) continue;
      // Bit 0: some sprite has a pixel here; bit 1: a sprite has coloured it (transparent ones don't hide those below).
      const taken = spriteLine[sx];
      if (taken & 1) flags |= LEGACY_COLLISION;
      if (ink && (taken & 2) === 0) {
        out[sx] = ink;
        spriteLine[sx] = 3;
      } else {
        spriteLine[sx] = taken | 1;
      }
    }
  }
  if ((flags & LEGACY_FIFTH_SPRITE) === 0) flags |= Math.min(sprite, 31);
  return flags;
}
