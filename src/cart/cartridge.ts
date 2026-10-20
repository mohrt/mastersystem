/** How the cartridge maps its ROM into the CPU's address space. */
export type MapperKind = 'none' | 'sega' | 'codemasters' | 'korean';

export const MAPPER_NAMES: Record<MapperKind, string> = {
  none: 'No mapper',
  sega: 'Sega mapper',
  codemasters: 'Codemasters mapper',
  korean: 'Korean mapper',
};

const BANK_SIZE = 0x4000;
/** Sega's mapper can switch in up to 32K of RAM (two 16K banks), battery-backed on cartridges that save. */
const RAM_SIZE = 0x8000;
const OPEN_BUS = 0xff;

/**
 * A cartridge: ROM seen by the CPU at $0000-$BFFF in three 16K slots, which
 * the mapper fills with any bank of the ROM.
 *
 * - Sega's mapper is driven by writes to $FFFC-$FFFF (which also land in
 *   RAM): $FFFD-$FFFF pick the banks for the three slots, though the first 1K
 *   always comes from bank 0, and $FFFC can put cartridge RAM in the third slot.
 * - Codemasters' mapper takes writes to $0000, $4000 and $8000; bit 7 of the
 *   $4000 write puts 8K of cartridge RAM at $A000-$BFFF.
 * - The Korean mapper only switches the third slot, by writes to $A000.
 * - Cartridges of 48K or less need no mapper. Small ones get 16K of RAM at
 *   $8000-$BFFF, which a few SG-1000 games carry.
 */
export class Cartridge {
  /** Offsets into the ROM of the banks in the three slots. */
  readonly slots = new Int32Array(3);
  readonly ram = new Uint8Array(RAM_SIZE);
  /** Sega mapper control ($FFFC): bit 3 maps RAM into slot 2, bit 2 picks its bank. */
  ramControl = 0;
  /** Codemasters' cartridge RAM switch. */
  codemastersRam = false;
  /** True once the game has used the cartridge RAM, so it is worth keeping. */
  ramUsed = false;
  /** Set when cartridge RAM changes, so the page knows to save it. */
  batteryDirty = false;
  private readonly bankCount: number;

  constructor(
    readonly rom: Uint8Array,
    readonly mapper: MapperKind,
  ) {
    this.bankCount = Math.max(1, Math.ceil(rom.length / BANK_SIZE));
    this.reset();
  }

  /** Power on: the mapper back to its first banks. RAM keeps its contents (it may be battery-backed). */
  reset(): void {
    this.ramControl = 0;
    this.codemastersRam = false;
    this.setSlot(0, 0);
    this.setSlot(1, 1);
    this.setSlot(2, this.mapper === 'codemasters' ? 0 : 2);
  }

  private setSlot(slot: number, bank: number): void {
    this.slots[slot] = (bank % this.bankCount) * BANK_SIZE;
  }

  private romByte(offset: number): number {
    return offset < this.rom.length ? this.rom[offset] : OPEN_BUS;
  }

  read(address: number): number {
    const slot = address >> 14;
    const offset = address & (BANK_SIZE - 1);
    switch (this.mapper) {
      case 'none':
        if (slot === 2 && this.rom.length <= 0x8000) return this.ram[offset];
        return this.romByte(address);
      case 'sega':
        if (address < 0x400) return this.rom[address];
        if (slot === 2 && this.ramControl & 0x08) return this.ram[this.segaRamOffset(offset)];
        break;
      case 'codemasters':
        if (this.codemastersRam && address >= 0xa000) return this.ram[address & 0x1fff];
        break;
    }
    return this.romByte(this.slots[slot] + offset);
  }

  private segaRamOffset(offset: number): number {
    return (this.ramControl & 0x04 ? BANK_SIZE : 0) + offset;
  }

  /** A CPU write to $0000-$BFFF. */
  write(address: number, value: number): void {
    switch (this.mapper) {
      case 'none':
        if (address >= 0x8000 && this.rom.length <= 0x8000) this.ram[address & (BANK_SIZE - 1)] = value;
        return;
      case 'sega':
        if (address >= 0x8000 && this.ramControl & 0x08) this.writeRam(this.segaRamOffset(address & (BANK_SIZE - 1)), value);
        return;
      case 'codemasters':
        if (address === 0x0000) this.setSlot(0, value);
        else if (address === 0x4000) {
          this.setSlot(1, value & 0x7f);
          this.codemastersRam = (value & 0x80) !== 0;
          if (this.codemastersRam) this.ramUsed = true;
        } else if (address === 0x8000) this.setSlot(2, value);
        else if (this.codemastersRam && address >= 0xa000) this.writeRam(address & 0x1fff, value);
        return;
      case 'korean':
        if (address === 0xa000) this.setSlot(2, value);
        return;
    }
  }

  /** A CPU write to $FFFC-$FFFF: Sega's mapper registers. */
  writeRegister(address: number, value: number): void {
    if (this.mapper !== 'sega') return;
    if (address === 0xfffc) {
      this.ramControl = value;
      if (value & 0x08) this.ramUsed = true;
    } else {
      this.setSlot(address - 0xfffd, value);
    }
  }

  private writeRam(offset: number, value: number): void {
    if (this.ram[offset] === value) return;
    this.ram[offset] = value;
    this.batteryDirty = true;
  }

  /** Cartridge RAM as it should be saved, or null if the game hasn't used any. */
  get saveData(): Uint8Array | null {
    if (!this.ramUsed) return null;
    return this.mapper === 'codemasters' ? this.ram.subarray(0, 0x2000) : this.ram;
  }

  /** Loads a save (e.g. from a .sav file); shorter or longer saves fill what fits. */
  loadSaveData(data: Uint8Array): void {
    this.ram.fill(0);
    this.ram.set(data.subarray(0, this.ram.length));
    this.ramUsed = true;
    this.batteryDirty = false;
  }
}
