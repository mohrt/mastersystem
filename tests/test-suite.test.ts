import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import type { Region, System, TvSystem } from '../src/cart/detect';
import { MasterSystem } from '../src/sms';

// sverx's SMS Test Suite works out which console it is on (from port $3E, sprite zoom and
// the V counter) and looks for the FM chip, and prints what it found at the bottom of its
// menu. `npm run fetch:test-roms` downloads it.
const path = join(import.meta.dirname, 'fixtures', 'test-roms', 'SMSTestSuite.sms');
const NAME_TABLE = 0x3800;

/** The screen's text, read back from the name table: its font's tiles are in ASCII order. */
function screenText(machine: MasterSystem): string {
  const vram = machine.vdp.vram;
  const tiles = Array.from({ length: 32 * 24 }, (_, i) => vram[NAME_TABLE + i * 2] | ((vram[NAME_TABLE + i * 2 + 1] & 1) << 8));
  // Find where the font starts from the known label.
  const label = ' Model:';
  for (let start = 0; start < tiles.length - label.length; start++) {
    const offset = tiles[start] - label.charCodeAt(0);
    if ([...label].every((char, i) => tiles[start + i] - offset === char.charCodeAt(0))) {
      return tiles.map((tile, i) => (i % 32 === 0 ? '\n' : '') + String.fromCharCode(Math.max(32, Math.min(126, tile - offset)))).join('');
    }
  }
  return '';
}

function run(system: System, region: Region, tv: TvSystem, fm: boolean): string {
  const machine = new MasterSystem();
  machine.setSystem(system);
  machine.setRegion(region);
  machine.setTv(tv);
  machine.setFm(fm);
  machine.insertCartridge(new Cartridge(new Uint8Array(readFileSync(path)), 'sega'));
  for (let frame = 0; frame < 120; frame++) machine.runFrame();
  return screenText(machine);
}

describe.skipIf(!existsSync(path))('SMS Test Suite', () => {
  it('sees an American Master System II', () => {
    const text = run('sms', 'export', 'ntsc', false);
    expect(text).toContain('Model:Master System II');
    expect(text).toContain('Region:USA/BRA');
    expect(text).toContain('TV:60Hz');
    expect(text).not.toContain('FM audio chip');
  });

  it('sees a European one', () => {
    const text = run('sms', 'export', 'pal', false);
    expect(text).toContain('Region:EUR/AUS');
    expect(text).toContain('TV:50Hz');
  });

  it('sees a Japanese one with its FM chip', () => {
    const text = run('sms', 'japan', 'ntsc', true);
    expect(text).toContain('Region:JPN/KOR');
    expect(text).toContain('FM audio chip detected!');
  });

  it('sees a Game Gear in its Master System mode', () => {
    expect(run('gg-sms', 'export', 'ntsc', false)).toContain('Model:Game Gear');
  });
});
