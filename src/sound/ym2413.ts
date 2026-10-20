/**
 * The Yamaha YM2413 (OPLL), the FM sound chip in the Japanese Master System
 * and the Mark III's FM Sound Unit. It runs at its input clock divided by 72
 * (about 49.7 kHz on the Master System) and makes one sample per `tick`.
 *
 * Nine two-operator FM channels play one of 15 built-in instruments or one
 * the game defines in registers 0-7. In rhythm mode the last three channels
 * become five drums: bass drum, snare, tom-tom, top cymbal and hi-hat.
 *
 * Levels follow the chip's logarithmic arithmetic: a quarter-wave log-sine
 * table, attenuation added in the log domain (the envelope in 0.375 dB steps,
 * total level, volume, key scaling and tremolo), then an exponent table.
 */

/**
 * The built-in instruments: 15 melodic ones (0 is the game's own, in
 * registers 0-7) and three for the drums, as read from the chip.
 */
const PATCHES: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x71, 0x61, 0x1e, 0x17, 0xd0, 0x78, 0x00, 0x17], // Violin
  [0x13, 0x41, 0x1a, 0x0d, 0xd8, 0xf7, 0x23, 0x13], // Guitar
  [0x13, 0x01, 0x99, 0x00, 0xf2, 0xc4, 0x21, 0x23], // Piano
  [0x11, 0x61, 0x0e, 0x07, 0x8d, 0x64, 0x70, 0x27], // Flute
  [0x32, 0x21, 0x1e, 0x06, 0xe1, 0x76, 0x01, 0x28], // Clarinet
  [0x31, 0x22, 0x16, 0x05, 0xe0, 0x71, 0x00, 0x18], // Oboe
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x11, 0x07], // Trumpet
  [0x33, 0x21, 0x2d, 0x13, 0xb0, 0x70, 0x00, 0x07], // Organ
  [0x61, 0x61, 0x1b, 0x06, 0x64, 0x65, 0x10, 0x17], // Horn
  [0x41, 0x61, 0x0b, 0x18, 0x85, 0xf0, 0x81, 0x07], // Synthesizer
  [0x33, 0x01, 0x83, 0x11, 0xea, 0xef, 0x10, 0x04], // Harpsichord
  [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12], // Vibraphone
  [0x61, 0x50, 0x0c, 0x05, 0xd2, 0xf5, 0x40, 0x42], // Synthesizer bass
  [0x01, 0x01, 0x55, 0x03, 0xe9, 0x90, 0x03, 0x02], // Acoustic bass
  [0x41, 0x41, 0x89, 0x03, 0xf1, 0xe4, 0xc0, 0x13], // Electric guitar
  [0x01, 0x01, 0x18, 0x0f, 0xdf, 0xf8, 0x6a, 0x6d], // Bass drum
  [0x01, 0x01, 0x00, 0x00, 0xc8, 0xd8, 0xa7, 0x68], // Hi-hat (modulator) and snare drum (carrier)
  [0x05, 0x01, 0x00, 0x00, 0xf8, 0xaa, 0x59, 0x55], // Tom-tom (modulator) and top cymbal (carrier)
];
const BASS_DRUM_PATCH = 16;

/** Frequency multipliers, doubled so ½ is a whole number. */
const MULTIPLIERS_X2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];
/** Key scaling levels at 3 dB an octave (envelope steps) for block 8, by the top four bits of the F-number. */
const KSL_LEVELS = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
/** Vibrato: F-number offsets (in halves) by the F-number's top three bits and the vibrato step. */
const VIBRATO = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, -1, 0],
  [0, 1, 2, 1, 0, -1, -2, -1],
  [0, 1, 3, 1, 0, -1, -3, -1],
  [0, 2, 4, 2, 0, -2, -4, -2],
  [0, 2, 5, 2, 0, -2, -5, -2],
  [0, 3, 6, 3, 0, -3, -6, -3],
  [0, 3, 7, 3, 0, -3, -7, -3],
];
/** The vibrato steps through its eight values once every 8192 samples (about 6 Hz). */
const VIBRATO_STEP_SAMPLES = 1024;
/** Tremolo: a triangle wave of up to 13 envelope steps (4.875 dB), about 3.7 times a second. */
const TREMOLO_PERIOD = 13_436;
const TREMOLO_DEPTH = 13;

/** Phase is kept with 19 fractional bits per cycle; the sine table takes the top 10. */
const PHASE_BITS = 19;
const PHASE_MASK = (1 << PHASE_BITS) - 1;
const SINE_SHIFT = PHASE_BITS - 10;

