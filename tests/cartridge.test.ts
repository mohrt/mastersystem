import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { detectRom, stripCopierHeader } from '../src/cart/detect';
import { romWith } from './helpers/rom';

/** Which bank is in a slot, from the bank number each bank ends with. */
const bankIn = (cart: Cartridge, slot: number) => cart.read(slot * 0x4000 + 0x3fff);

describe('Sega mapper', () => {
  it('starts with banks 0-2 and switches through $FFFD-$FFFF', () => {
    const cart = new Cartridge(romWith({}, 0x20000), 'sega');
    expect([0, 1, 2].map((slot) => bankIn(cart, slot))).toEqual([0, 1, 2]);
    cart.writeRegister(0xfffd, 3);
    cart.writeRegister(0xfffe, 4);
    cart.writeRegister(0xffff, 7);
    expect([0, 1, 2].map((slot) => bankIn(cart, slot))).toEqual([3, 4, 7]);
  });

  it('keeps the first 1K on bank 0', () => {
    const rom = romWith({ 0x0000: [0x11], 0x4000: [0x22] }, 0x10000);
    const cart = new Cartridge(rom, 'sega');
    cart.writeRegister(0xfffd, 1);
    expect(cart.read(0x0000)).toBe(0x11);
    expect(cart.read(0x0400)).toBe(rom[0x4400]);
  });

  it('wraps bank numbers around the ROM size', () => {
    const cart = new Cartridge(romWith({}, 0x10000), 'sega');
    cart.writeRegister(0xffff, 5);
    expect(bankIn(cart, 2)).toBe(1);
  });

  it('puts battery RAM in the third slot', () => {
    const cart = new Cartridge(romWith({}, 0x20000), 'sega');
    expect(cart.saveData).toBeNull();
    cart.writeRegister(0xfffc, 0x08);
    cart.write(0x8000, 0x42);
    expect(cart.read(0x8000)).toBe(0x42);
    expect(cart.batteryDirty).toBe(true);
    cart.writeRegister(0xfffc, 0x0c);
    expect(cart.read(0x8000)).toBe(0);
    cart.writeRegister(0xfffc, 0x00);
    expect(bankIn(cart, 2)).toBe(2);
    expect(cart.saveData?.[0]).toBe(0x42);
  });
});

describe('other mappers', () => {
  it('switches Codemasters banks by writes to $0000, $4000 and $8000', () => {
    const cart = new Cartridge(romWith({}, 0x40000), 'codemasters');
    expect([0, 1, 2].map((slot) => bankIn(cart, slot))).toEqual([0, 1, 0]);
    cart.write(0x0000, 5);
    cart.write(0x4000, 6);
    cart.write(0x8000, 9);
    expect([0, 1, 2].map((slot) => bankIn(cart, slot))).toEqual([5, 6, 9]);
  });

  it('switches the Korean mapper by writes to $A000', () => {
    const cart = new Cartridge(romWith({}, 0x40000), 'korean');
    cart.write(0xa000, 7);
    expect(bankIn(cart, 2)).toBe(7);
  });
});

describe('detection', () => {
  function withHeader(code: number, size = 0x8000): Uint8Array {
    const rom = new Uint8Array(size);
    rom.set(new TextEncoder().encode('TMR SEGA'), 0x7ff0);
    rom[0x7fff] = (code << 4) | 0x0c;
    return rom;
  }

  it('reads the console and region from the header', () => {
    expect(detectRom(withHeader(4), 'game.sms')).toMatchObject({ system: 'sms', region: 'export', hasHeader: true });
    expect(detectRom(withHeader(3), 'game.sms')).toMatchObject({ system: 'sms', region: 'japan' });
    expect(detectRom(withHeader(6), 'game.gg')).toMatchObject({ system: 'gg', region: 'export' });
    expect(detectRom(withHeader(4), 'game.gg')).toMatchObject({ system: 'gg-sms' });
  });

  it('falls back to the file name', () => {
    const rom = new Uint8Array(0x8000);
    expect(detectRom(rom, 'Game (Japan).sms')).toMatchObject({ region: 'japan', tv: null, hasHeader: false });
    expect(detectRom(rom, 'Game (Europe).sms')).toMatchObject({ region: 'export', tv: 'pal' });
    expect(detectRom(rom, 'Game (USA, Europe).sms')).toMatchObject({ tv: null });
    expect(detectRom(rom, 'Game.sg')).toMatchObject({ region: 'japan' });
  });

  it('picks the mapper', () => {
    expect(detectRom(new Uint8Array(0x8000), 'a.sms').mapper).toBe('none');
    expect(detectRom(new Uint8Array(0x40000), 'a.sms').mapper).toBe('sega');
    const codemasters = new Uint8Array(0x40000);
    codemasters.set([0x34, 0x12, 0xcc, 0xed], 0x7fe6);
    expect(detectRom(codemasters, 'a.sms').mapper).toBe('codemasters');
  });

  it('drops a copier header', () => {
    expect(stripCopierHeader(new Uint8Array(0x8000 + 512)).length).toBe(0x8000);
    expect(stripCopierHeader(new Uint8Array(0x8000)).length).toBe(0x8000);
  });
});
