# Sega Master System in the browser

**Play it at [mohrt.github.io/mastersystem](https://mohrt.github.io/mastersystem/)**

A Sega Master System and Game Gear emulator written from scratch in TypeScript: a Z80 with every documented and undocumented instruction (it passes ZEXDOC and ZEXALL), Sega's video chip with mode 4 (scrolling, line interrupts, the 224- and 240-line modes) and the TMS9918A modes it kept, the PSG in it with the Game Gear's stereo, the YM2413 FM chip of Japanese consoles, and the Sega, Codemasters and Korean mappers. Drop a `.sms` or `.gg` file (or a `.zip` containing one) onto the page to play it. No BIOS is needed: games start as the BIOS would leave them, though you can add your own (see below).

sverx's SMS Test Suite identifies it as a Master System II, sees the region and TV system it is set to, and finds the FM chip on a Japanese console.

## Controls

- **Keyboard** (player 1): arrow keys for the D-pad, Z (or Space) for button 1, X for button 2, and Enter for the console's Pause button (Start on a Game Gear). P or Pause pauses the emulator.
- **Gamepads** work as soon as you press one of their buttons: the first is player 1, the second player 2. The D-pad or left stick is the D-pad; the bottom and left face buttons are 1, the right and top ones 2, and Start is Pause. Pads without a standard mapping work through their main axes or a hat switch.
- **On-screen controller**: a D-pad you can slide around on, Pause/Start, and buttons 1 and 2, for player 1 or player 2. It is shown on touch screens, and works with a mouse too.

## Console

The toolbar has pause, the console's Reset button (games that use it restart; a Game Gear, which has none, restarts), power cycle and full screen, and the console's setup. Each setting can be left on Auto:

- **Console**: Master System or Game Gear. Auto goes by the file's extension and the cartridge's header, so a Master System game in a `.gg` file runs in the Game Gear's Master System mode.
- **Region**: Japan or export. Auto takes it from the header, or the file name, such as "(Japan)". Games check it, and some play differently.
- **TV**: NTSC (60 Hz) or PAL (50 Hz). Auto picks PAL for European releases by their file name; the Game Gear is always 60 Hz.
- **FM sound**: the FM Sound Unit, built into Japanese Master Systems. Auto fits it for Japanese games; games that find it play FM music.

Changing the setup switches the console off and on, as games look at it when they start. **Hide left column** crops the leftmost 8 pixels, where some scrolling games leave junk. Save states keep the whole console, cartridge included, in the browser. They can be exported and imported as `.smsstate` files.

Games that save to their cartridge (battery-backed RAM, as in Phantasy Star) save in the browser by themselves. **Download .sav** appears once a game has used its cartridge RAM, and dropping a `.sav` file onto the page while its game is in uses it.

## The BIOS

The consoles' BIOS ROMs are still under copyright, so none is included, and none is needed. If you have your own, **Add BIOS...** (or drop a file with "bios" in its name) keeps it in the browser: a Master System BIOS (8K or more) or the Game Gear's (1K). With **Start through the BIOS** ticked, the console starts in it as the real one does: it shows its logo, checks the game, and starts it. Export Master System BIOSes refuse games without a valid Sega header, as on the real console. A Master System with a BIOS also switches on with no cartridge in. **Forget** removes the BIOS images.

## Cartridges

The mapper is worked out from the ROM: Codemasters' games by their header, and anything over 48K uses Sega's mapper. The Korean mapper can be chosen by hand. Copier headers are skipped. SG-1000 games (`.sg`) run too, as they did on the Mark III.

No commercial games are included in this repository. Use images of cartridges you own. `npm run fetch:games` downloads the freely licensed homebrews listed in `scripts/games-catalog.json` (each with its credit, licence, source and checksum) into `public/games/`, where they appear in a "Free games" picker. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.sms" }] }`.

## Development

```sh
npm install
npm run fetch:games       # optional: free games into public/games/
npm run dev               # http://localhost:5173
npm test                  # tests needing downloaded files skip when they're missing
npm run fetch:test-roms   # optional: sverx's SMS Test Suite, for the console detection tests
npm run fetch:zex         # optional: ZEXDOC and ZEXALL; run them with ZEX=1 npm test (a few minutes)
```

`npm test` also runs the free games and any `.sms`, `.gg` or `.sg` files you put in `roms/`; `SHOTS=/tmp/shots npm test` saves screenshots of each.

## Deploying

`.github/workflows/pages.yml` downloads the free games and the test ROMs, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
