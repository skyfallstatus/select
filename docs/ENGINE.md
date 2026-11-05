# The engine

`select-engine` is a native macOS command line program, written in Swift, that ships inside the panel at `bin/select-engine`. The panel starts it, reads its output and never waits on it, so Premiere is never blocked by a scan.

It's a universal binary, for Apple silicon and Intel, and runs on macOS 13 or later. The name, id and version come from `product.conf`.

## Command line

```
select-engine scan --paths-file <file|-> [--tier 0|1|2] [--cache <dir>] [--workers <n>] [--no-thumbs] [--cache-limit-mb <n>] [--cached-only]
select-engine strip --path <clip> [--frames 2-32] [--width 64-1024] [--cache <dir>]
select-engine reveal <path> [<path> ...]
select-engine version
select-engine --version
```

- `--tier` defaults to 2, which emits all three. `--tier 0` and `--tier 1` stop early.
- `--cached-only` answers from the cache alone and never reads a clip. See [Answering from the cache](#answering-from-the-cache).
- `strip` makes the hover-scrub frames for one clip. See [Strips](#strips).
- `reveal` shows files in the Finder, every one selected. See [Revealing in the Finder](#revealing-in-the-finder).
- `--cache` defaults to `~/Library/Caches/com.skyfallstatus.select`, and `--cache-limit-mb` to 2048.
- `--paths-file` holds one absolute path per line. `-` reads stdin.
- Output on stdout is JSON Lines, flushed per line, in completion order, so the panel can update live.
- Logs go to stderr only. It exits 0 even if single clips fail, and 2 on bad arguments.
- SIGTERM or a closed stdout stops the run promptly, along with any ffmpeg it started.
- The engine opens media read-only and never writes beside it.

## Output lines

```json
{"type":"start","total":400,"schema":4,"engineVersion":"0.1.0"}
{"type":"clip","tier":0,"path":"/abs/clip.mp4","cached":false,"ms":3.1, ...fields...}
{"type":"clip","tier":1,"path":"/abs/clip.mp4","cached":false,"ms":41.0, ...fields...}
{"type":"clip","tier":2,"path":"/abs/clip.mp4","cached":false,"ms":90.0, ...fields...}
{"type":"error","path":"/abs/clip.mp4","message":"..."}
{"type":"groups","groups":[{"id":1,"paths":["/abs/a.mp4","/abs/b.mp4"]}]}
{"type":"done","clips":400,"failed":0,"cached":0,"wallMs":7300,"degraded":0}
```

With `--cached-only` there is one more kind of line, `start` says `"cachedOnly":true` and `done` adds `uncached`:

```json
{"type":"uncached","path":"/abs/clip.mp4","tier":0,"changed":false}
```

`schema` is the cache schema, 4 since sidecars became part of the key. A line carries only its own tier's fields, and the panel merges lines by `path`. All Tier 1 lines come before any Tier 2 line. `groups` comes once, after the last Tier 2 line and before `done`, and only clips in a group of two or more appear in it. A field the engine can't get is `null`, never a guess. New fields may be added, so ignore ones you don't know.

In the `done` line, `clips` counts everything with Tier 0 data, `failed` counts `error` lines and `degraded` counts clips with no picture scores.

### Tier 0 fields: no pixels decoded

| Field | Type | Meaning |
|---|---|---|
| `name` | string | file name |
| `sizeBytes` | int | file size |
| `durationS` | float | duration |
| `fps` | float | frame rate |
| `width`, `height` | int | display size after rotation |
| `rotation` | int | 0, 90, 180, 270 |
| `codec` | string | `h264`, `hevc`, `prores`, ... |
| `bitDepth` | int or null | 8, 10, 12 |
| `chroma` | string or null | `420`, `422`, `444` |
| `allIntra` | bool or null | every sample is a sync sample |
| `mbps` | float | average bitrate |
| `hasAudio` | bool | |
| `audioChannels` | int or null | all tracks together |
| `createdAt` | string or null | always with its zone: `2023-11-02T16:45:07Z` or `2025-12-12T19:03:06+01:00`, whole seconds. See below |
| `dateSource` | string or null | where `createdAt` came from: `camera` (the camera's own clock, with its zone), `container` (the file's own date, UTC, which may be when it was written or copied) or `fileName`. null when there's no date |
| `containerDate` | string or null | only when `dateSource` is `fileName` and the file had a date of its own: that date, for a tooltip |
| `dateOnly` | bool | the date came from a file name that gives the day but not the time, so `createdAt` is put at noon |
| `timecode` | string or null | start timecode |
| `camera` | string or null | maker and model, said once: `Canon EOS R6`, `Sony ILME-FX6V`. An MXF names the program that wrote it, so only a maker and model that name a camera are kept: never `Sony Mem`, never `Adobe Media Encoder`. Programs are matched as whole words, so a Blackmagic camera keeps its name and DaVinci Resolve names none |
| `lens` | string or null | from embedded metadata, Canon's maker block, or Sony's XML beside the clip (`*M01.XML`) or inside it |
| `gamma` | string or null | e.g. `s-log3-cine`, `hlg`, `pq` |
| `isLog` | bool or null | gamma says log |
| `colorNote` | string or null | only when the file names a curve or gamut the engine doesn't convert, such as S-Log2, S-Log3 with S-Gamut3, HLG or PQ: why the thumbnail and colours are as recorded. See Log footage below |
| `gpsLat`, `gpsLon` | float or null | |
| `keyframeBytesMean` | float or null | mean compressed sync-sample size per megapixel, from the sample table: a detail stand-in |
| `motionProxy` | float or null | spread of compressed sample sizes along the clip, 0 to 1: a motion stand-in |

### Tier 1 fields: one decoded frame and sampled sound

| Field | Type | Meaning |
|---|---|---|
| `sharpness` | float 0..1 or null | see below |
| `luma` | float 0..1 or null | mean luma |
| `contrast` | float 0..1 or null | luma standard deviation, scaled |
| `clipHighPct`, `clipLowPct` | float or null | percent of pixels at the extremes |
| `saturation` | float 0..1 or null | |
| `warmth` | float -1..1 or null | red against blue balance |
| `dhash` | string or null | 64-bit perceptual hash, hex. The panel doesn't use it now: Similar shots groups by feature prints |
| `audioDb` | float or null | mean level of the loudest channel of any audio track, from sampled windows, never a full read. For AAC only the runs of sound packets are read, skipping the video between them, in at most 48 reads a track: past that, the shortest stretches of video are read through |
| `silent` | bool or null | below -50 dBFS. True only when every audio track was heard. null when a track couldn't be read and the others are quiet |
| `thumb` | string or null | absolute path to a JPEG in the cache, 480 px on the long side, from the middle moment. Log footage is graded so it looks like the shot |
| `reason` | string | only when there are no picture scores: why, in plain English |

### Sharpness

The score is meant to measure focus, not exposure, scene brightness or log flatness:

- It's measured on tiles at native resolution, because a 4K focus miss doesn't survive a scale to 320 px.
- It uses the sharpest tiles, so shallow focus on a subject scores well against a soft background.
- It's normalised by local contrast, so dark or flat log footage isn't ranked soft.

It finds soft clips. It doesn't rank in-focus ones, and it reads one frame per clip.

### Tier 2 fields: what's in the clip

All of this is worked out on the Mac, with models that ship with macOS. It runs after Tier 1, so it can't hold those lines up, and a failure here only gives nulls.

| Field | Type | Meaning |
|---|---|---|
| `moments` | int | frames actually read, up to 3, spread through the clip |
| `people` | int or null | most people seen in any one moment |
| `faces` | int or null | most faces seen in any one moment |
| `shotSize` | `medium`, `wide` or null | from head and body size. A tight face is medium: there is no close-up. null with no person or face |
| `labels` | array of `{"name","conf"}` or null | up to 12, best first |
| `text` | array of strings or null | up to 12 on-screen words |
| `sounds` | array of `{"name","conf"}` or null | up to 6. null with no audio or when a track couldn't be heard, empty when nothing was recognised |
| `speech`, `music` | bool or null | heard in the sampled windows |
| `iso` | int or null | from the file, not estimated |
| `shutterS` | float or null | exposure time in seconds |
| `aperture` | float or null | f-number |
| `shake` | float 0..1 or null | camera movement from the gyro. null when the file has none |
| `colorHue` | float 0..360 or null | the dominant colour's hue. null when the picture is effectively neutral |
| `colorChroma` | float 0..1 or null | how colourful |
| `colorLight` | float 0..1 or null | how light the dominant colour is |
| `colorName` | string or null | `red orange yellow green teal blue purple pink neutral` |
| `palette` | array of up to 5 `#rrggbb` or null | dominant colours, strongest first |

With no picture, `moments` is 0 and every picture field is null, while sound and camera values stay. A moment that couldn't be read, as when a cable is pulled, leaves `people`, `faces`, `shotSize`, `labels` and `text` null too, never 0 or empty: it could have held the face or the word, and it may read next time, so the result isn't remembered. A moment the decoder refuses stays refused, as a damaged GOP does, so the clip is judged on the moments that decoded and the result is remembered. Only a clip with no moment decoded goes through ffmpeg. `moments` counts the moments actually seen. A picture field is also null when Vision's request for it failed at any moment looked at: `labels` for the classifier, `faces` for faces, `people` and `shotSize` for people, faces or the classifier, and `text` for finding or reading words. A missed moment could have held the face or the word. Vision cancels the rest of a frame's requests when one fails, so one failure often nulls several fields. Such a result isn't remembered, so the next scan tries again.

### Dates

`createdAt` is the camera's time when the file or its sidecar gives one with a zone: Sony's XML first, beside the clip or, for a clip copied without it, inside the file (a top-level `meta` box in MP4, the header of an MXF), then the QuickTime creation date, then the date atom, then Canon's maker block (the time it was shot with its offset). These say `"dateSource":"camera"`. Offsets are written `+01:00`, whatever the file used (`+0100`, `+01`). A time with no zone could be in any zone, so it's passed over. The container's own time is UTC and comes last, written with `Z`, with `"dateSource":"container"`: the creation time in MP4 and MOV, and in MXF the time the file was written, `modification_date`, which on a Sony camera is when it was shot. The panel can hand the string straight to `new Date()`.

A copied or re-rendered file often carries the copy's date in its container. When the file name holds a date more than a day away from the container's, or the file has none, the name's date is used, with `"dateSource":"fileName"` and the container's date in `containerDate`. A camera's own date always stands. The names read: `DJI_20250906021200_0013_D.MP4` (the camera's time), `VID_20250906_021200.mp4` (the phone's time), `PXL_20250906_021200123.mp4` (UTC, as Google's camera names them) and reel names such as ARRI's `A001C001_250906_R1AB.mov`, which give the day only: then `dateOnly` is true and the time is noon. A wall-clock time is read in this Mac's zone as it was on that date.

On the 1,062 real clips of the two test projects, 838 Sony clips copied without their sidecar now get camera, lens, timecode and log curve from the XML inside the file, and each of their 838 dates is the same instant as before, now with the camera's offset. 176 Sony FX6 MXF clips are unchanged, and 6 FX6 MXF clips without a sidecar went from `Sony Mem` and no date to `Sony ILME-FX6V` with the camera's date. Of 49 DJI clips, the 2 copied ones take the date in their name.

### How Tier 2 works

**Moments.** Three keyframes, near a sixth, a half and five sixths of the way through. A short clip with few keyframes gives fewer. The middle one is the frame Tier 1 already decoded, shrunk and handed to a queue that drops work rather than wait, so Tier 1 is never held up. A dropped frame is decoded again later.

**Why it's built this way.** On the test Mac the video decoder is the wall: about 4.7 ms for a 4K frame, whatever the number of threads, so 2,919 frames need about 13.7 s. Reusing the middle frame takes a third of that off. Vision is the next wall. Classifying, faces, people and the feature print together take 2.9 ms a frame at any size, while reading words takes about 7.6 ms and barely runs in parallel. Finding where text might be takes 0.5 ms, so only frames that may have text get read. That lost 4 of 78 words on the clips we compared. One request handler per frame with all requests together took 14 ms a frame on one thread, against 25 ms for separate handlers.

**Frame size.** 1280 px on the long side. Labels, faces and people held up down to 512, but words didn't: at 768 px real signs were lost, and 1920 px took about a third longer.

**Log footage.** The thumbnail and colours are converted from log only for S-Log3 with S-Gamut3.Cine, and only when the file says that pair: the sidecar's `CaptureGammaEquation` `s-log3-cine`, or `s-log3` with `CaptureColorPrimaries` `s-gamut3-cine`, or, with no sidecar, Sony's data track naming both. On the 360 real clips that had both, the two always agreed. Any other log curve, S-Log3 with another gamut, HLG and PQ are read as recorded rather than through the wrong transform, and `colorNote` says so. Vision gets a frame with the S-Log3 curve undone channel by channel whatever the gamut, because a flat frame is hard to read and the curve alone needs no gamut. The accuracy figures below were measured with it, on S-Log3 with S-Gamut3.Cine.

**Labels.** Apple publishes a precision curve for each of its 1,303 labels. A label is kept only where that curve says at least 75% of such calls are right.

**People.** The detector sees figures in walls and buildings, so a box counts only when the classifier agrees there are people in the frame, or a face was found.

**Shot size.** Head height against frame height: 0.12 and up is medium, anything smaller is wide. There is no close-up: on 973 real clips it came up 4 times, so a tight face is medium. A person cut off by the bottom of the frame is at least medium. 927 of the 973 clips were portrait, so landscape frames are much less tested.

**Words.** Language correction on, confidence 0.5 or more, four letters or more, no mixed case, and not mostly strokes like `Illi`.

**Sound.** Every audio track is read, up to 8, because a lav or a second microphone often has a track of its own and the first may be silent. The classifier listens to the loudest. Within a track the channels are mixed, so a camera mic under a lav is heard too, with two exceptions: a channel more than 40 dB below the loudest is a dead input and is left out, rather than halve a live one, and channels in opposite polarity, which cancel in a mix, are caught by the mix keeping less than a quarter of their mean energy, and then the loudest is heard alone. Through ffmpeg, all of a clip's audio streams are put side by side and treated the same way. Everything is resampled to 16 kHz first, upward too, so 8 kHz sound isn't heard at double speed. Three windows of 2 s from the existing sample tables, joined, at 16 kHz, with a 2 s classifier window. The classifier's default of 3 s gave nothing at all on short clips. Quieter than -60 dBFS skips the classifier. Speech and music need a confidence of 0.5, and a sound needs 0.3 to be listed.

**Shake.** The angular rate from three runs of about half a second, with each run's mean removed so a steady pan doesn't count, on a log scale from 0.3 to 30 deg/s. Tripods read 0.2 to 0.9 deg/s, handheld 1.5 to 4, and whip moves 20 and up.

**Colour.** S-Log3 with S-Gamut3.Cine goes back to linear light through its own curve and gamut first, as above. Then about 3,200 pixels a moment go into Oklab. The dominant hue counts by how much of the frame wears it and how clearly. A clip is neutral when under 12% of it has any real colour, or when it's pale and warm like cream and stone.

**Similar shots.** Each moment's feature print goes in the cache. Two clips match when their closest moments are under the threshold and their average colours agree, because prints hardly see colour. Only clips in the same folder are compared, each with the 256 that follow it in name order: real repeated takes sat up to 156 apart, and no similar pair crossed folders in testing. That keeps grouping linear in the size of a project. Each group is anchored on its first clip, so it can't drift across a shoot. The threshold is 0.37 for print revision 2, set on real repeated takes, with no pair from different folders under it out of 22,773. Revision 1, which older macOS uses, has its own scale and a threshold of 11, chosen to pick out the same pairs on the same clips. A print is only compared with prints of the revision this Mac makes now, so after a macOS update old prints are worked out again, and an unknown revision gets no groups.

**Deadlines.** Every clip has a deadline in each tier: 20 s for Tier 0, 30 s for Tier 1, 45 s for Tier 2. Past it the clip gets its line with blanks and a `reason`, Vision is cancelled and ffmpeg stopped where they're running, and the scan moves on, so `groups` and `done` always arrive. A thread that's truly stuck is left behind and replaced, up to 64 times a tier. Past that something is stuck for good, so every clip of that tier not yet started gets its line at once, with a reason that says so. When every thread looking at middle frames is stuck, the frames still queued are dropped and Tier 2 decodes them itself. The engine also notices a closed stdout within a quarter of a second, without waiting to write.

**Memory.** Only what grouping needs stays in memory: where each print sits in the cache file, not the print itself. A middle frame looked at beside Tier 1 keeps its colour samples as bytes, about 15 KB a clip rather than 60 KB, so 6,144 are kept (3,072 on a Mac with less than 16 GB), and past 4,096 clips plans are read again rather than kept. `engine/tests/scale.sh` runs 50,000 generated clips, with a stand-in for Vision's models and everything else real. Cold, 0.4 took 34.5 s at a peak of 550 MB, against 35.1 s and 534 MB for 0.3 on the same run: 5,120 more middle frames are reused, for 16 MB. Cached, 2.4 s and 499 MB against 3.6 s and 713 MB, because the index is now read in parallel and no longer rewritten on every scan.

**Threads.** Fitted to the Mac: Tier 0 gets a thread a core up to 12, Tier 1 two thirds of the cores up to 12, Tier 2 two fewer than the cores up to 16, and neither more than the Mac has gigabytes; 6 threads look at middle frames, or a third of the cores. On 18 cores and 128 GB that's 12, 12, 16 and 6, as before. On the 1,062 real clips of the two test projects, with an empty cache, a scan took 18.2 to 18.4 s, against 18.3 to 18.5 s for 0.3, and its peak memory went from 1,216 MB to 1,042 MB, mostly the colour samples.

### Speed

M5 Max, 973 Sony clips, 510 GB, on a USB SSD, with an empty cache.

| Pass | Target | Measured |
|---|---|---|
| Tiers 0 and 1 | no slower than before | 4.8 s |
| All tiers | 15 s | 14.2 s |
| Rerun, cached | 1 s | 0.07 s |
| Grouping | | 11 ms |
| Peak memory, cold | | 1.1 GB, Vision's models included |

These are 0.3's.

### How right it is

Rough rates, by eye, on 60 random real clips not used for tuning, all from one kind of camera. The sample is small.

| Check | Result |
|---|---|
| Top labels fair | 47 of 57, with 3 clips given none |
| Anyone there or not | 57 of 60 |
| A face where there is one | 59 of 60. A statue got one |
| Shot size | 27 of 30 clips with someone in them |
| Colour name | 57 of 60 |
| Words | 40 of 973 clips had any. About three in five are right, and about half of readable text is found |
| Similar shots | 45 groups. Of 33 checked, 31 are true repeats |
| ISO, shutter, aperture | 24 of 24 clips match ExifTool |
| Speech | no listening test. On spectrograms, 9 of 12 clips marked as speech show it, and 0 of 12 unmarked ones do |

## When a clip can't be read

The engine must never crash on a clip, and ffmpeg is optional. Every clip ends in one of these ways.

| What happened | Tier 0 | Tier 1 | Remembered? |
|---|---|---|---|
| Read normally | fields | fields | yes |
| VideoToolbox refused, ffmpeg read it | fields | fields, slower | yes |
| No decoder, ffmpeg missing | fields | picture `null`, sound kept, `reason` | no, so ffmpeg can fill it in later |
| No decoder, ffmpeg failed too | fields | picture `null`, sound kept, `reason` | no, so the next scan tries again |
| File needs ffmpeg to be read at all, ffmpeg missing | `error` line | none | no |
| File is damaged | `error` line, or fields | none, or picture `null` and `reason` | yes |
| ffmpeg could not read the file | `error` line | none | no, so the next scan tries again |
| Read failed, such as a pulled cable | `error` line | none | no |

A clip that needs ffmpeg says so with the words `ffmpeg not found`, and the panel looks for those words.

A Mac that lacks a decoder shouldn't lose time finding that out, so the first clips of each format go one at a time, until a frame decodes. The format is open from that moment, before anything is done with the frame, so a Vision call that never returns can't hold up the other clips of that format. A format stops being tried for the rest of the run when a session won't open, or when three frames fail in a row with none decoded. After that it's tried once in 16 clips, so a wrong call can't last the whole run. In the contract test, 240 clips with a forced decoder failure make 15 to 17 attempts. Only so many ffmpeg processes run at once, and after three hangs in a row the slow route stops for the run.

## The cache

The key is the absolute path, file size, modification time and schema version, and the size and modification time of a Sony sidecar `*M01.XML` beside the clip, or that there's none: camera, lens, date and log grading come from it, so adding, changing or removing one reads the clip again and makes a new thumbnail. It's local to the Mac and holds paths, thumbnails and feature prints, so it stays out of bug reports. A blank Tier 1 or Tier 2 result is never remembered, and neither is a Tier 2 result that has lost its print or has a field left unknown.

One scan at a time writes a cache. Each scan takes an exclusive lock on the `lock` file in the cache folder, which the system lets go of however the scan ends. A second scan on the same folder waits up to 2 s for it, then runs reading the cache but writing nothing: no results, no prints, no thumbnails, so a thumbnail is `null` unless one is already there. It says so on stderr. Its Tier 2 is worked out again rather than read, because it doesn't read prints another scan may be writing. Files left by older schemas are deleted when a scan takes the lock.

It's kept under 2 GB, about 50,000 clips, or what `--cache-limit-mb` says, strips included. At the end of every scan the clips used longest ago go first, with their thumbnails and strips, until it's under 80% of the limit. Clips the scan just used are never dropped. Thumbnails and strips nothing points to any more are deleted, and the prints file is rewritten once superseded records outnumber live ones by half. The index is rewritten only once lines nothing reads any more, replaced by a later line or left by an older version of a file, outnumber the lines in use (and number over 256). Until 0.4 it was rewritten on every scan of a cache with a few results per clip, while removing nothing. When each clip was last used is written at most every six hours, so rescans cost nothing extra.

An entry's thumbnail is the file of that name in the `thumbs` folder of the cache being read. The index holds absolute paths, and until 0.4 a cache that was copied or moved, or opened through another name for the same folder, such as a symlink, lost every thumbnail at the end of its next scan, because none of them was the path the index named. The panel always uses the same folder, so this only happened to a cache that was copied, moved or restored, never to the one in use.

What Tier 0 reads grows more often than the cache's layout changes, so a Tier 0 line carries a revision of its own: `0r2` since 0.4, which added Canon's maker block, Sony's XML inside the file, MXF dates and dates in file names. A Tier 0 result from an older revision is read again on the next scan, a small read or two per clip, while its Tier 1 and Tier 2 results still come from the cache, unless the new reading changes the picture: when it finds S-Log3 the old one didn't, as in Sony's XML inside the file, a `p` line drops the clip's Tier 1 and Tier 2 results and they're worked out again with the right grade. On the 1,062 real clips that was none of them, because Sony's data track had already said the same; on 3 Sony FX6 MXF clips with no sidecar, first scanned by 0.3, it was all three. Older engines skip a kind of line they don't know and read Tier 0 again, so going back to an older version costs the same and nothing more. The schema stays 4.

## Answering from the cache

```
select-engine scan --paths-file <file|-> --cached-only [--tier 0|1|2] [--cache <dir>]
```

For bringing back a project's last results when the panel opens. Every clip is looked up by its path, size and modification time and its sidecar's, which costs a stat or two, and the clip is never opened: nothing is decoded, no sound is read, Vision doesn't run and ffmpeg isn't started. Nothing is written either: the cache's lock isn't taken, nothing is marked as used and nothing is tidied, so it answers at once even beside a scan that's writing the same cache, from what that scan has written so far. `--no-thumbs` and `--workers` change nothing here.

- The lines are a scan's, from the cache, in a scan's order: every `clip` line of Tier 0 (and `error` lines), then Tier 1, then Tier 2, then `groups`, then `done`. Clip lines say `"cached":true` and `"ms":0.0`. A clip line is exactly what a cached scan would give for that clip, except that a thumbnail whose file has gone is `null`.
- A clip the cache can't answer for gets clip lines for the tiers it can, then one `uncached` line naming the first tier it can't: `"tier":0` for a clip never scanned, or whose size, date or sidecar changed since, with `"changed":true` in that last case. A scan stopped after Tier 1 gives Tier 0 and Tier 1 lines, then `"tier":2`. As in a scan, a Tier 2 result counts only with its feature print, from the revision this Mac makes.
- A file that isn't there gets the usual `error` line, `"message":"No such file or directory"`. A clip the cache remembers as unreadable gets its remembered `error` line.
- `groups` is worked out from the cached prints of the clips that got a Tier 2 line, exactly as a scan does.
- In `done`, `clips` counts clips with a Tier 0 line, `cached` those answered at every tier asked for, `uncached` the `uncached` lines and `failed` the `error` lines.

Measured on this Mac, process start included: the 1,062 real clips in 70 ms, with the same lines and the same 43 groups as a cached scan with 0.3.0. 20,000 generated clips from a cache of 20,000 in 0.6 s at a peak of 230 MB: 0.08 s reading the index, 0.08 s checking the files, 0.17 s writing the lines and 0.23 s grouping. From a cache of 50,000, 20,000 clips take 0.7 s and all 50,000 take 1.6 s, at a peak of 500 MB.

## Strips

```
select-engine strip --path <clip> [--frames 14] [--width 384] [--cache <dir>]
```

The frames the panel slides through when someone hovers over a grid picture. One line on stdout, then exit 0:

```json
{"type":"strip","path":"/abs/C0412.MP4","file":"/abs/cache/strips/3f9a1c07e5b2d468-14x384.jpg","frames":14,"frameWidth":384,"frameHeight":216,"times":[0.520,1.580,…],"distinct":14,"cached":false,"ms":212.4}
```

or `{"type":"error","path":"…","message":"…","ms":…}`, also exit 0. Bad arguments exit 2.

- `frames` frames, 2 to 32, at the middle of as many equal slices of the clip. Each is the sync sample at or before that time, decoded on its own, so a frame costs one read and one decode whatever the GOP. `times` are the times of the frames used, in seconds. Two slices can land on the same keyframe in a long GOP: the frame is then repeated in the picture, the time repeats, and `distinct` says how many different frames there are.
- One JPEG, quality 0.8, the frames side by side left to right, each `frameWidth` by `frameHeight`, which is 16:9. Each is cropped from the centre as the grid's pictures are, after the clip is turned upright, and log footage is graded as its thumbnail is (S-Log3 with S-Gamut3.Cine only).
- MXF and anything VideoToolbox won't take go through ffmpeg, one process a frame, a few at a time, each landing on the keyframe at or before its time. Without ffmpeg that's an `error` line that says `ffmpeg not found`.
- It's cached in `strips/` in the cache folder, named by a hash of the clip's path, size and dates and its sidecar's, then `-<frames>x<width>`. The picture and a small `.json` with its fields are each written to a temporary name and renamed, the JSON last, so a strip is only ever whole. Asked again, the answer is `"cached":true` from those two files, without opening the clip. A changed clip gets a new name.
- It never takes the cache's lock and writes only in `strips/`, so it's safe beside a scan of the same cache. A scan's upkeep counts strips in the cache's size, drops them with their clip, and drops those of clips that changed or that the cache doesn't hold.
- The whole run has a deadline of 1.5 s from the process starting. Past it, the answer is an `error` line that says `took too long`, any ffmpeg it started is stopped and nothing is kept. A strip whose files are being put in place as the deadline passes is finished, and answered as kept: the renames and the deadline take the same lock, so what the answer says is what's on disk. SIGTERM stops it at once, with its ffmpeg, and removes what it was writing.

Measured on this Mac, from an external SSD over USB, each clip read for the first time, 14 frames of 384 by 216:

| Clips | Each strip |
|---|---|
| Sony XAVC-I 4K H.264 10-bit 4:2:2, 5 clips | 215 to 228 ms |
| Sony 4K H.264 8-bit long GOP, 5 clips (5 to 9 different keyframes) | 147 to 185 ms |
| iPhone HEVC 4K, 10-bit and 8-bit, 4 clips | 95 to 107 ms |
| DJI Osmo Pocket 3 HEVC 10-bit 3K, 5 clips | 89 to 121 ms |
| Sony FX6 MXF 4K XAVC-I through ffmpeg, 4 clips | 745 to 815 ms |
| Any of these from the cache | 6 ms |

Starting the engine costs about 6 ms. A Mac with fewer cores runs fewer ffmpeg processes at once, so MXF there may pass the deadline and get no strip.

## Revealing in the Finder

```
select-engine reveal <path> [<path> ...]
```

The panel's Reveal in Finder. `open -R` with several files selects only the last one, so the engine asks the Finder itself, through NSWorkspace, and every file comes up selected. One line on stdout, then exit 0:

```json
{"type":"reveal","shown":3,"missing":1,"ms":6.9}
```

or `{"type":"error","message":"The Finder took too long.","ms":3000.4}`, also exit 0. No path, or an argument that starts with `-`, exits 2.

- Files that aren't on disk are left out, and `missing` counts them. When none is on disk the answer is `"shown":0`, and the Finder isn't asked.
- It needs no permission to control the Finder, so there's no Automation prompt. Files in several folders may open several Finder windows.
- The whole run has a deadline of 3 s from the process starting. Past it, the answer is the error line. SIGTERM stops it at once.
- The panel sends the first 20 files that are on disk. If the engine is missing or fails, the panel runs `open -R` on the first file instead, so Reveal in Finder always shows something.

Checked on this Mac: 3 files in one folder came up in one Finder window, all 3 selected, in 7 ms, with no prompt.

## Nothing leaves the Mac

The engine has no networking in it. To check, we ran 30 real clips in a macOS sandbox that denies all network access, and all 30 Tier 2 lines came out the same as without it. `lsof` saw no internet socket during a scan, and the binary imports no socket or URL calls. The sandbox covers the engine itself. Anything macOS does in its own background services is beyond what this can show.

## For tests

These are set only by `engine/tests/contract.sh`, and the panel never sets them.

| Variable | Effect |
|---|---|
| `ENGINE_TEST_DECODER=open` | VideoToolbox sessions refuse to open |
| `ENGINE_TEST_DECODER=frame` | Sessions open and every frame fails |
| `ENGINE_TEST_NO_FFMPEG=1` | ffmpeg is treated as missing |
| `ENGINE_TEST_HANG=<stage>` | a clip whose path contains `hang` stops for good at `tier0`, `tier1`, `vision`, `sound`, `middle` or `strip`. With `reveal`, a run given such a path stops before it asks the Finder |
| `ENGINE_TEST_NO_FINDER=1` | `reveal` answers as usual without asking the Finder, so the tests never open a window |
| `ENGINE_TEST_READ_FAIL=1` | for a clip whose path contains `rfail`, reading the last of its Tier 2 moments fails, as a pulled cable or a bad block would |
| `ENGINE_TEST_DECODE_FAIL=1` | for a clip whose path contains `dfail`, the decoder refuses the last of its Tier 2 moments, as it would a damaged GOP |
| `ENGINE_TEST_STRIP_COMMIT_WAIT=<s>` | a strip waits this long between putting its JSON and its picture in place, so it finishes past its deadline |
| `ENGINE_TEST_DEADLINE=<s>` | every deadline becomes this many seconds, a strip's and a reveal's too |
| `ENGINE_TEST_PRINT_REVISION=<n>` | asks Vision for another feature print revision |
| `ENGINE_TEST_FAKE_VISION=1` | prints from the pixels instead of the models, for `scale.sh` |
| `ENGINE_TEST_VISION_FAIL=<requests>` | for a clip whose path contains `vfail`, the named Vision requests, any of `classify`, `faces`, `people`, `print`, `boxes`, `text`, are asked for a revision no Mac has, so Vision fails them for real |
| `ENGINE_TRACE=<file>` | writes per-clip timings to a file, and totals by stage to stderr |

## The panel's side

- Premiere's panel runs on CEP, with Node enabled.
- Sorting happens in the panel and changes nothing in the project. Every write to the project is a separate button.
- Clips are never renamed, files are never moved, and sequences aren't touched.