/** -log2(sin) of a quarter wave, in 1/256ths of an octave. */
const LOG_SIN = Uint16Array.from({ length: 256 }, (_, i) =>
  Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256),
);
/** 2^(-i/256), scaled to 12 bits. */
const EXP = Uint16Array.from({ length: 256 }, (_, i) => Math.round(4096 * 2 ** (-i / 256)));
/** One envelope step (0.375 dB) in the log tables' units (1/256 octave = 0.0235 dB). */
const ENVELOPE_TO_LOG = 16;
const MAX_ENVELOPE = 127;
/** Attenuations past this many 1/256ths of an octave come out as silence. */
const SILENT_LOG = 13 * 256;

/** Envelope steps per sample at each of the 64 effective rates (0-3 never move). */
const RATE_STEPS = Float64Array.from({ length: 64 }, (_, rate) =>
  rate < 4 ? 0 : 2 ** ((rate >> 2) - 14) * ((4 + (rate & 3)) / 4),
);

export const EG_ATTACK = 0;
export const EG_DECAY = 1;
export const EG_SUSTAIN = 2;
export const EG_RELEASE = 3;

/** Operator `slot` of a channel: even slots are modulators, odd ones carriers. */
const SLOTS = 18;

/** One operator's output for a 10-bit phase and an attenuation (log units); ±4096. */
function operatorOutput(phase: number, attenuation: number, halfSine: boolean): number {
  const index = phase & 1023;
  const negative = (index & 512) !== 0;
  if (halfSine && negative) return 0;
  const quarter = index & 256 ? 255 - (index & 255) : index & 255;
  const total = LOG_SIN[quarter] + attenuation;
  if (total >= SILENT_LOG) return 0;
  const value = EXP[total & 255] >> (total >> 8);
  return negative ? -value : value;
}

export class Ym2413 {
  readonly registers = new Uint8Array(0x40);
  /** The register selected by the last write to the address port. */
  address = 0;
  readonly phases = new Uint32Array(SLOTS);
  /** Envelope attenuation, 0 (loudest) to 127, in 0.375 dB steps. */
  readonly envelopes = new Uint8Array(SLOTS).fill(MAX_ENVELOPE);
  readonly envelopeStates = new Uint8Array(SLOTS).fill(EG_RELEASE);
  /** Fractional envelope steps owed. */
  readonly envelopeDebt = new Float64Array(SLOTS);
  /** Whether each operator's key is down. */
  readonly keys = new Uint8Array(SLOTS);
  /** The modulators' last two outputs, for feedback. */
  readonly feedback = new Int32Array(SLOTS * 2);
  /** The rhythm section's 23-bit noise generator. */
  noise = 1;
  sampleCount = 0;

  reset(): void {
    this.registers.fill(0);
    this.address = 0;
    this.phases.fill(0);
    this.envelopes.fill(MAX_ENVELOPE);
    this.envelopeStates.fill(EG_RELEASE);
    this.envelopeDebt.fill(0);
    this.keys.fill(0);
    this.feedback.fill(0);
    this.noise = 1;
    this.sampleCount = 0;
  }

  writeAddress(value: number): void {
    this.address = value & 0x3f;
  }

  writeData(value: number): void {
    const register = this.address;
    this.registers[register] = value;
    if (register === 0x0e) {
      for (let slot = 12; slot < SLOTS; slot++) this.updateKey(slot);
    } else if (register >= 0x20 && register <= 0x28) {
      const channel = register - 0x20;
      this.updateKey(channel * 2);
      this.updateKey(channel * 2 + 1);
    }
  }

  get rhythmMode(): boolean {
    return (this.registers[0x0e] & 0x20) !== 0;
  }

  /** The instrument bytes channel `channel` plays (the rhythm section uses its own). */
  private patch(channel: number): readonly number[] | Uint8Array {
    if (this.rhythmMode && channel >= 6) return PATCHES[BASS_DRUM_PATCH + channel - 6];
    const instrument = this.registers[0x30 + channel] >> 4;
    return instrument === 0 ? this.registers : PATCHES[instrument];
  }

  /** Rhythm key bits for slots 12-17: bass drum (both), hi-hat, snare, tom-tom, top cymbal. */
  private static readonly RHYTHM_KEYS = [0x10, 0x10, 0x01, 0x08, 0x04, 0x02];

  private updateKey(slot: number): void {
    const channel = slot >> 1;
    let down = (this.registers[0x20 + channel] & 0x10) !== 0;
    if (slot >= 12 && this.rhythmMode) down ||= (this.registers[0x0e] & Ym2413.RHYTHM_KEYS[slot - 12]) !== 0;
    if (down === (this.keys[slot] === 1)) return;
    this.keys[slot] = down ? 1 : 0;
    if (down) {
      this.phases[slot] = 0;
      this.envelopeStates[slot] = EG_ATTACK;
      this.envelopeDebt[slot] = 0;
    } else {
      this.envelopeStates[slot] = EG_RELEASE;
    }
  }

