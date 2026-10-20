import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/util/crc32';
import type { MasterSystem } from '../../src/sms';
import { GG_HEIGHT, GG_LEFT, GG_WIDTH, SCREEN_WIDTH } from '../../src/vdp/vdp';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes the machine's last picture (the Game Gear's window of it, on a Game Gear) as an RGB PNG, each pixel drawn 2x2. */
export function framePng(machine: MasterSystem): Uint8Array {
  const pixels = machine.vdp.framebuffer;
  const lines = machine.vdp.activeLines;
  const gameGear = machine.system === 'gg';
  const left = gameGear ? GG_LEFT : 0;
  const top = gameGear ? (lines - GG_HEIGHT) >> 1 : 0;
  const width = (gameGear ? GG_WIDTH : SCREEN_WIDTH) * 2;
  const height = (gameGear ? GG_HEIGHT : lines) * 2;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const color = pixels[(top + (y >> 1)) * SCREEN_WIDTH + left + (x >> 1)];
      raw.set([(color & 0x0f) * 17, ((color >> 4) & 0x0f) * 17, ((color >> 8) & 0x0f) * 17], row + 1 + x * 3);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
