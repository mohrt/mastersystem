/** Controller buttons, in the order the console's I/O port reports them. */
export const Button = {
  Up: 0x01,
  Down: 0x02,
  Left: 0x04,
  Right: 0x08,
  /** Button 1, the left one (most games start with it, as the Master System pad has no Start). */
  One: 0x10,
  Two: 0x20,
  /** The Master System's Pause button, or the Game Gear's Start. */
  Start: 0x40,
} as const;

export interface PadState {
  /** Held buttons (Button bits). */
  buttons: number;
}

const idle = (): PadState => ({ buttons: 0 });

/** One controller, pressed by several input sources (keyboard, gamepad, on-screen pad) at once. */
export class ControllerInput {
  private readonly sources = new Map<string, PadState>();

  set(source: string, state: Partial<PadState>): void {
    this.sources.set(source, { ...idle(), ...state });
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  get state(): PadState {
    const merged = idle();
    for (const state of this.sources.values()) merged.buttons |= state.buttons;
    return merged;
  }
}

/** A D-pad can't press opposite directions together; some games misbehave if they see it. */
function withoutOpposites(buttons: number): number {
  if ((buttons & (Button.Up | Button.Down)) === (Button.Up | Button.Down)) buttons &= ~(Button.Up | Button.Down);
  if ((buttons & (Button.Left | Button.Right)) === (Button.Left | Button.Right)) buttons &= ~(Button.Left | Button.Right);
  return buttons;
}

/** The two controller ports. The pads are plain switches, read straight through the I/O ports. */
export class Controllers {
  readonly inputs: readonly [ControllerInput, ControllerInput] = [new ControllerInput(), new ControllerInput()];

  /** Player `port`'s held buttons (Button bits). */
  buttons(port: 0 | 1): number {
    return withoutOpposites(this.inputs[port].state.buttons);
  }

  /** True while either player holds Start (the console has one Pause button). */
  get start(): boolean {
    return ((this.inputs[0].state.buttons | this.inputs[1].state.buttons) & Button.Start) !== 0;
  }
}
