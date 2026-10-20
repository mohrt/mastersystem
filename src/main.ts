import { AudioOutput } from './audio/audio-output';
import { Cartridge, MAPPER_NAMES, type MapperKind } from './cart/cartridge';
import { detectRom, type Region, type RomInfo, type System, type TvSystem } from './cart/detect';
import { BATTERY_EXTENSION, STATE_EXTENSION, filesFrom, readMedia, titleFromFileName } from './cart/load';
import { Emulator } from './emulator';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { GamepadManager, padName, readGamepad } from './io/gamepad-input';
import { KeyboardInput } from './io/keyboard-input';
import { Screen } from './render/screen';
import { BatterySaves, batteryKey } from './storage/battery-saves';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { CartPanel } from './ui/cart-panel';
import { downloadFile } from './ui/download';
import { Settings } from './ui/settings';
import { attachToolbar, type ConsoleChoices } from './ui/toolbar';
import { OnScreenPad } from './ui/touch-pad';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['system', 'region', 'tv', 'fm', 'show-pad', 'pad-player', 'crop-left', 'sound', 'volume'];

/** Longest gap the loop catches up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_FRAME_MS = 100;
const PLAYERS = 2;
/** How often changed battery saves are written to browser storage. */
const BATTERY_SAVE_INTERVAL_MS = 2000;

const SYSTEM_NAMES: Record<System, string> = {
  sms: 'Master System',
  gg: 'Game Gear',
  'gg-sms': 'Game Gear (Master System mode)',
};

interface CurrentCartridge {
  info: RomInfo;
  fileName: string;
  title: string;
  /** The mapper in use: the detected one, unless the player chose another. */
  mapper: MapperKind;
  cartridge: Cartridge;
  batteryKey: string;
}