  /** Makes one sample: the nine channels (or six and the drums) mixed, about ±1 per channel. */
  tick(): number {
    const sample = this.sampleCount++;
    const vibratoStep = (sample / VIBRATO_STEP_SAMPLES) & 7;
    const tremoloPhase = (sample % TREMOLO_PERIOD) / TREMOLO_PERIOD;
    const tremolo = Math.floor((tremoloPhase < 0.5 ? tremoloPhase * 2 : 2 - tremoloPhase * 2) * (TREMOLO_DEPTH + 0.99));
    const n = this.noise;
    this.noise = (n >> 1) | (((n ^ (n >> 14)) & 1) << 22);
    const rhythm = this.rhythmMode;

    let total = 0;
    for (let channel = 0; channel < (rhythm ? 6 : 9); channel++) total += this.melodic(channel, vibratoStep, tremolo);
    if (rhythm) total += this.drums(vibratoStep, tremolo) * 2;
    return total / 4096;
  }

  // --- Operators ----------------------------------------------------------------------

  private fNumber(channel: number): number {
    return this.registers[0x10 + channel] | ((this.registers[0x20 + channel] & 1) << 8);
  }

  private block(channel: number): number {
    return (this.registers[0x20 + channel] >> 1) & 7;
  }

  /** Advances an operator's phase; `flags` is its patch byte 0 or 1 (vibrato, multiplier). */
  private advancePhase(slot: number, flags: number, channel: number, vibratoStep: number): void {
    const fNumber = this.fNumber(channel);
    const vibrato = flags & 0x40 ? VIBRATO[fNumber >> 6][vibratoStep] : 0;
    const step = (((fNumber * 2 + vibrato) << this.block(channel)) * MULTIPLIERS_X2[flags & 0x0f]) >> 2;
    this.phases[slot] = (this.phases[slot] + step) & PHASE_MASK;
  }

  /**
   * Steps an operator's envelope. `flags` is its patch byte 0 or 1, `rates`
   * byte 4 or 5 (attack, decay) and `levels` byte 6 or 7 (sustain, release).
   */
  private advanceEnvelope(slot: number, flags: number, rates: number, levels: number, channel: number): void {
    const state = this.envelopeStates[slot];
    const sustained = (flags & 0x20) !== 0;
    let rate: number;
    switch (state) {
      case EG_ATTACK:
        rate = rates >> 4;
        break;
      case EG_DECAY:
        rate = rates & 0x0f;
        break;
      case EG_SUSTAIN:
        rate = sustained ? 0 : levels & 0x0f;
        break;
      default:
        if (this.registers[0x20 + channel] & 0x20) rate = 5;
        else rate = sustained ? levels & 0x0f : 7;
    }
    if (rate === 0) return;
    const keyScale = (this.block(channel) << 1) | (this.fNumber(channel) >> 8);
    const effective = Math.min(63, rate * 4 + (flags & 0x10 ? keyScale : keyScale >> 2));
    let level = this.envelopes[slot];
    if (state === EG_ATTACK && effective >= 60) {
      level = 0;
    } else {
      let debt = this.envelopeDebt[slot] + RATE_STEPS[effective];
      while (debt >= 1) {
        debt -= 1;
        if (state === EG_ATTACK) level -= (level >> 2) + 1;
        else level++;
      }
      this.envelopeDebt[slot] = debt;
    }
    if (state === EG_ATTACK) {
      if (level <= 0) {
        level = 0;
        this.envelopeStates[slot] = EG_DECAY;
      }
    } else {
      if (level > MAX_ENVELOPE) level = MAX_ENVELOPE;
      if (state === EG_DECAY && level >= (levels >> 4) * 8) this.envelopeStates[slot] = EG_SUSTAIN;
    }
    this.envelopes[slot] = level;
  }

  /** An operator's total attenuation in log units: envelope, `level` (envelope steps), key scaling and tremolo. */
  private attenuation(slot: number, flags: number, keyScaleBits: number, level: number, channel: number, tremolo: number): number {
    // A finished envelope is silent, not just 48 dB down.
    if (this.envelopes[slot] >= MAX_ENVELOPE) return SILENT_LOG;
    let steps = this.envelopes[slot] + level;
    if (keyScaleBits) {
      const base = KSL_LEVELS[this.fNumber(channel) >> 5] - 8 * (8 - this.block(channel));
      if (base > 0) steps += keyScaleBits === 3 ? base * 2 : keyScaleBits === 2 ? base : base >> 1;
    }
    if (flags & 0x80) steps += tremolo;
    return steps * ENVELOPE_TO_LOG;
  }

