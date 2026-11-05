# Select beta: a note for testers

Thank you for trying this. Select is a Premiere Pro panel that sorts and searches your clips: interviews, people, speech, similar shots, softest first, every clip by colour. Everything runs on your Mac.

## Install

Get **Select.pkg** from the [latest release](https://github.com/skyfallstatus/select/releases/latest), or [download it directly](https://github.com/skyfallstatus/select/releases/latest/download/Select.pkg), and follow the [steps in the README](README.md#steps). From then on Select updates itself.

It has been tested on one Mac, an M5 Max on macOS 27, with Premiere 26.5. It says macOS 13 and Premiere 23 or later, but older versions are untested, and so is Intel. If you're on anything else, please say so when you report.

## What to try

1. Open a project you know well. Select a bin or a few clips in the Project panel, or nothing for the whole project. The line under the toolbar says what **Scan** will read. Press it.
2. Try **Show** and **Sort** together. Interviews, longest first. People, softest first. Silent clips. Do the clips at the top deserve to be there? Did a clip you know is bad stay down?
3. Search for something you know you shot, then for a card or a day folder. Sort by colour, and by Camera. Look at Similar shots on a day with lots of takes.
4. In the grid, hover a picture for a second, then move across it. Right-click a clip.
5. On a copy of a project, try **Make Sequence**, **Sort into Bins** and **Label** (right-click), then **Undo** in the **···** menu. Cmd+Z can't take back a big write. [What Select writes](docs/WHAT-IT-WRITES.md) says what each one changes.
6. Close the panel and open it again. The last results should come back.
7. Try it on a big shoot, a messy one, and a mix of cameras.

Please don't throw a clip away because Select put it at the bottom. It tells you where to look first, not what to delete. What each Show and Sort measures, and what it misses: [What Select looks at](docs/WHAT-IT-LOOKS-AT.md).

If a clip's scores are blank, your Mac may have no decoder for it. H.264 10-bit 4:2:2, which Sony's XAVC S-I modes record, is the likely one. Hover over the clip and Select says why. Installing [ffmpeg](https://ffmpeg.org) should fill them in. The one Mac tested so far doesn't have this problem, so we'd like to hear about it.

## What to send back

Use **Report a Bug** in the **···** menu. It opens a blank GitHub page in your browser, and nothing is sent unless you submit it.

The most useful things to hear about:

- Which Mac, which macOS and which Premiere you're on.
- Whether the install steps worked as written, and anything macOS said that they don't describe.
- Whether the line under the toolbar matched what you had selected in Premiere.
- A clip that clearly sits in the wrong place in a sort.
- Blank scores, with the message, the camera and the recording format.
- Labels, faces or words that are clearly wrong, and shots it should have grouped and didn't.
- What ISO, shutter, aperture and shake look like on anything that isn't Sony.
- How long a scan took and how many clips it had, if it felt slow.
- Anything in a write that surprised you: a sequence out of order, a bin you didn't expect, an **Undo** that didn't put things back.
- Whether an update arrived, and whether **Restart** brought the new version up without quitting Premiere.
- Any message you didn't understand, or anything that made you hesitate.

Please don't send file names, paths, client names or footage unless you've been asked. The camera and the recording format are plenty to start with.

Being honest about what confused you helps more than being polite about it.
