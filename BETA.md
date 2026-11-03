# Select beta: a note for testers

Thank you for trying this. Select is a Premiere Pro panel that looks at every clip you give it and lets you sort them in seconds: softest first, darkest, most clipped, silent, near duplicates. You're among the first people to use it, which is the point, and also why this page exists.

## Download

Get **Select.pkg** from the [latest release](https://github.com/skyfallstatus/select/releases/latest), or [download it directly](https://github.com/skyfallstatus/select/releases/latest/download/Select.pkg).

## What to do

1. Install it.
   1. Open `Select.pkg`. macOS says it can't be opened. Click **Done**.
   2. Open **System Settings › Privacy & Security** and scroll down to **Security**.
   3. Beside the message about Select, click **Open Anyway**, enter your login password, then click **Open**.
   4. Follow the installer, which asks for your password again.
   5. On macOS 13 or 14 you can skip the first three: Control-click the package and choose **Open**.
2. Quit Premiere if it's open, then open it again. Select is under **Window › Extensions**.
3. Open a project you know well. Choose **Selection**, **Project** or **Folder**, and press **Scan**.
4. Try the sorts. Soft clips, dark clips, clipped clips, silent clips. Do the clips at the top deserve to be there? Did a clip you know is bad stay down in the list?
5. Try it on a big shoot, a messy one, and a mix of cameras.

## Which Mac, which Premiere

Select has been tested on one Mac: an M5 Max on macOS 27, with Premiere 26.5. That's all so far.

It says Premiere 23 or later and macOS 13 or later, but older versions are untested, including the install steps above. It's built for Intel too, and that part has never run. If you're on anything else, please say so when you report: your Mac and your Premiere version are the most useful things you can send.

## Please be careful with this

**Label, Add Columns and Sort into Bins are the newest part of Select. Please try them on a copy of a project first.**

They write to the project, never to your files. Cmd+Z can't reverse a batch, so use **Undo** in the panel. It puts back what the write replaced, for the last write only.

Sorting and scanning are safe. They change nothing in the project, and nothing on your drives. Select reads your clips and keeps its results in its own folder on your Mac.

Please don't throw a clip away because Select put it at the bottom. It looks at one frame per clip, and it's there to tell you where to look first, not what to delete.

## What it can't do yet

- Sharpness finds soft clips. It doesn't rank in-focus ones, and it reads one frame per clip.
- Motion is a stand-in, and it's weak on all-intra footage.
- Most clipped can do little on log footage, because log rarely clips.
- Near duplicates hasn't been tested on real repeated takes. If you shoot lots of takes, your footage is especially useful here.
- Camera and lens depend on sidecar files.
- MP4 and MOV work on their own, MXF needs [ffmpeg](https://ffmpeg.org), and RED and BRAW don't work yet.

If a clip's scores are blank, your Mac may have no decoder for it. H.264 10-bit 4:2:2 is the likely one, and that's what Sony's XAVC S-I modes record. Hover over the clip and Select says why. Installing ffmpeg should fill them in. We'd really like to hear about this one, because the only Mac tested so far doesn't have the problem.

## What to send back

Use **Report a Bug** in the panel's `···` menu. It opens a blank GitHub page in your browser, and nothing is sent unless you press submit.

The most useful things to hear about:

- Which Mac, which macOS and which Premiere you're on.
- Whether the install steps worked as written, and anything macOS said that isn't described here.
- A clip that clearly sits in the wrong place in a sort.
- Blank scores, with the message, and the camera and recording format.
- How long a scan took and how many clips it had, if it felt slow.
- Anything in a write that surprised you, or an Undo that didn't put things back.
- Any message you didn't understand, or anything that made you hesitate.

Please don't send file names, paths, client names or footage unless you've been asked. Which camera and which recording format are plenty to start with.

## Thank you

Every project you run helps. Being honest about what confused you helps more than being polite about it.
