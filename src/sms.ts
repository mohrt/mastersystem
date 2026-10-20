import { SmsBus } from './bus';
import type { Cartridge } from './cart/cartridge';
import type { Region, System, TvSystem } from './cart/detect';
import { Z80 } from './cpu/z80';
import { Controllers } from './io/controllers';
import { AudioMixer } from './sound/mixer';
import { Sn76489 } from './sound/sn76489';
import { Ym2413 } from './sound/ym2413';
import { captureState, restoreState, type StateNode } from './state/snapshot';
import { Vdp } from './vdp/vdp';

/** The Z80 runs at the video chip's crystal divided by 3 (the Game Gear's NTSC rate everywhere). */
export const CPU_HZ: Record<TvSystem, number> = { ntsc: 3_579_545, pal: 3_546_893 };
/** A line is 342 pixel clocks, and the CPU clock is two thirds of the pixel clock. */
export const CYCLES_PER_LINE = 228;
/** How long the Reset button is held for when pressed from the page (games poll it). */
const RESET_HOLD_FRAMES = 6;
/** Where the BIOS leaves the stack, for games started without it. */
const BIOS_STACK = 0xdff0;
/** The BIOS leaves its last port $3E value in the first byte of RAM; a few games look. */
const BIOS_MEMORY_CONTROL = 0xab;

/**
 * The whole console: Z80, the video chip (with the PSG in it), 8K of RAM, two
 * controller ports, a cartridge and, on Japanese consoles, the FM sound unit.
 * Runs a scanline at a time; the video chip's interrupt drives the Z80's IRQ
 * and the Pause button its NMI. As a Game Gear it has one pad with a Start
 * button, a 12-bit palette, stereo sound and a smaller window on the picture.
 */
export class MasterSystem {
  readonly vdp = new Vdp();
  readonly psg = new Sn76489();
  readonly fm = new Ym2413();
  readonly controllers = new Controllers();
  readonly bus = new SmsBus(this.vdp, this.psg, this.fm, this.controllers);
  readonly cpu = new Z80(this.bus);
  readonly audio = new AudioMixer(this.psg, this.fm, this.bus);
  system: System = 'sms';
  region: Region = 'export';
  tv: TvSystem = 'ntsc';
  frames = 0;
  /** CPU cycles the last line overran by, taken off the next one. */
  overrun = 0;
  /** Cycles run so far on the current line. */
  lineCycle = 0;
  /** Frames left holding the Reset button. */
  resetFrames = 0;
  /** Whether Start (the Pause button) was held last frame, so a press sends one NMI. */
  startWasHeld = false;
  /** Called with each finished picture (12-bit colours, 256 pixels wide, `lines` tall). */
  onFrame: (framebuffer: Uint16Array, lines: number) => void = () => {};

  constructor() {
    this.vdp.onInterrupt = (active) => (this.cpu.irq = active);
    this.bus.lineCycle = () => this.lineCycle;
    this.powerOn();
  }

  get clockHz(): number {
    return CPU_HZ[this.tv];
  }

  get cartridge(): Cartridge | null {
    return this.bus.cartridge;
  }

  /** Changing cartridges means switching off first. */
  insertCartridge(cartridge: Cartridge | null): void {
    this.bus.cartridge = cartridge;
    this.powerOn();
  }

  setSystem(system: System): void {
    this.system = system;
    this.bus.system = system;
    this.vdp.gameGear = system === 'gg';
  }

  setRegion(region: Region): void {
    this.region = region;
    this.bus.region = region;
  }

  setTv(tv: TvSystem): void {
    this.tv = tv;
    this.vdp.setTv(tv);
    this.bus.pal = tv === 'pal';
  }

  /** Fits or removes the FM sound unit (takes effect at once; games look for it when they start). */
  setFm(present: boolean): void {
    this.bus.fmPresent = present;
    if (!present) this.fm.reset();
  }

  get fmPresent(): boolean {
    return this.bus.fmPresent;
  }

  /** Power on: everything back to its initial state, RAM cleared. Starts the game as the BIOS would. */
  powerOn(): void {
    this.bus.ram.fill(0);
    this.bus.ram[0] = BIOS_MEMORY_CONTROL;
    this.cartridge?.reset();
    this.restart();
  }

  /** What the console's reset line does: the chips and CPU restart; RAM keeps its contents. */
  private restart(): void {
    this.vdp.reset();
    this.psg.reset();
    this.fm.reset();
    this.bus.reset();
    this.cpu.reset();
    this.cpu.sp = BIOS_STACK;
    this.cpu.im = 1;
    this.cpu.irq = false;
    this.overrun = 0;
    this.resetFrames = 0;
    this.bus.resetHeld = false;
  }

  /**
   * The Reset button. The first Master System's is an ordinary button games
   * read from port $DD; on the Master System II and the Game Gear, which have
   * none, the console restarts instead.
   */
  pressReset(): void {
    if (!this.cartridge) return;
    if (this.system === 'sms') {
      this.resetFrames = RESET_HOLD_FRAMES;
      this.bus.resetHeld = true;
    } else {
      this.restart();
    }
  }

  /** Runs one scanline: the video chip starts it (drawing it if it is in the picture), then the CPU runs its share. */
  runLine(): void {
    const finished = this.vdp.startLine();
    if (this.vdp.line === 0) this.startFrame();
    const budget = CYCLES_PER_LINE - this.overrun;
    let ran = 0;
    while (ran < budget) {
      this.lineCycle = ran;
      ran += this.cpu.step();
    }
    this.overrun = ran - budget;
    this.audio.run(ran);
    this.vdp.endLine();
    if (finished) {
      this.frames++;
      this.onFrame(this.vdp.framebuffer, this.vdp.activeLines);
    }
  }

  /** Once a frame: the Pause button and the Reset button's hold. */
  private startFrame(): void {
    const start = this.controllers.start;
    // On the Game Gear proper, Start is read from port $00; elsewhere it is the Pause button.
    if (start && !this.startWasHeld && this.system !== 'gg') this.cpu.nmi();
    this.startWasHeld = start;
    if (this.resetFrames > 0 && --this.resetFrames === 0) this.bus.resetHeld = false;
  }

  /** Runs lines until the next picture is complete. */
  runFrame(): void {
    const target = this.frames + 1;
    while (this.frames < target) this.runLine();
  }

  /** Everything in the console except the cartridge ROM (mapper state and cartridge RAM included). */
  saveState(): StateNode {
    return captureState(this);
  }

  /** Restores a saved state; the same cartridge must already be in. */
  loadState(state: StateNode): void {
    restoreState(this, state);
    this.setSystem(this.system);
    this.setRegion(this.region);
    this.setTv(this.tv);
  }
}
