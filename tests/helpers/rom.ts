import { Cartridge, type MapperKind } from '../../src/cart/cartridge';
import { MasterSystem } from '../../src/sms';

/** A ROM of `size` bytes where each 16K bank starts with its own number, and code placed at given addresses. */
export function romWith(code: Record<number, number[]> = {}, size = 0x8000): Uint8Array {
  const rom = new Uint8Array(size);
  for (let bank = 0; bank * 0x4000 < size; bank++) rom[bank * 0x4000 + 0x3fff] = bank;
  for (const [address, bytes] of Object.entries(code)) rom.set(bytes, Number(address));
  return rom;
}

/** A Master System with `rom` in it, switched on. */
export function machineWith(rom: Uint8Array, mapper: MapperKind = rom.length > 0xc000 ? 'sega' : 'none'): MasterSystem {
  const machine = new MasterSystem();
  machine.insertCartridge(new Cartridge(rom, mapper));
  return machine;
}
