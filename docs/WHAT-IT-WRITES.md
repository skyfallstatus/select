# What Select writes

Scanning, sorting and searching change nothing in the project and nothing on your drives. Select reads the clips and keeps what it finds on this Mac.

## In the project

**Label**, **Make Sequence** and **Sort into Bins** write to the project in front. Make Sequence and Sort into Bins take the clips selected in Select, or every clip on screen.

- **Label** is in the right-click menu on clips. It sets Premiere's colour label on the selected clips (Cmd+A selects every clip on screen): at once up to 50 clips, after a sheet above that.
- **Make Sequence** adds one sequence at the top of the project, with the clips in their order on screen, and opens it in the Timeline. Its settings come from the first clip, as with Premiere's New Sequence From Clip. At most 2,000 clips.
- **Sort into Bins** adds one bin at the top of the project and moves the clips into it, or into numbered bins inside it ([what each view makes](WHAT-IT-LOOKS-AT.md)). **Other** in the sheet adds a bin for the clips the view leaves out.

A new bin or sequence is named `SELECT`, the date and what's on screen, such as `SELECT 2026-11-04 Interviews, longest first`. The sheet lets you change it. A name already taken gets ` (2)`.

Opening a clip that isn't in the project, such as one from a folder scan, offers **Import and Open**. The file is imported by reference into the bin `SELECT IMPORTS`, and stays where it is. Select's **Undo** doesn't take an import back.

## What it never touches

- Media files. Select only reads them.
- Sequences already in the project. Make Sequence doesn't read or change them.
- Subclips. Only master clips are labelled, moved or put in a sequence.
- Other copies of a clip. When a file is in the project twice, a scan of selected clips or bins writes only to the copy it read, and so do its results when they come back on reopen. A scan of the whole project or of a folder labels and moves every copy.

## Undo

Premiere keeps an undo step for each clip, and only its last 50 steps. So Cmd+Z can't take back a big write, and a big write pushes older edits out of History. The sheet says so when it happens: `Too big for Cmd+Z. Undo takes it back.` Make Sequence is two steps, so Cmd+Z can take it back too.

**Undo**, in the line under the toolbar just after a write and in the **···** menu, takes back the newest write in the project in front, then the one before, up to the last 10 for each project. Each record is saved on this Mac before anything changes, so it is still there after the panel or Premiere restarts. A big write goes 100 clips at a time: **Stop** ends it after the batch in progress, and Undo takes back what was written.

Anything changed since the write is left alone and counted:

- A label goes back only on a clip that still has the label Select gave it.
- A clip moves back only from the bin Select put it in. The `SELECT` bin goes once it is empty.
- A sequence is removed only while it is as made: the same name and tracks, as many clips, transitions and markers, the same in, out, frame size and length, and no other sequence uses it. Otherwise it stays: `The sequence has changed. It stays.` or `The sequence is in another sequence. It stays.`

Select can't see an effect, a keyframe or a level changed on a clip, or a trim that leaves a gap, so a sequence changed only that way is removed. Premiere's Edit › Undo brings it back.

Undo also takes back the columns Add Columns wrote in Select 0.2 or 0.3.

## Tied to a project

Results belong to the project they were scanned in. With another project in front, the line under the toolbar says `From` and that project's name, and only **Scan** is offered: the writes, Open in Source Monitor and Reveal in Project wait for a scan there. Results from a folder belong to no project. They write to the project in front, and clips that aren't in it are skipped. The sheet and the status say how many.

## On this Mac

- `~/Library/Caches/com.skyfallstatus.select`: the engine's cache, with each clip's results, its thumbnail and the frames hover scrub shows. It stays under 2 GB, and the clips used longest ago go first.
- `~/Library/Application Support/com.skyfallstatus.select`: the Undo records in `undo`; the last results of the 20 most recent projects in `last` (which clips, the bins they sat in, and the Show, Sort and colours, not the search); the update check's state and the version it replaced in `updates`.

None of it leaves the Mac. Once a day Select asks GitHub whether there is a new version, and downloads it from there when there is. **Check Automatically** in the **···** menu turns that off. **Report a Bug** opens a blank GitHub page in your browser, and nothing is sent unless you submit it.
