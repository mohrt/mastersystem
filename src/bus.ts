import type { Cartridge } from './cart/cartridge';
import type { Region, System } from './cart/detect';
import type { Z80Bus } from './cpu/z80';
import { Button, type Controllers } from './io/controllers';
import type { Sn76489 } from './sound/sn76489';
import type { Ym2413 } from './sound/ym2413';
import type { Vdp } from './vdp/vdp';

const RAM_SIZE = 0x2000;
const OPEN_BUS = 0xff;
/** Port $3E bits that switch memory off. The BIOS leaves $AB: cartridge and RAM on, BIOS, card and expansion off. */
const CARTRIDGE_OFF = 0x40;
const RAM_OFF = 0x10;
const BIOS_OFF = 0x08;
const BIOS_MEMORY_CONTROL = 0xab;
/** At power on only the BIOS (with RAM and the I/O chip) is switched on; it looks for a game and switches to it. */
const POWER_ON_MEMORY_CONTROL = 0xe3;
const GG_BIOS_SIZE = 0x400;

/** Port $3F: bits 0-3 set a pin as an input (TR A, TH A, TR B, TH B); bits 4-7 are the levels output on them. */
const TR_A_INPUT = 0x01;
const TH_A_INPUT = 0x02;
const TR_B_INPUT = 0x04;
const TH_B_INPUT = 0x08;
const TH_A_LEVEL = 0x20;

/** What the Game Gear's serial ports (1-5) read when nothing is plugged into the link socket. */
const GG_SERIAL_PORTS = [0x7f, 0xff, 0x00, 0xff, 0x00];

/**
 * The Master System's memory map and I/O decoding (and the Game Gear's extra ports).
 *
 * Memory: the cartridge at $0000-$BFFF, through its mapper; 8K of RAM at
 * $C000-$DFFF, repeated at $E000-$FFFF. Writes to $FFFC-$FFFF also go to
 * Sega's mapper. The Master System's BIOS sits in the same space as the
 * cartridge (with a mapper of its own), and port $3E picks which is on. The
 * Game Gear's 1K BIOS covers the cartridge's first 1K until it switches off.
 *
 * I/O: address lines A7, A6 and A0 pick the device. $3E (memory control) and
 * $3F (I/O control) for A7 A6 = 00; the V and H counters (reads) or the sound
 * chip (writes) for 01; the video chip's data and control ports for 10; the
 * controller ports $DC and $DD for 11. With the FM unit fitted, $F0-$F2 are
 * its address, data and control ports. The Game Gear has its Start button,
 * region and serial ports at $00-$05 and its stereo register at $06.
 */
export class SmsBus implements Z80Bus {
  readonly ram = new Uint8Array(RAM_SIZE);
  cartridge: Cartridge | null = null;
  /** The Master System's BIOS, wired like a cartridge; null starts games directly. */
  bios: Cartridge | null = null;
  /** The Game Gear's BIOS (1K); null starts games directly. */
  ggBios: Uint8Array | null = null;
  system: System = 'sms';
  region: Region = 'export';
  pal = false;
  /** Whether the FM sound unit is fitted. */
  fmPresent = false;
  /** Port $F2: which sound chips are heard (bits 0-1), and what the FM detection reads back. */
  fmControl = 0;
  memoryControl = 0;
  ioControl = 0xff;
  /** The H counter, latched when port A's TH pin goes high (light guns use this). */
  hCounterLatch = 0;
  /** True while the console's Reset button is held (games read it from port $DD). */
  resetHeld = false;
  /** How many CPU cycles into the current line the CPU is, for the H counter. */
  lineCycle: () => number = () => 0;

  constructor(
    private readonly vdp: Vdp,
    private readonly psg: Sn76489,
    private readonly fm: Ym2413,
    private readonly controllers: Controllers,
  ) {}

  reset(): void {
    this.memoryControl = this.hasBios ? POWER_ON_MEMORY_CONTROL : BIOS_MEMORY_CONTROL;
    this.ioControl = 0xff;
    this.fmControl = 0;
    this.hCounterLatch = 0;
  }

  private get gameGear(): boolean {
    return this.system !== 'sms';
  }

  /** Whether this console has a BIOS to start from. */
  get hasBios(): boolean {
    return this.gameGear ? this.ggBios !== null : this.bios !== null;
  }

  /**
   * Port $3E can switch the cartridge slot (bit 6), work RAM (bit 4) and
   * BIOS (bit 3) off. The Game Gear only has the BIOS switch.
   */
  private enabled(bit: number): boolean {
    if (this.gameGear && bit !== BIOS_OFF) return true;
    return (this.memoryControl & bit) === 0;
  }

  read(address: number): number {
    if (address >= 0xc000) return this.enabled(RAM_OFF) ? this.ram[address & (RAM_SIZE - 1)] : OPEN_BUS;
    if (this.gameGear) {
      if (this.ggBios && address < GG_BIOS_SIZE && this.enabled(BIOS_OFF)) return this.ggBios[address];
      return this.cartridge ? this.cartridge.read(address) : OPEN_BUS;
    }
    // With both on, the two drive the bus at once and zeros win.
    let value = OPEN_BUS;
    if (this.bios && this.enabled(BIOS_OFF)) value &= this.bios.read(address);
    if (this.cartridge && this.enabled(CARTRIDGE_OFF)) value &= this.cartridge.read(address);
    return value;
  }

