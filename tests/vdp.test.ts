import { describe, expect, it } from 'vitest';
import { STATUS_COLLISION, STATUS_FRAME, STATUS_OVERFLOW, SCREEN_WIDTH, Vdp, smsColorTo12Bit } from '../src/vdp/vdp';

function setRegister(vdp: Vdp, index: number, value: number): void {
  vdp.writeControl(value);
  vdp.writeControl(0x80 | index);
}

function writeVram(vdp: Vdp, address: number, bytes: number[]): void {
  vdp.writeControl(address & 0xff);
  vdp.writeControl(0x40 | (address >> 8));
  for (const byte of bytes) vdp.writeData(byte);
}

function writeCram(vdp: Vdp, index: number, bytes: number[]): void {
  vdp.writeControl(index);
  vdp.writeControl(0xc0);
  for (const byte of bytes) vdp.writeData(byte);
}

/** A mode 4 chip with the display on, the name table at $3800 and sprites at $3F00 (tiles from $0000). */
function mode4(): Vdp {
  const vdp = new Vdp();
  vdp.reset();
  setRegister(vdp, 0, 0x06);
  setRegister(vdp, 1, 0x40);
  setRegister(vdp, 2, 0xff);
  setRegister(vdp, 5, 0xff);
  setRegister(vdp, 6, 0xfb);
  // No sprites unless a test adds them.
  writeVram(vdp, 0x3f00, [0xd0]);
  return vdp;
}

/** Tile `tile` filled with colour `color` (all four bitplanes set from its bits). */
function solidTile(vdp: Vdp, tile: number, color: number): void {
  const row = [0, 1, 2, 3].map((plane) => (color & (1 << plane) ? 0xff : 0x00));
  writeVram(vdp, tile * 32, Array.from({ length: 8 }, () => row).flat());
}

const pixel = (vdp: Vdp, x: number, y: number) => vdp.framebuffer[y * SCREEN_WIDTH + x];

describe('ports', () => {
  it('writes registers through the control port', () => {
    const vdp = new Vdp();
    vdp.reset();
    setRegister(vdp, 7, 0x05);
    expect(vdp.registers[7]).toBe(0x05);
  });

  it('reads VRAM through a read-ahead buffer', () => {
    const vdp = new Vdp();
    writeVram(vdp, 0x1234, [0xaa, 0xbb]);
    vdp.writeControl(0x34);
    vdp.writeControl(0x12);
    expect(vdp.readData()).toBe(0xaa);
    expect(vdp.readData()).toBe(0xbb);
  });

  it('keeps 6-bit colours on the Master System and 12-bit ones on the Game Gear', () => {
    const sms = new Vdp();
    writeCram(sms, 3, [0xff]);
    expect(sms.cram[3]).toBe(0x3f);
    const gg = new Vdp();
    gg.gameGear = true;
    writeCram(gg, 4, [0x21, 0xf3]);
    expect([gg.cram[4], gg.cram[5]]).toEqual([0x21, 0x03]);
  });

  it('clears the flags and the interrupt when the status is read', () => {
    const vdp = mode4();
    setRegister(vdp, 1, 0x60);
    let irq = false;
    vdp.onInterrupt = (active) => (irq = active);
    for (let line = 0; line <= 192; line++) {
      vdp.startLine();
      vdp.endLine();
    }
    expect(irq).toBe(true);
    expect(vdp.readStatus() & STATUS_FRAME).toBe(STATUS_FRAME);
    expect(irq).toBe(false);
    expect(vdp.readStatus() & STATUS_FRAME).toBe(0);
  });
});

