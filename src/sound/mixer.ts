import type { Sn76489 } from './sn76489';
import type { Ym2413 } from './ym2413';

/** The PSG steps once every 16 CPU cycles; the FM chip makes a sample every 72. */
export const PSG_CYCLES_PER_TICK = 16;
export const FM_CYCLES_PER_SAMPLE = 72;
/** The PSG's four channels at full volume reach 4; the FM chip's channels about ±1 each. */
const PSG_GAIN = 0.5 / 4;
const FM_GAIN = 0.5 / 6;
/** A gentle high-pass that takes away the chips' DC offset. */
const DC_BLOCK = 0.995;

/** Which chips can be heard; the FM unit's control port switches them. */
export interface SoundRouting {
  readonly psgAudible: boolean;
  readonly fmAudible: boolean;
  readonly fmPresent: boolean;
}

/**
 * Runs the sound chips in step with the CPU and resamples their output to
 * the audio device's rate, averaging the steps that fall in each sample.
 * Output is stereo, interleaved (left, right), for the Game Gear's stereo.
 */
export class AudioMixer {
  private cyclePhase = 0;
  private fmPhase = 0;
  private fmLevel = 0;
  private ticksPerSample = 1;
  private position = 0;
  private sumLeft = 0;
  private sumRight = 0;
  private count = 0;
  private readonly lastIn = [0, 0];
  private readonly lastOut = [0, 0];
  private buffer = new Float32Array(8192);
  private length = 0;

  constructor(
    private readonly psg: Sn76489,
    private readonly fm: Ym2413,
    private readonly routing: SoundRouting,
  ) {}

  setRates(cpuHz: number, sampleRate: number): void {
    this.ticksPerSample = cpuHz / PSG_CYCLES_PER_TICK / sampleRate;
  }

  /** Advances the chips by `cycles` CPU cycles. */
  run(cycles: number): void {
    this.cyclePhase += cycles;
    const { psg, fm, routing } = this;
    const fmRunning = routing.fmPresent;
    const psgGain = routing.psgAudible ? PSG_GAIN : 0;
    const fmGain = routing.fmAudible ? FM_GAIN : 0;
    while (this.cyclePhase >= PSG_CYCLES_PER_TICK) {
      this.cyclePhase -= PSG_CYCLES_PER_TICK;
      psg.tick();
      if (fmRunning) {
        this.fmPhase += PSG_CYCLES_PER_TICK;
        if (this.fmPhase >= FM_CYCLES_PER_SAMPLE) {
          this.fmPhase -= FM_CYCLES_PER_SAMPLE;
          this.fmLevel = fm.tick();
        }
      }
      const fmLevel = this.fmLevel * fmGain;
      this.sumLeft += psg.left * psgGain + fmLevel;
      this.sumRight += psg.right * psgGain + fmLevel;
      this.count++;
      this.position++;
      if (this.position >= this.ticksPerSample) {
        this.position -= this.ticksPerSample;
        this.emit(this.sumLeft / this.count, this.sumRight / this.count);
        this.sumLeft = this.sumRight = this.count = 0;
      }
    }
  }

  private filter(channel: number, value: number): number {
    const out = value - this.lastIn[channel] + DC_BLOCK * this.lastOut[channel];
    this.lastIn[channel] = value;
    this.lastOut[channel] = out;
    return out;
  }

  private emit(left: number, right: number): void {
    if (this.length + 2 > this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = this.filter(0, left);
    this.buffer[this.length++] = this.filter(1, right);
  }

  /** The samples made since the last call, interleaved left and right. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
