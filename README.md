# Select

A Premiere Pro panel that sorts hundreds of clips in seconds, so you know where to look first.

<p align="center">
  <img src="docs/media/demo.png" width="760" alt="An animated illustration of the Select panel with invented clips. The grid of clips sorts itself by colour into rainbow order, a search narrows it down, and a write to the project ends with the bottom of the panel turning green.">
</p>

Press **Scan** and Select looks at every clip: the picture, the sound and the camera's details. Then pick what to **Show** (interviews, people, speech, similar shots…) and how to **Sort** (sharpness, brightness, colour, length…). Search finds what's in your clips. Everything stays on your Mac.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/panel-grid-dark.png">
    <img src="docs/media/panel-grid.png" width="760" alt="The Select panel in grid view with 24 invented clips, simple drawn scenes rather than real footage, sorted by colour: reds and oranges first, then yellows, greens, blues and purples, with grey clips last. Each clip shows a small strip of its main colours.">
  </picture>
</p>

Select is in beta, so try it on a copy of your project first.

## Install

### Requirements

- **macOS** 13 Ventura or later
- **Mac** with Apple silicon, or Intel (untested so far)
- **Premiere Pro** 2023 (version 23) or later
- **Footage:** MP4 and MOV. MXF needs [ffmpeg](https://ffmpeg.org).
- **Windows** isn't supported.

So far it has been tested on Premiere 26.5 with an Apple silicon Mac.

### Steps

Get **Select.pkg** from the [latest release](https://github.com/skyfallstatus/select/releases/latest).

1. Open `Select.pkg`. macOS says it can't be opened. Click **Done**.
2. Go to **System Settings › Privacy & Security**, scroll down, and click **Open Anyway** next to Select.
3. Follow the installer. Select installs for you only, so it doesn't ask for an administrator's password.
4. Restart Premiere, then choose **Window › Extensions › Select**.

On macOS 13 or 14, you can instead Control-click the package and choose **Open**.

### Updates

Select updates itself. When a new version is ready, a line at the bottom of the panel says so. **Restart** switches to it, or Premiere uses it the next time it opens. **Check for Updates** in the **···** menu checks now.

Coming from Select 0.1? Install the package once, as above. 0.1 can't update itself.

## Use

1. Choose **Selection**, **Project** or **Folder** at the top, and press **Scan**.
2. Pick from **Show** and **Sort**, tap a colour dot, or search.
3. Happy with the view? **Label**, **Add Columns** or **Sort into Bins** puts it in your project. **Undo Write** in the **···** menu takes it back, up to your last 10 writes.

Your media files are never changed. What each option measures, and how accurate it is, is in [What Select looks at](docs/WHAT-IT-LOOKS-AT.md).

## Privacy

Your clips and what Select finds in them never leave your Mac: no account, no tracking. Results are kept in `~/Library/Caches/com.skyfallstatus.select`, and Undo records in `~/Library/Application Support/com.skyfallstatus.select`.

Once a day Select asks GitHub whether there's a new version. That request is the only thing it sends. You can turn it off in the ··· menu. When there is a new version, Select downloads it from the same GitHub release.

## Feedback

Bugs, odd formats and ideas are welcome. Use **Report a Bug** in the panel's **···** menu, or see [BETA.md](BETA.md) for what's most useful to hear.

To remove Select, quit Premiere and delete `com.skyfallstatus.select` from `~/Library/Application Support/Adobe/CEP/extensions`, and its settings folder, `~/Library/Application Support/com.skyfallstatus.select`. Select 0.1 installed for all users, in `/Library/Application Support/Adobe/CEP/extensions`, so if you had it, delete it there too.

Want to build it yourself or help out? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
