import type { KeyValueStore } from './store';

/** Which console a BIOS image is for. */
export type BiosKind = 'sms' | 'gg';

export const BIOS_NAMES: Record<BiosKind, string> = { sms: 'Master System BIOS', gg: 'Game Gear BIOS' };

/** The Game Gear's BIOS is 1K; the Master System's range from 8K (the plain ones) to 256K (with Sonic built in). */
const GG_BIOS_SIZE = 0x400;
const SMS_BIOS_STEP = 0x2000;
const SMS_BIOS_MAX = 0x80000;

/** File names that say they are a BIOS, so a dropped one isn't taken for a game. */
export function looksLikeBios(fileName: string): boolean {
  return /\bbios\b|bios[\s._-]/i.test(fileName);
}

/** Which console a BIOS image is for, by its size; throws if it can't be either. */
export function biosKind(bytes: Uint8Array): BiosKind {
  if (bytes.length === GG_BIOS_SIZE) return 'gg';
  if (bytes.length >= SMS_BIOS_STEP && bytes.length <= SMS_BIOS_MAX && bytes.length % SMS_BIOS_STEP === 0) return 'sms';
  throw new Error(
    `That file (${bytes.length} bytes) isn't a BIOS: the Game Gear's is 1K and the Master System's 8K or more, in steps of 8K.`,
  );
}

/** The player's BIOS images, kept in browser storage so they only have to be given once. */
export class BiosStore {
  constructor(private readonly store: KeyValueStore<Uint8Array>) {}

  async load(): Promise<Partial<Record<BiosKind, Uint8Array>>> {
    const images: Partial<Record<BiosKind, Uint8Array>> = {};
    for (const [key, bytes] of await this.store.entries()) {
      if (key === 'sms' || key === 'gg') images[key] = bytes;
    }
    return images;
  }

  save(kind: BiosKind, bytes: Uint8Array): Promise<void> {
    return this.store.put(kind, bytes.slice());
  }

  async forget(): Promise<void> {
    await this.store.delete('sms');
    await this.store.delete('gg');
  }
}
