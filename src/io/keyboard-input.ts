import { Button, type ControllerInput } from './controllers';

const BUTTON_KEYS: Record<string, number> = {
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  ArrowLeft: Button.Left,
  ArrowRight: Button.Right,
  KeyZ: Button.One,
  KeyJ: Button.One,
  Space: Button.One,
  KeyX: Button.Two,
  KeyK: Button.Two,
  Enter: Button.Start,
};
const PAUSE_KEYS = new Set(['Pause', 'KeyP']);

export interface KeyboardCallbacks {
  onPause(): void;
}

/** True when a key press belongs to a form field rather than the game. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * Player 1 on the keyboard: arrows for the D-pad, Z (or J, or Space) for
 * button 1, X (or K) for button 2, and Enter for the Pause button (the Game
 * Gear's Start). P pauses the emulator.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();

  constructor(
    private readonly controller: ControllerInput,
    private readonly callbacks: KeyboardCallbacks,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => {
      this.held.clear();
      this.update();
    });
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (down && (event.ctrlKey || event.metaKey || event.altKey || typingInField(event))) return;
    const code = event.code;
    if (PAUSE_KEYS.has(code)) {
      if (down && !event.repeat) this.callbacks.onPause();
      event.preventDefault();
      return;
    }
    if (!(code in BUTTON_KEYS)) return;
    event.preventDefault();
    if (down) this.held.add(code);
    else this.held.delete(code);
    this.update();
  }

  private update(): void {
    let buttons = 0;
    for (const code of this.held) buttons |= BUTTON_KEYS[code] ?? 0;
    this.controller.set('keyboard', { buttons });
  }
}
