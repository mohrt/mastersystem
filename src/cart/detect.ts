import type { MapperKind } from './cartridge';

/** Which console a game is for. 'gg-sms' is a Master System game on a Game Gear (in its Master System mode). */
export type System = 'sms' | 'gg' | 'gg-sms';
export type Region = 'japan' | 'export';
export type TvSystem = 'ntsc' | 'pal';

export interface RomInfo {
  /** The ROM, without any copier header. */
  rom: Uint8Array;
  system: System;
  /** The region the header gives, or the file name suggests; null if neither says. */
  region: Region | null;
  /** PAL if the file name says it's a European release; null otherwise. */
  tv: TvSystem | null;
  mapper: MapperKind;
  /** Whether the ROM has Sega's "TMR SEGA" header (which export consoles' BIOSes check). */
  hasHeader: boolean;
}

const COPIER_HEADER = 512;
const BANK_SIZE = 0x4000;
const SIGNATURE = 'TMR SEGA';
/** The header can sit at the end of the first 8K, 16K or 32K. */
const HEADER_OFFSETS = [0x7ff0, 0x3ff0, 0x1ff0];

/** Some dumps carry a 512-byte header from a cartridge copier in front of the ROM. */
export function stripCopierHeader(image: Uint8Array): Uint8Array {
  return image.length % BANK_SIZE === COPIER_HEADER ? image.subarray(COPIER_HEADER) : image;
}

/** The offset of the "TMR SEGA" header, or -1. */
export function findHeader(rom: Uint8Array): number {
  for (const offset of HEADER_OFFSETS) {
    if (offset + 16 > rom.length) continue;
    let match = true;
    for (let i = 0; i < SIGNATURE.length && match; i++) match = rom[offset + i] === SIGNATURE.charCodeAt(i);
    if (match) return offset;
  }
  return -1;
}

/** Codemasters' games have their own header at $7FE0, with a checksum at $7FE6 and its complement at $7FE8. */
export function hasCodemastersHeader(rom: Uint8Array): boolean {
  if (rom.length < 0x8000) return false;
  const checksum = rom[0x7fe6] | (rom[0x7fe7] << 8);
  const complement = rom[0x7fe8] | (rom[0x7fe9] << 8);
  return checksum !== 0 && ((checksum + complement) & 0xffff) === 0;
}

/** The mapper a ROM most likely uses. */
export function detectMapper(rom: Uint8Array): MapperKind {
  if (hasCodemastersHeader(rom)) return 'codemasters';
  return rom.length > 0xc000 ? 'sega' : 'none';
}

/** Region hints in the usual naming of ROM files, e.g. "(Japan)" or "(USA, Europe)"; a release outside Japan wins. */
export function regionFromFileName(name: string): Region | null {
  if (/\([^)]*\b(?:USA|Europe|World|Brazil|Korea|Australia)\b[^)]*\)|\((?:U|E|UE|B|K)\)/i.test(name)) return 'export';
  if (/\([^)]*\bJapan\b[^)]*\)|\(J\)/i.test(name)) return 'japan';
  return null;
}

/** European releases are PAL, unless the name also lists an NTSC region (as the NES emulator decides). */
export function tvFromFileName(name: string): TvSystem | null {
  if (/\([^)]*\b(?:USA|Japan|Brazil|NTSC)\b[^)]*\)|\((?:U|J|JU|UJ)\)/i.test(name)) return null;
  if (/\([^)]*\b(?:Europe|PAL|Australia|Germany|France|Spain|Italy|Sweden|Netherlands|UK)\b[^)]*\)|\((?:E|A|G|F|S|I)\)/i.test(name)) {
    return 'pal';
  }
  return null;
}

/** Works out the console, region, TV system and mapper for a ROM image and its file name. */
export function detectRom(image: Uint8Array, fileName: string): RomInfo {
  const rom = stripCopierHeader(image);
  const name = fileName.toLowerCase();
  const header = findHeader(rom);
  // The top four bits of the header's last byte: 3/4 Master System Japan/export, 5/6/7 Game Gear Japan/export/international.
  const code = header >= 0 ? rom[header + 15] >> 4 : 0;
  const ggFile = name.endsWith('.gg');
  let system: System = ggFile ? 'gg' : 'sms';
  if (code >= 5 && code <= 7) system = 'gg';
  else if (ggFile && (code === 3 || code === 4)) system = 'gg-sms';

  let region: Region | null = null;
  if (code === 3 || code === 5) region = 'japan';
  else if (code === 4 || code === 6 || code === 7) region = 'export';
  else region = regionFromFileName(fileName) ?? (name.endsWith('.sg') || name.endsWith('.sc') ? 'japan' : null);

  return { rom, system, region, tv: tvFromFileName(fileName), mapper: detectMapper(rom), hasHeader: header >= 0 };
}
