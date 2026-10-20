import { describe, expect, it } from 'vitest';
import { Button } from '../src/io/controllers';
import { decodeSession, encodeSession } from '../src/storage/save-states';
import { machineWith, romWith } from './helpers/rom';

// Hand-assembled Z80 snippets.
const DI = [0xf3];
const EI = [0xfb];
const LOOP = [0x18, 0xfe]; // jr $
const RETI = [0xed, 0x4d];
const RETN = [0xed, 0x45];
const ld_a = (n: number) => [0x3e, n];
const out = (port: number) => [0xd3, port];
const in_a = (port: number) => [0xdb, port];
const ld_mem_a = (address: number) => [0x32, address & 0xff, address >> 8];
const inc_mem = (address: number) => [0x21, address & 0xff, address >> 8, 0x34]; // ld hl,nn; inc (hl)
const vdpRegister = (index: number, value: number) => [...ld_a(value), ...out(0xbf), ...ld_a(0x80 | index), ...out(0xbf)];

/** A program that turns on the frame interrupt and counts interrupts at $C001 and NMIs at $C002. */
const counter = romWith({
  0x0000: [...DI, ...vdpRegister(1, 0x60), ...EI, ...LOOP],
  0x0038: [...in_a(0xbf), ...inc_mem(0xc001), ...EI, ...RETI],
  0x0066: [...inc_mem(0xc002), ...RETN],
});

describe('the console', () => {
  it('starts the game as the BIOS leaves things', () => {
    const machine = machineWith(counter);
    expect(machine.cpu.sp).toBe(0xdff0);
    expect(machine.cpu.im).toBe(1);
  });

  it('interrupts once a frame', () => {
    const machine = machineWith(counter);
    for (let frame = 0; frame < 60; frame++) machine.runFrame();
    expect(machine.bus.ram[1]).toBeGreaterThanOrEqual(59);
    expect(machine.bus.ram[1]).toBeLessThanOrEqual(60);
  });

  it('sends an NMI when Pause is pressed', () => {
    const machine = machineWith(counter);
    const pad = machine.controllers.inputs[0];
    machine.runFrame();
    pad.set('test', { buttons: Button.Start });
    machine.runFrame();
    machine.runFrame();
    pad.clear('test');
    machine.runFrame();
    expect(machine.bus.ram[2]).toBe(1);
  });

  it('answers the region check the way Japanese and export consoles do', () => {
    // Output 1s on both TH pins and read them back, then 0s.
    const check = romWith({
      0x0000: [...ld_a(0xf5), ...out(0x3f), ...in_a(0xdd), ...ld_mem_a(0xc010), ...ld_a(0x55), ...out(0x3f), ...in_a(0xdd), ...ld_mem_a(0xc011), ...LOOP],
    });
    const run = (region: 'japan' | 'export') => {
      const machine = machineWith(check);
      machine.setRegion(region);
      machine.runFrame();
      return [machine.bus.ram[0x10] & 0xc0, machine.bus.ram[0x11] & 0xc0];
    };
    expect(run('export')).toEqual([0xc0, 0x00]);
    expect(run('japan')).not.toEqual([0xc0, 0x00]);
  });

  it('reads the pads, 0 for pressed', () => {
    const machine = machineWith(counter);
    machine.controllers.inputs[0].set('test', { buttons: Button.Up | Button.One });
    machine.controllers.inputs[1].set('test', { buttons: Button.Down | Button.Two });
    expect(machine.bus.input(0xdc)).toBe(0xff & ~0x01 & ~0x10 & ~0x80);
    expect(machine.bus.input(0xdd) & 0x0f).toBe(0x0f & ~0x08);
  });

  it('finds the FM unit only when it is fitted', () => {
    const machine = machineWith(counter);
    machine.bus.output(0xf2, 0x01);
    expect(machine.bus.input(0xf2)).not.toBe(0x01);
    machine.setFm(true);
    machine.bus.output(0xf2, 0x01);
    expect(machine.bus.input(0xf2)).toBe(0x01);
    expect(machine.bus.fmAudible).toBe(true);
    expect(machine.bus.psgAudible).toBe(false);
  });

  it('has a Start button and stereo on the Game Gear', () => {
    const machine = machineWith(counter);
    machine.setSystem('gg');
    expect(machine.bus.input(0x00) & 0x80).toBe(0x80);
    machine.controllers.inputs[0].set('test', { buttons: Button.Start });
    expect(machine.bus.input(0x00) & 0x80).toBe(0);
    machine.bus.output(0x06, 0x0f);
    expect(machine.psg.stereo).toBe(0x0f);
  });

  it('switches banks through the mapper registers in RAM', () => {
    const rom = romWith({ 0x0000: [...ld_a(5), ...ld_mem_a(0xffff), ...LOOP] }, 0x20000);
    const machine = machineWith(rom);
    machine.runFrame();
    expect(machine.bus.read(0xbfff)).toBe(5);
    expect(machine.bus.read(0xffff)).toBe(5);
  });
});

describe('save states', () => {
  it('restores the machine where it was', async () => {
    const machine = machineWith(counter);
    for (let frame = 0; frame < 10; frame++) machine.runFrame();
    const bytes = await encodeSession({ machine: machine.saveState(), rom: counter, romName: 'counter.sms', title: 'Counter', mapper: 'none' });
    for (let frame = 0; frame < 10; frame++) machine.runFrame();
    const session = await decodeSession(bytes);
    const restored = machineWith(session.rom);
    restored.loadState(session.machine);
    expect(restored.bus.ram[1]).toBe(10);
    expect(restored.cpu.pc).toBe(machine.cpu.pc);
  });
});