/** How the console is set up for a cartridge: the toolbar's choices, with 'auto' filled in from the cartridge. */
interface ConsoleSetup {
  system: System;
  region: Region;
  tv: TvSystem;
  fm: boolean;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mastersystem';

const sizeLabel = (bytes: number) => (bytes >= 1024 ? `${bytes / 1024}K` : `${bytes} bytes`);

function setupFor(choices: ConsoleChoices, info: RomInfo | null): ConsoleSetup {
  let system: System = info?.system ?? 'sms';
  if (choices.system === 'sms') system = 'sms';
  else if (choices.system === 'gg') system = info?.system === 'gg-sms' ? 'gg-sms' : 'gg';
  const region = choices.region !== 'auto' ? choices.region : (info?.region ?? 'export');
  // The Game Gear's LCD runs at 60 Hz everywhere.
  const tv = choices.tv !== 'auto' ? choices.tv : system === 'sms' ? (info?.tv ?? 'ntsc') : 'ntsc';
  const fm = choices.fm === 'auto' ? system === 'sms' && region === 'japan' : choices.fm === 'on';
  return { system, region, tv, fm };
}

/** One line about the cartridge, e.g. "256K · Sega mapper · Game Gear · Japanese". */
function describe(cart: CurrentCartridge): string {
  const { info } = cart;
  const parts = [sizeLabel(info.rom.length), MAPPER_NAMES[cart.mapper], SYSTEM_NAMES[info.system]];
  if (info.region) parts.push(info.region === 'japan' ? 'Japanese' : 'export');
  if (info.tv === 'pal') parts.push('PAL');
  if (!info.hasHeader) parts.push('no Sega header');
  return parts.join(' · ');
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');

  try {
    const settings = new Settings();
    // The on-screen controller starts out shown on touch screens, until the player chooses.
    const showPad = requireElement<HTMLInputElement>('input[name="show-pad"]');
    showPad.checked = matchMedia('(pointer: coarse)').matches;
    settings.bind(document, REMEMBERED_SETTINGS);

    const screen = new Screen(canvas);
    screen.onAspect = (aspect) => document.documentElement.style.setProperty('--screen-aspect', aspect.toFixed(4));
    screen.onAspect(screen.aspect);
    const emulator = new Emulator(screen);
    const machine = emulator.machine;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) emulator.setAudioRate(audio.sampleRate);

    const stores = await openBrowserStores().catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      return memoryStores();
    });
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const batterySaves = new BatterySaves(stores.battery as KeyValueStore<Uint8Array>);

    let current: CurrentCartridge | null = null;
    let bundledGames: BundledGame[] = [];
    let paused = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const parts = [current ? current.title : 'No cartridge', SYSTEM_NAMES[machine.system]];
      parts.push(machine.tv.toUpperCase(), machine.region === 'japan' ? 'Japan' : 'Export');
      if (machine.fmPresent) parts.push('FM');
      status.textContent = `${parts.join(' · ')} · Arrows, Z, X and Enter play`;
      screenFrame.classList.toggle('empty', current === null);
    };

    /** Sets the console up for the current cartridge and the toolbar's choices. */
    const applySetup = () => {
      const setup = setupFor(toolbar.choices, current?.info ?? null);
      machine.setSystem(setup.system);
      machine.setRegion(setup.region);
      emulator.setTv(setup.tv);
      machine.setFm(setup.fm);
      screen.setGameGear(setup.system === 'gg');
    };

    // --- Battery saves ---------------------------------------------------------------
    const saveBattery = async () => {
      const cart = current?.cartridge;
      const data = cart?.saveData;
      if (!current || !cart || !data || !cart.batteryDirty) return;
      cart.batteryDirty = false;
      await batterySaves.save(current.batteryKey, data);
    };
    const saveBatterySoon = () => {
      cartPanel.setHasSave(current?.cartridge.saveData != null);
      void saveBattery().catch((error: unknown) => console.warn('Could not keep the game save:', error));
    };
    setInterval(saveBatterySoon, BATTERY_SAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveBatterySoon();
    });
    window.addEventListener('pagehide', saveBatterySoon);

    // --- Cartridges ------------------------------------------------------------------
    /** A cartridge with its saved game (if any) loaded. */
    const buildCartridge = async (info: RomInfo, mapper: MapperKind, key: string): Promise<Cartridge> => {
      const cartridge = new Cartridge(info.rom, mapper);
      const saved = await batterySaves.load(key).catch(() => undefined);
      if (saved) cartridge.loadSaveData(saved);
      return cartridge;
    };

    const loadCartridge = async (image: Uint8Array, fileName: string, knownTitle?: string, mapper?: MapperKind) => {
      const info = detectRom(image, fileName);
      const key = batteryKey(info.rom);
      const chosen = mapper ?? info.mapper;
      const cart: CurrentCartridge = {
        info,
        fileName,
        title: knownTitle ?? titleFromFileName(fileName.split(' from ')[0]),
        mapper: chosen,
        cartridge: await buildCartridge(info, chosen, key),
        batteryKey: key,
      };
      cartPanel.showCartridge(cart.title, fileName, describe(cart), cart.cartridge.saveData !== null);
      cartPanel.setMapper(info.mapper, chosen === info.mapper ? 'auto' : chosen);
      return cart;
    };

    const insertImage = async (image: Uint8Array, fileName: string, knownTitle?: string) => {
      const next = await loadCartridge(image, fileName, knownTitle);
      await saveBattery();
      current = next;
      applySetup();
      machine.insertCartridge(next.cartridge);
      emulator.resetTiming();
      audio?.flush();
      updateCanSave();
      updateStatus();
    };

    const eject = () => {
      saveBatterySoon();
      machine.insertCartridge(null);
      current = null;
      cartPanel.showEmpty();
      updateCanSave();
      updateStatus();
    };

    const useBatteryFile = async (bytes: Uint8Array) => {
      const cart = current?.cartridge;
      if (!current || !cart) throw new Error('Insert the game first, then drop its .sav file.');
      cart.loadSaveData(bytes);
      cart.batteryDirty = true;
      await saveBattery();
      machine.powerOn();
      audio?.flush();
      cartPanel.setHasSave(true);
      cartPanel.showMessage('Game save loaded; the console was switched off and on to use it.', true);
    };

    // --- Save states -----------------------------------------------------------------
    const currentSession = (): Session => {
      if (!current) throw new Error('Insert a cartridge first.');
      return {
        machine: machine.saveState(),
        rom: current.info.rom,
        romName: current.fileName,
        title: current.title,
        mapper: current.mapper,
      };
    };
    const restoreSession = async (session: Session) => {
      const next = await loadCartridge(session.rom, session.romName, session.title, session.mapper);
      await saveBattery();
      current = next;
      machine.insertCartridge(next.cartridge);
      machine.loadState(session.machine);
      screen.setGameGear(machine.system === 'gg');
      emulator.restored();
      updateCanSave();
      audio?.flush();
      updateStatus();
    };
    const updateCanSave = () => toolbar.setCanSave(current !== null);

    // --- Panels ----------------------------------------------------------------------
    const cartPanel = new CartPanel(requireElement('#cart-panel'), {
      onFile: async (file) => {
        const files = await filesFrom(file);
        const fromZip = files[0] !== file;
        const chosen = files[0];
        if (fromZip) cartPanel.setZipFiles(files, chosen.name);
        else if (cartPanel.zipContents.includes(file)) cartPanel.setZipFiles(cartPanel.zipContents, file.name);
        else cartPanel.setZipFiles([], null);
        const media = await readMedia(chosen);
        if (media.kind === 'state') {
          await restoreSession(await decodeSession(media.bytes));
          toolbar.showMessage('Save state loaded');
          return;
        }
        if (media.kind === 'battery') {
          await useBatteryFile(media.bytes);
          return;
        }
        const game = bundledGames.find((entry) => entry.file.split('/').pop() === chosen.name);
        await insertImage(media.image, fromZip ? `${chosen.name} from ${file.name}` : chosen.name, game?.title);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onEject: eject,
      onExportSave: () => {
        const data = current?.cartridge.saveData;
        if (current && data) downloadFile(data, `${slug(current.title)}${BATTERY_EXTENSION}`);
      },
      onMapper: (choice) => {
        if (!current) return;
        const mapper = choice === 'auto' ? current.info.mapper : choice;
        void (async () => {
          await saveBattery();
          if (!current) return;
          current.mapper = mapper;
          current.cartridge = await buildCartridge(current.info, mapper, current.batteryKey);
          machine.insertCartridge(current.cartridge);
          cartPanel.showCartridge(current.title, current.fileName, describe(current), current.cartridge.saveData !== null);
          audio?.flush();
        })();
      },
      focusScreen,
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => machine.pressReset(),
      onPowerCycle: () => {
        machine.powerOn();
        audio?.flush();
      },
      onFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        void screenFrame.requestFullscreen().then(focusScreen);
      },
      onConsole: () => {
        // Games look at the console they are on when they start, so a change means switching off and on.
        applySetup();
        machine.powerOn();
        emulator.resetTiming();
        audio?.flush();
        updateStatus();
      },
      onSaveState: async () => {
        const session = currentSession();
        await saveStates.add(session.title, session);
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        const session = currentSession();
        downloadFile(await encodeSession(session), `${slug(session.title)}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      cartPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    // --- Display -----------------------------------------------------------------------
    const cropLeft = requireElement<HTMLInputElement>('input[name="crop-left"]');
    const applyCrop = () => screen.setCropLeftColumn(cropLeft.checked);
    cropLeft.addEventListener('change', () => {
      applyCrop();
      focusScreen();
    });
    applyCrop();

    // --- Inputs ----------------------------------------------------------------------
    const [player1, player2] = machine.controllers.inputs;
    new KeyboardInput(player1, { onPause: () => toolbar.setPaused(!toolbar.paused) }).attach(window);
    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');

    const padRoot = requireElement<HTMLElement>('#pad');
    const pad = new OnScreenPad(padRoot, player1, focusScreen);
    const padPlayer = requireElement<HTMLSelectElement>('select[name="pad-player"]');
    const applyPad = () => {
      padRoot.hidden = !showPad.checked;
      pad.setController(padPlayer.value === '1' ? player2 : player1);
    };
    showPad.addEventListener('change', applyPad);
    padPlayer.addEventListener('change', applyPad);
    applyPad();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop -----------------------------------------------------------------
    let lastPadNames = '';
    const pollGamepads = () => {
      const pads = gamepads.connected();
      for (let player = 0; player < PLAYERS; player++) {
        const gamepad = pads[player];
        const input = machine.controllers.inputs[player];
        if (gamepad) input.set('gamepad', readGamepad(gamepad));
        else input.clear('gamepad');
      }
      const names = pads
        .slice(0, PLAYERS)
        .map((gamepad, player) => `Player ${player + 1}: ${padName(gamepad)}`)
        .join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    let last = performance.now();
    const frame = (now: number) => {
      const elapsed = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      pollGamepads();
      if (!paused) {
        emulator.run(elapsed);
        audio?.play(emulator.takeAudioSamples());
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    applySetup();
    cartPanel.showEmpty();
    updateCanSave();
    updateStatus();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