  /** Runs one operator's phase and envelope and returns its output for a phase offset. */
  private operator(
    slot: number,
    channel: number,
    patch: readonly number[] | Uint8Array,
    carrier: boolean,
    level: number,
    modulation: number,
    vibratoStep: number,
    tremolo: number,
  ): number {
    const flags = patch[carrier ? 1 : 0];
    this.advancePhase(slot, flags, channel, vibratoStep);
    this.advanceEnvelope(slot, flags, patch[carrier ? 5 : 4], patch[carrier ? 7 : 6], channel);
    const keyScaleBits = carrier ? patch[3] >> 6 : patch[2] >> 6;
    const attenuation = this.attenuation(slot, flags, keyScaleBits, level, channel, tremolo);
    const halfSine = (patch[3] & (carrier ? 0x10 : 0x08)) !== 0;
    return operatorOutput((this.phases[slot] >> SINE_SHIFT) + modulation, attenuation, halfSine);
  }

  /** A modulator with its feedback, then the carrier it modulates. */
  private melodic(channel: number, vibratoStep: number, tremolo: number): number {
    const patch = this.patch(channel);
    const slot = channel * 2;
    const feedbackLevel = patch[3] & 7;
    const history = slot * 2;
    const feedback = feedbackLevel ? (this.feedback[history] + this.feedback[history + 1]) >> (9 - feedbackLevel) : 0;
    const modulator = this.operator(slot, channel, patch, false, (patch[2] & 0x3f) * 2, feedback, vibratoStep, tremolo);
    this.feedback[history] = this.feedback[history + 1];
    this.feedback[history + 1] = modulator;
    const volume = (this.registers[0x30 + channel] & 0x0f) * 8;
    return this.operator(slot + 1, channel, patch, true, volume, modulator, vibratoStep, tremolo);
  }

  // --- Rhythm -------------------------------------------------------------------------

  /**
   * The drums: the bass drum is channel 6 played normally; the tom-tom is
   * channel 8's modulator on its own; the hi-hat, snare and top cymbal mix
   * bits of channel 7's modulator and channel 8's carrier phases with noise.
   */
  private drums(vibratoStep: number, tremolo: number): number {
    const r = this.registers;
    const bassDrum = this.melodic(6, vibratoStep, tremolo);

    const hiHatPatch = PATCHES[17];
    const tomPatch = PATCHES[18];
    // Run the phases and envelopes first: the noisy drums need both phases.
    const hiHatLevel = (r[0x37] >> 4) * 8;
    const snareLevel = (r[0x37] & 0x0f) * 8;
    const tomLevel = (r[0x38] >> 4) * 8;
    const cymbalLevel = (r[0x38] & 0x0f) * 8;
    const tom = this.operator(16, 8, tomPatch, false, tomLevel, 0, vibratoStep, tremolo);
    this.advancePhase(14, hiHatPatch[0], 7, vibratoStep);
    this.advancePhase(15, hiHatPatch[1], 7, vibratoStep);
    this.advancePhase(17, tomPatch[1], 8, vibratoStep);
    this.advanceEnvelope(14, hiHatPatch[0], hiHatPatch[4], hiHatPatch[6], 7);
    this.advanceEnvelope(15, hiHatPatch[1], hiHatPatch[5], hiHatPatch[7], 7);
    this.advanceEnvelope(17, tomPatch[1], tomPatch[5], tomPatch[7], 8);

    const hiHatPhase = this.phases[14] >> SINE_SHIFT;
    const cymbalPhase = this.phases[17] >> SINE_SHIFT;
    const noise = this.noise & 1;
    let ring = (((hiHatPhase >> 2) ^ (hiHatPhase >> 7)) | (hiHatPhase >> 3)) & 1;
    if (((cymbalPhase >> 3) ^ (cymbalPhase >> 5)) & 1) ring = 1;

    let hiHatWave = ring ? 0x200 | (0xd0 >> 2) : 0xd0;
    if (noise) hiHatWave = ring ? 0x200 | 0xd0 : 0xd0 >> 2;
    let snareWave = (hiHatPhase >> 8) & 1 ? 0x200 : 0x100;
    if (noise) snareWave ^= 0x100;
    const cymbalWave = ring ? 0x300 : 0x100;

    const hiHat = operatorOutput(hiHatWave, this.attenuation(14, hiHatPatch[0], 0, hiHatLevel, 7, tremolo), false);
    const snare = operatorOutput(snareWave, this.attenuation(15, hiHatPatch[1], 0, snareLevel, 7, tremolo), false);
    const cymbal = operatorOutput(cymbalWave, this.attenuation(17, tomPatch[1], 0, cymbalLevel, 8, tremolo), false);
    return bassDrum + hiHat + snare + tom + cymbal;
  }
}
