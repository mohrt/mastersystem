import { filesFrom } from '../cart/load';
import { BIOS_NAMES, type BiosKind } from '../storage/bios-store';

export interface BiosSetupOptions {
  /** The BIOS images kept now. */
  images(): Partial<Record<BiosKind, Uint8Array>>;
  /** Keeps a BIOS image and switches the console over to it; resolves to which console's it is. */
  onBios(bytes: Uint8Array): Promise<BiosKind>;
  onForget(): Promise<void>;
}

/** Shows the BIOS setup panel in place of the screen until the user goes back to the console. */
export function askForBios(root: HTMLElement, options: BiosSetupOptions): Promise<void> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`BIOS setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[name="bios-file"]');
  const useBios = query<HTMLInputElement>('input[name="use-bios"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-bios"]');
  const message = query<HTMLElement>('.bios-setup-message');
  const kinds = Object.keys(BIOS_NAMES) as BiosKind[];
  const listeners = new AbortController();
  /** The files given while the panel is open; the browser keeps only the images. */
  const names: Partial<Record<BiosKind, string>> = {};
  message.textContent = '';

  const render = () => {
    const images = options.images();
    for (const kind of kinds) {
      const name = names[kind];
      const status = !images[kind] ? 'Not loaded' : name ? `Loaded: ${name}` : 'Loaded, kept in this browser';
      query<HTMLElement>(`.bios-rom[data-kind="${kind}"]`).dataset.state = images[kind] ? 'loaded' : 'missing';
      query<HTMLElement>(`.bios-rom[data-kind="${kind}"] .bios-rom-status`).textContent = status;
    }
    const none = kinds.every((kind) => !images[kind]);
    forgetButton.hidden = none;
    useBios.disabled = none;
  };

  const run = async (action: () => Promise<void>) => {
    message.textContent = '';
    try {
      await action();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
    render();
  };
  const addFile = (file: File) =>
    run(async () => {
      const [chosen] = await filesFrom(file);
      const kind = await options.onBios(new Uint8Array(await chosen.arrayBuffer()));
      names[kind] = chosen.name;
    });

  return new Promise((resolve) => {
    const close = () => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('choosing-bios');
      resolve();
    };

    const signal = listeners.signal;
    query<HTMLButtonElement>('[data-action="choose-bios-file"]').addEventListener('click', () => fileInput.click(), {
      signal,
    });
    fileInput.addEventListener(
      'change',
      () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) void addFile(file);
      },
      { signal },
    );
    forgetButton.addEventListener(
      'click',
      () => {
        if (confirm('Forget the BIOS? Games will start straight away again.')) void run(options.onForget);
      },
      { signal },
    );
    query<HTMLButtonElement>('[data-action="back"]').addEventListener('click', close, { signal });
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') close();
      },
      { signal },
    );

    // Captured and stopped so the cartridge panel's page-wide drop handling doesn't also see the BIOS.
    const dragOptions = { signal, capture: true };
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    let depth = 0;
    window.addEventListener(
      'dragenter',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        depth++;
        root.classList.add('drag-over');
      },
      dragOptions,
    );
    window.addEventListener(
      'dragover',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      },
      dragOptions,
    );
    window.addEventListener(
      'dragleave',
      (event) => {
        if (!hasFiles(event)) return;
        event.stopImmediatePropagation();
        depth = Math.max(0, depth - 1);
        if (depth === 0) root.classList.remove('drag-over');
      },
      dragOptions,
    );
    window.addEventListener(
      'drop',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        depth = 0;
        root.classList.remove('drag-over');
        const file = event.dataTransfer?.files[0];
        if (file) void addFile(file);
      },
      dragOptions,
    );

    document.body.classList.add('choosing-bios');
    root.hidden = false;
    render();
    root.scrollIntoView({ block: 'start' });
  });
}