  write(address: number, value: number): void {
    if (address < 0xc000) {
      if (this.enabled(CARTRIDGE_OFF)) this.cartridge?.write(address, value);
      if (!this.gameGear && this.enabled(BIOS_OFF)) this.bios?.write(address, value);
      return;
    }
    if (this.enabled(RAM_OFF)) this.ram[address & (RAM_SIZE - 1)] = value;
    if (address >= 0xfffc) {
      this.cartridge?.writeRegister(address, value);
      if (!this.gameGear) this.bios?.writeRegister(address, value);
    }
  }

  input(port: number): number {
    port &= 0xff;
    if (this.gameGear && port < 0x07) return this.gameGearInput(port);
    switch (port & 0xc1) {
      case 0x00:
      case 0x01:
        return OPEN_BUS;
      case 0x40:
        return this.vdp.vCounter;
      case 0x41:
        return this.hCounterLatch;
      case 0x80:
        return this.vdp.readData();
      case 0x81:
        return this.vdp.readStatus();
      case 0xc0:
        if (this.fmPresent && port === 0xf2) return this.fmControl;
        return this.portA();
      default:
        return this.portB();
    }
  }

  output(port: number, value: number): void {
    port &= 0xff;
    if (this.gameGear && port < 0x07) {
      if (port === 0x06) this.psg.stereo = value;
      return;
    }
    switch (port & 0xc1) {
      case 0x00:
        this.memoryControl = value;
        return;
      case 0x01:
        this.writeIoControl(value);
        return;
      case 0x40:
      case 0x41:
        this.psg.write(value);
        return;
      case 0x80:
        this.vdp.writeData(value);
        return;
      case 0x81:
        this.vdp.writeControl(value);
        return;
    }
    if (!this.fmPresent) return;
    if (port === 0xf0) this.fm.writeAddress(value);
    else if (port === 0xf1) this.fm.writeData(value);
    else if (port === 0xf2) this.fmControl = value & 0x07;
  }

  /** Whether the sound chips can be heard: the FM unit's control port can switch either off. */
  get psgAudible(): boolean {
    if (!this.fmPresent) return true;
    const mode = this.fmControl & 3;
    return mode === 0 || mode === 3;
  }

  get fmAudible(): boolean {
    return this.fmPresent && (this.fmControl & 1) !== 0;
  }

  // --- Controller ports -------------------------------------------------------------

  private writeIoControl(value: number): void {
    const thWasHigh = this.thALevel;
    this.ioControl = value;
    if (!thWasHigh && this.thALevel) this.hCounterLatch = this.hCounter();
  }

  private get thALevel(): boolean {
    return (this.ioControl & TH_A_INPUT) !== 0 || (this.ioControl & TH_A_LEVEL) !== 0;
  }

  /**
   * The H counter: the pixel position on the line, halved. It counts $00-$93
   * through the picture and border, then jumps to $E9-$FF in the blanking.
   */
  private hCounter(): number {
    const value = Math.floor((this.lineCycle() * 3) / 4);
    return value > 0x93 ? (value + 0x55) & 0xff : value;
  }

  /**
   * A TR or TH pin set as an output reads back the level written to it (TR
   * is button 2's line, so this overrides the button). Japanese consoles read
   * their TH pins back inverted, which is how games tell them apart.
   */
  private outputPin(value: number, bit: number, inputBit: number, levelBit: number, inverted = false): number {
    if (this.ioControl & inputBit) return value;
    const high = ((this.ioControl & levelBit) !== 0) !== inverted;
    return high ? value | bit : value & ~bit;
  }

  /** Port $DC: player 1's pad and player 2's up and down (0 = pressed). */
  private portA(): number {
    const one = this.controllers.buttons(0);
    if (this.gameGear) return (~one & 0x3f) | 0xc0;
    const two = this.controllers.buttons(1);
    const value = ~((one & 0x3f) | ((two & (Button.Up | Button.Down)) << 6)) & 0xff;
    return this.outputPin(value, 0x20, TR_A_INPUT, 0x10);
  }

  /** Port $DD: the rest of player 2's pad, the Reset button, and the TH pins (TH reads high as an input). */
  private portB(): number {
    if (this.gameGear) return OPEN_BUS;
    const two = this.controllers.buttons(1);
    let value = (~(two >> 2) & 0x0f) | 0xe0;
    if (!this.resetHeld) value |= 0x10;
    const japan = this.region === 'japan';
    value = this.outputPin(value, 0x08, TR_B_INPUT, 0x40);
    value = this.outputPin(value, 0x40, TH_A_INPUT, TH_A_LEVEL, japan);
    return this.outputPin(value, 0x80, TH_B_INPUT, 0x80, japan);
  }

  /** Port $00 has Start (bit 7, 0 = pressed), and the region (bit 6) and TV system (bit 5) of the Game Gear. */
  private gameGearInput(port: number): number {
    if (port === 0x00) {
      let value = 0;
      // In Master System mode Start is the Pause button instead, wired to NMI.
      if (!(this.system === 'gg' && this.controllers.start)) value |= 0x80;
      if (this.region === 'export') value |= 0x40;
      if (this.pal) value |= 0x20;
      return value;
    }
    return port < 6 ? GG_SERIAL_PORTS[port - 1] : OPEN_BUS;
  }
}