describe('mode 4 drawing', () => {
  it('draws tiles through the palette', () => {
    const vdp = mode4();
    solidTile(vdp, 1, 5);
    writeCram(vdp, 5, [0x0c]); // bright green
    writeVram(vdp, 0x3800, [0x01, 0x00]);
    vdp.renderLine(0);
    expect(pixel(vdp, 0, 0)).toBe(smsColorTo12Bit(0x0c));
    expect(pixel(vdp, 8, 0)).toBe(smsColorTo12Bit(0));
  });

  it('flips tiles and picks the sprite palette', () => {
    const vdp = mode4();
    // A tile with only its leftmost pixel in colour 1.
    writeVram(vdp, 32, [0x80, 0, 0, 0]);
    writeCram(vdp, 1, [0x03]);
    writeCram(vdp, 17, [0x30]);
    writeVram(vdp, 0x3800, [0x01, 0x02 | 0x08]); // horizontally flipped, sprite palette
    vdp.renderLine(0);
    expect(pixel(vdp, 7, 0)).toBe(smsColorTo12Bit(0x30));
    expect(pixel(vdp, 0, 0)).toBe(smsColorTo12Bit(0));
  });

  it('scrolls horizontally, except for the locked top rows', () => {
    const vdp = mode4();
    solidTile(vdp, 1, 1);
    writeCram(vdp, 1, [0x3f]);
    writeVram(vdp, 0x3800, [0x01, 0x00]);
    writeVram(vdp, 0x3800 + 2 * 64, [0x01, 0x00]);
    setRegister(vdp, 8, 4);
    vdp.renderLine(16);
    expect(pixel(vdp, 3, 16)).toBe(smsColorTo12Bit(0));
    expect(pixel(vdp, 4, 16)).toBe(smsColorTo12Bit(0x3f));
    setRegister(vdp, 0, 0x46);
    vdp.renderLine(0);
    expect(pixel(vdp, 0, 0)).toBe(smsColorTo12Bit(0x3f));
  });

  it('blanks the left column when asked', () => {
    const vdp = mode4();
    solidTile(vdp, 1, 1);
    writeCram(vdp, 1, [0x3f]);
    writeCram(vdp, 16 + 2, [0x01]);
    writeVram(vdp, 0x3800, [0x01, 0x00]);
    setRegister(vdp, 7, 2);
    setRegister(vdp, 0, 0x26);
    vdp.renderLine(0);
    expect(pixel(vdp, 0, 0)).toBe(smsColorTo12Bit(0x01));
  });

  it('draws sprites, eight to a line, with collisions', () => {
    const vdp = mode4();
    solidTile(vdp, 2, 3);
    writeCram(vdp, 16 + 3, [0x0f]);
    const ys = Array.from({ length: 9 }, () => 9); // line 10
    writeVram(vdp, 0x3f00, [...ys, 0xd0]);
    writeVram(vdp, 0x3f80, [10, 2, 14, 2, ...Array.from({ length: 7 }, (_, i) => [100 + i * 10, 2]).flat()]);
    vdp.renderLine(10);
    expect(pixel(vdp, 10, 10)).toBe(smsColorTo12Bit(0x0f));
    expect(pixel(vdp, 9, 10)).toBe(smsColorTo12Bit(0));
    expect(vdp.status & STATUS_OVERFLOW).toBe(STATUS_OVERFLOW);
    expect(vdp.status & STATUS_COLLISION).toBe(STATUS_COLLISION);
  });

  it('keeps tiles with the priority bit in front of sprites', () => {
    const vdp = mode4();
    solidTile(vdp, 1, 1);
    solidTile(vdp, 2, 3);
    writeCram(vdp, 1, [0x30]);
    writeCram(vdp, 16 + 3, [0x0f]);
    writeVram(vdp, 0x3800, [0x01, 0x10]);
    writeVram(vdp, 0x3f00, [0xff, 0xd0]); // y = -1: lines 0-7
    writeVram(vdp, 0x3f80, [0, 2]);
    vdp.renderLine(0);
    expect(pixel(vdp, 0, 0)).toBe(smsColorTo12Bit(0x30));
  });
});

describe('timing', () => {
  it('interrupts every R10 + 1 lines when line interrupts are on', () => {
    const vdp = mode4();
    setRegister(vdp, 0, 0x16);
    setRegister(vdp, 10, 9);
    const lines: number[] = [];
    // Run a frame so the counter is loaded in the blanking, then watch the next.
    for (let i = 0; i < 262 * 2; i++) {
      vdp.startLine();
      if (i >= 262 && vdp.interrupt) {
        lines.push(vdp.line);
        vdp.readStatus();
      }
      vdp.endLine();
    }
    expect(lines.slice(0, 3)).toEqual([9, 19, 29]);
    expect(lines).toHaveLength(19);
  });

  it('counts the V counter through the frame with its jump back', () => {
    const vdp = mode4();
    const values: number[] = [];
    for (let line = 0; line < 262; line++) {
      values.push(vdp.vCounter);
      vdp.startLine();
      vdp.endLine();
    }
    expect(values[0xda]).toBe(0xda);
    expect(values[0xdb]).toBe(0xd5);
    expect(values[261]).toBe(0xff);
  });

  it('switches to 224 lines at the next frame', () => {
    const vdp = mode4();
    setRegister(vdp, 1, 0x50);
    expect(vdp.activeLines).toBe(224);
    vdp.startLine();
    vdp.endLine();
    setRegister(vdp, 1, 0x40);
    expect(vdp.activeLines).toBe(224);
    for (let line = 1; line < 262; line++) {
      vdp.startLine();
      vdp.endLine();
    }
    vdp.startLine();
    expect(vdp.activeLines).toBe(192);
  });
});

describe('legacy modes', () => {
  it('draws Graphics I with the fixed palette', () => {
    const vdp = new Vdp();
    vdp.reset();
    setRegister(vdp, 0, 0x00);
    setRegister(vdp, 1, 0x40);
    setRegister(vdp, 2, 0x0e); // names at $3800
    setRegister(vdp, 3, 0x80); // colours at $2000
    setRegister(vdp, 4, 0x00); // patterns at $0000
    setRegister(vdp, 5, 0x7f);
    writeVram(vdp, 0x3f80, [0xd0]);
    writeVram(vdp, 0x0008, [0xf0]);
    writeVram(vdp, 0x2000, [0xf4]); // white on dark blue
    writeVram(vdp, 0x3800, [0x01]);
    vdp.renderLine(0);
    expect(pixel(vdp, 0, 0)).toBe(smsColorTo12Bit(0x3f));
    expect(pixel(vdp, 4, 0)).toBe(smsColorTo12Bit(0x10));
  });
});
