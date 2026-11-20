# SP·12 Turbo Tool

An unofficial, free browser app for the **E-mu SP-12 Turbo** drum machine: open, play, edit and create sound files (`.SP12`) and sequence files (`.SQ12`), and exchange them with the real machine over MIDI — the app acts as the SP-12's disk drive.

Everything runs locally in your browser. Nothing is uploaded, there are no accounts and no tracking.

> **Not affiliated with E-mu Systems or Creative Technology.** "E-mu" and "SP-12" are used only to describe what this tool works with.

## Use it

Open the app in **Chrome or Edge** on a desktop computer. To install it as an app (own window, works offline), use the install icon in the address bar or **⚙ → Install app**.

| Browser | Editing & playback | MIDI / SP-12 transfer |
| --- | --- | --- |
| Chrome, Edge (Mac, Windows, Linux) | yes | yes |
| Firefox | yes | untested |
| Safari, all iPhone/iPad browsers | yes | no (no Web MIDI) |

## Features

- **Programming:** 32 pads in 4 banks, Tune/Decay, Mix and Multi fader modes, segment grid editor, live recording, note repeat, metronome, song editor with repeats, tempo and mix changes, MIDI-file export.
- **Sample:** trim, loop and truncate with transient snapping; sampling from any audio input (arm/threshold/force, auto-next-pad, lazy chop); chop by count or transients; drum-break slicing into kick/snare/hats/percussion; copy, clear and delete sounds; import WAV/AIFF/MP3; squeeze everything into the 5 s Turbo memory.
- **Mixer:** 90s-console-style desk per SP-12 output — drive, dynamics, filters, 4-band EQ, two groups, bus compressor, reverb and tempo-synced delay, VU meters; WAV and stem export.
- **Disk / MIDI:** the SP-12's MIDI disk functions (3 1, 3 2, 3 3, 3 5), sample dumps, SysEx capture.
- Optional **Rambo** mode for the planned RAM upgrade (all four banks as RAM — not yet verified on hardware).

## Connecting the SP-12

1. Connect the SP-12's MIDI In/Out to a MIDI interface on your computer.
2. In **Disk / MIDI**, click **Connect MIDI** and select the interface as input and output. Allow SysEx when the browser asks.
3. Saving from the SP-12 (**3 1** sequences, **3 2** sounds): just start it on the machine — the file appears in the app.
4. Loading into the SP-12: first select the matching file in the disk menu (**3 3** needs a `.SQ12`, **3 5** needs a `.SP12`), then start the load on the machine.

**Always back up your SP-12 (3 1 / 3 2) before loading anything into it.** Loading overwrites the machine's memory. Files that the app has rebuilt (copy, chop, delete, squeeze, sampling, new files) have only been tested on a single machine so far.

## Run it yourself

The app is plain HTML/JS with no build step and no dependencies. It needs to be served over HTTPS or from `localhost`:

```
cd sp12-pwa
python3 -m http.server 8080
# open http://localhost:8080
```

To host it for free, upload this folder to a GitHub repository and enable **Settings → Pages → Deploy from branch → main / (root)**.

### Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css`, `app.js` | user interface |
| `sp12core.js` | `.SP12` / `.SQ12` parser and writer (no DOM, also usable in Node) |
| `mixer.js` | mixing desk (Web Audio) |
| `drumsep.js` | transient detection and drum-hit classification |
| `sw.js`, `manifest.webmanifest`, `icons/` | offline support and installation |

When you change files, bump the cache name in `sw.js` (`sp12-tool-vNN`) so installed copies pick up the update.

## Privacy

The app stores your open files and settings only in your own browser (local storage). It sends nothing anywhere. The web host serving the page can see your IP address, as with any website.

## Credits

- MIDI disk protocol based on the documentation by SirKrisBo.
- File-format details worked out by comparing real SP-12 Turbo files and transfers.

## License

MIT — see [LICENSE](LICENSE). Provided as is, without warranty. Use at your own risk, especially when writing to vintage hardware.
