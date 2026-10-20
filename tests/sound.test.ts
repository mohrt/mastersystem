import { describe, expect, it } from 'vitest';
import { Sn76489 } from '../src/sound/sn76489';
import { Ym2413 } from '../src/sound/ym2413';

describe('PSG', () => {
  it('repeats white noise every 57337 steps, as Sega\'s 16-bit register does', () => {
    const psg = new Sn76489();
    psg.write(0xe4); // white noise, fastest rate
    const start = psg.shifter;
    let shifts = 0;
    // At the fastest rate the register shifts every 32 steps of the chip's clock.
    for (let i = 0; i < 2_000_000 && (shifts === 0 || psg.shifter !== start); i++) {
      const before = psg.shifter;
      psg.tick();
      if (psg.shifter !== before) shifts++;
    }
    expect(shifts).toBe(57337);
  });

  it('holds the output high for tone periods of 0 and 1, so games can play samples', () => {
    const psg = new Sn76489();
    psg.write(0x81);
    psg.write(0x00);
    psg.write(0x90); // channel 0 at full volume
    for (let i = 0; i < 10; i++) {
      psg.tick();
      expect(psg.left).toBe(1);
    }
  });

  it('routes channels to the Game Gear\'s speakers', () => {
    const psg = new Sn76489();
    psg.write(0x80);
    psg.write(0x00);
    psg.write(0x90);
    psg.stereo = 0x10; // channel 0 on the left only
    psg.tick();
    expect(psg.left).toBe(1);
    expect(psg.right).toBe(0);
  });
});

describe('YM2413', () => {
  const write = (fm: Ym2413, register: number, value: number) => {
    fm.writeAddress(register);
    fm.writeData(value);
  };

  /** A pure tone: the game's own instrument with the modulator turned right down. */
  function sine(fm: Ym2413): void {
    [0x01, 0x21, 0x3f, 0x00, 0xf0, 0xf0, 0x0f, 0x0f].forEach((value, register) => write(fm, register, value));
  }

  it('plays A at 440 Hz from F-number 290 in block 4', () => {
    const fm = new Ym2413();
    sine(fm);
    write(fm, 0x30, 0x00); // instrument 0, full volume
    write(fm, 0x10, 290 & 0xff);
    write(fm, 0x20, 0x10 | (4 << 1) | (290 >> 8));
    let crossings = 0;
    let last = 0;
    for (let i = 0; i < 49716; i++) {
      const sample = fm.tick();
      if (last <= 0 && sample > 0) crossings++;
      last = sample;
    }
    expect(crossings).toBeGreaterThanOrEqual(438);
    expect(crossings).toBeLessThanOrEqual(442);
  });

  it('fades out after the key is released', () => {
    const fm = new Ym2413();
    write(fm, 0x30, 0x30); // piano
    write(fm, 0x10, 0x20);
    write(fm, 0x20, 0x18);
    const peak = (samples: number) => {
      let max = 0;
      for (let i = 0; i < samples; i++) max = Math.max(max, Math.abs(fm.tick()));
      return max;
    };
    expect(peak(2000)).toBeGreaterThan(0.1);
    write(fm, 0x20, 0x08);
    peak(49716);
    expect(peak(1000)).toBe(0);
  });

  it('plays the drums in rhythm mode', () => {
    const fm = new Ym2413();
    write(fm, 0x16, 0x20);
    write(fm, 0x26, 0x05);
    write(fm, 0x36, 0x00);
    write(fm, 0x0e, 0x30); // rhythm mode, bass drum
    let max = 0;
    for (let i = 0; i < 2000; i++) max = Math.max(max, Math.abs(fm.tick()));
    expect(max).toBeGreaterThan(0.1);
  });
});
