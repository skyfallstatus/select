# Select

A Premiere Pro panel that ranks hundreds of clips in seconds, so you know where to look first.

<p align="center">
  <img src="docs/media/demo.png" width="760" alt="An animated illustration of the Select panel. A list of clips fills in as a scan runs, one sort moves the softest clips to the top, and after Sort into Bins the bottom of the panel turns green and says Sorted into 5 bins.">
</p>

Select lives in a panel inside Premiere. Choose your clips, press **Scan**, and every clip gets looked at: one frame for picture, a few short moments for sound, and the file's own details. Then sort. Softest first, darkest, most clipped, silent, near duplicates.

Sorting changes nothing. Your project only changes when you press a button that says so, and your files never change at all.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/panel-dark.png">
    <img src="docs/media/panel.png" width="760" alt="The Select panel after a scan, listing clips in rows with columns for their scores, and the sorts along the top.">
  </picture>
</p>

Select is in beta, so please try the buttons that write to your project on a copy of it first.

## Download

Get **Select.pkg** from the [latest release](https://github.com/skyfallstatus/select/releases/latest).

You'll need a Mac with macOS 13 or later, and Premiere Pro 23 or later. So far it has only been run on Premiere 26.5, on macOS 27 with an M5 Max. Older versions of both are untested, and it's built for Intel too, but it has never run on an Intel Mac. If you're on one of those, please try it and tell us how it goes. Windows isn't supported.

## Installing

Select isn't signed by Apple yet, so macOS asks you to confirm the first time. It takes a minute, and you only do it once per version.

1. Open `Select.pkg`. macOS says it can't be opened. Click **Done**.
2. Go to **System Settings › Privacy & Security** and scroll down to **Security**.
3. Next to the message about Select, click **Open Anyway**, enter your password, then click **Open**.
4. Follow the installer. It asks for your password again, because the folder it uses is shared by everyone on the Mac.
5. Quit Premiere if it's open, then open it again. Select is under **Window › Extensions**.

On macOS 13 or 14 you can skip the first three steps: Control-click the package and choose **Open**.

You don't need the Terminal, and you don't need to turn on Adobe's debug mode.

To remove Select, quit Premiere and delete the `com.skyfallstatus.select` folder from `/Library/Application Support/Adobe/CEP/extensions`. macOS asks for your password. Select also remembers its results in `~/Library/Caches/com.skyfallstatus.select`, including thumbnails, file paths and any camera location, so delete that folder too.

## What each sort means

All of these are places to look first. None of them is a verdict on a clip.

- **Softest first, Sharpest first.** Good at finding soft clips. It doesn't rank in-focus clips against each other, so the top of Sharpest first isn't "your best shot". It reads one frame per clip, so a clip that's soft for a moment can slip past, and a plain wall scores low because it has no fine detail.
- **Darkest.** The average brightness of that one frame. Log footage and night scenes sit low on purpose.
- **Most clipped.** How much of that one frame hits the top of the range. It can do little on log footage, because log rarely clips. A window or a lamp can account for all of it.
- **Most motion, Static.** A stand-in, not real motion tracking. It reads how much the compressed frame sizes change along the clip, without looking at a single frame. It's weak on all-intra footage, where every frame is stored whole, and busy detail or a change of light can read as motion.
- **Silent.** Clips with no audio track, or where the sampled moments are silent. Sound is sampled, not read in full, so sound elsewhere in a clip can be missed.
- **Interviews.** Clips with sound, in the calmest 40% of the scan, longest first. It doesn't detect faces or speech, so a quiet ambience shot passes too.
- **Near duplicates.** Groups clips whose chosen frames look alike, sharpest first in each group. It hasn't been tested on real repeated takes yet, so treat the groups as a suggestion.
- **Shoot order.** By the time written in the file, then by name. It trusts the camera's clock.

<p align="center">
  <img src="docs/media/panel-sorted.png" width="760" alt="The Select panel after Sort into Bins, with clips sorted softest first. The bottom of the panel is green and says Sorted into 5 bins, 301 clips moved, your files were not touched, with an Undo button.">
</p>

## Good to know

- **Your files are never changed.** The bins and columns write to the project, never to your files.
- **Use Undo in the panel, not Cmd+Z.** Premiere only keeps its last 50 steps, so Cmd+Z can't take back a big **Label**, **Add Columns** or **Sort into Bins**. **Undo** in the panel checks that each clip really went back and tells you if one didn't. It remembers your last write until the panel is reloaded.
- **It's quick, and how quick depends on your Mac.** 973 clips, 510 GB, took about 5 seconds on an M5 Max from a USB SSD, which is about 2 seconds per 400. A rescan took under a tenth of a second, because results are remembered. Yours will vary.
- **Camera and lens depend on sidecar files.** Select reads them from the small file some cameras write beside each clip, such as Sony's `M01.XML`. Move a clip without it and those columns go blank.
- **A blank score means Select couldn't get it, never a guess.** Blank clips sort last. When a clip's picture can't be read, Select says why. If your Mac has no decoder for a clip, the file details stay and the picture scores stay blank. See [Formats](#formats).

## Formats

MP4 and MOV work on their own. MXF works when [ffmpeg](https://ffmpeg.org) is installed, and it's much slower, because each clip goes through ffmpeg: a project of 396 MP4 and 129 MXF clips took 22 seconds on the same M5 Max. RED and BRAW aren't supported yet.

Select uses your Mac's own video decoders, and not every Mac has one for every format. H.264 10-bit 4:2:2, which is what Sony's XAVC S-I modes record, is the one to watch: on the Mac tested, macOS only decodes it with hardware. A Mac without that hardware leaves the picture scores blank, unless ffmpeg is installed, which fills them in more slowly. The file details and sound work either way.

To install ffmpeg, get [Homebrew](https://brew.sh) and run `brew install ffmpeg`. Select finds it by itself.

The full picture, and how sure we are of each part, is in [docs/FORMATS.md](docs/FORMATS.md).

## Privacy

The panel sends nothing. There's no account, no tracking and no check for updates, so a new version is something you download yourself.

**Report a Bug** only opens a GitHub page in your browser. Nothing is sent unless you type it in and press submit. Please leave out file names, paths and client names.

Results and thumbnails stay on your Mac, in `~/Library/Caches/com.skyfallstatus.select`. Select writes nothing beside your media.

## Contributing

Bug reports, odd formats and ideas are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary>Building from source</summary>

You need the Command Line Tools with Swift, so you don't need Xcode. It's been built with Swift 6.3. There are no dependencies. ffmpeg and Node are only used by the tests, and they're skipped with a clear message if they're missing.

```sh
scripts/build-engine.sh     # the engine, for Apple silicon and Intel
scripts/build-panel.sh      # the panel with the engine inside, in dist/
scripts/test.sh             # the tests. No footage or Premiere needed
scripts/dev-install.sh      # copies it to your own extensions folder
```

`dev-install.sh` installs an unsigned copy, which needs Adobe's debug mode. It tells you how. Testers don't need any of this.

```
engine/Sources    the native engine: file reader, decoding, scores, cache
engine/tests      the contract test and the fuzz test
panel/            the panel: CSXS manifest, client, host script, tests
scripts/          build, sign, package, release, privacy scan
docs/             the engine's interface, formats, packaging, releasing
product.conf      the name, ids and version, in one place
```

</details>

## License

MIT. See [LICENSE](LICENSE). Credits are in [NOTICE](NOTICE).
