# The engine

`select-engine` is a native macOS command line program, written in Swift, that ships inside the panel at `bin/select-engine`. The panel starts it, reads its output and never waits on it, so Premiere is never blocked by a scan.

It's a universal binary, for Apple silicon and Intel, and runs on macOS 13 or later. The name, id and version come from `product.conf`.

## Command line

```
select-engine scan --paths-file <file|-> [--tier 0|1|2] [--cache <dir>] [--workers <n>] [--no-thumbs] [--cache-limit-mb <n>]
select-engine version
select-engine --version
```

- `--tier` defaults to 2, which emits all three. `--tier 0` and `--tier 1` stop early.
- `--cache` defaults to `~/Library/Caches/com.skyfallstatus.select`, and `--cache-limit-mb` to 2048.
- `--paths-file` holds one absolute path per line. `-` reads stdin.
- Output on stdout is JSON Lines, flushed per line, in completion order, so the panel can update live.
- Logs go to stderr only. It exits 0 even if single clips fail, and 2 on bad arguments.
- SIGTERM or a closed stdout stops the run promptly, along with any ffmpeg it started.
- The engine opens media read-only and never writes beside it.

## Output lines

```json
{"type":"start","total":400,"schema":1,"engineVersion":"0.1.0"}
{"type":"clip","tier":0,"path":"/abs/clip.mp4","cached":false,"ms":3.1, ...fields...}
{"type":"clip","tier":1,"path":"/abs/clip.mp4","cached":false,"ms":41.0, ...fields...}
{"type":"clip","tier":2,"path":"/abs/clip.mp4","cached":false,"ms":90.0, ...fields...}
{"type":"error","path":"/abs/clip.mp4","message":"..."}
{"type":"groups","groups":[{"id":1,"paths":["/abs/a.mp4","/abs/b.mp4"]}]}
{"type":"done","clips":400,"failed":0,"cached":0,"wallMs":7300,"degraded":0}
```

A line carries only its own tier's fields, and the panel merges lines by `path`. All Tier 1 lines come before any Tier 2 line. `groups` comes once, after the last Tier 2 line and before `done`, and only clips in a group of two or more appear in it. A field the engine can't get is `null`, never a guess. New fields may be added, so ignore ones you don't know.

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
| `audioChannels` | int or null | |
| `createdAt` | string or null | ISO 8601, camera time when present |
| `timecode` | string or null | start timecode |
| `camera` | string or null | maker and model |
| `lens` | string or null | from embedded metadata or a Sony sidecar `*M01.XML` |
| `gamma` | string or null | e.g. `s-log3-cine` |
| `isLog` | bool or null | gamma says log |
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
| `dhash` | string or null | 64-bit perceptual hash, hex, for near-duplicate grouping |
| `audioDb` | float or null | mean level from sampled windows, never a full read |
| `silent` | bool or null | |
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
| `shotSize` | `closeup`, `medium`, `wide` or null | from head and body size. null with no person or face |
| `labels` | array of `{"name","conf"}` or null | up to 12, best first |
| `text` | array of strings or null | up to 12 on-screen words |
| `sounds` | array of `{"name","conf"}` or null | up to 6. null with no audio, empty when nothing was recognised |
| `speech`, `music` | bool or null | heard in the sampled windows |
| `iso` | int or null | from the file, not estimated |
| `shutterS` | float or null | exposure time in seconds |
| `aperture` | float or null | f-number |
| `whiteBalanceK` | null | part of the line, and null on every file so far |
| `shake` | float 0..1 or null | camera movement from the gyro. null when the file has none |
| `colorHue` | float 0..360 or null | the dominant colour's hue. null when the picture is effectively neutral |
| `colorChroma` | float 0..1 or null | how colourful |
| `colorLight` | float 0..1 or null | how light the dominant colour is |
| `colorName` | string or null | `red orange yellow green teal blue purple pink neutral` |
| `palette` | array of up to 5 `#rrggbb` or null | dominant colours, strongest first |

With no picture, `moments` is 0 and every picture field is null, while sound and camera values stay. Picture fields are null, not empty, only when no frame was read.

### How Tier 2 works

**Moments.** Three keyframes, near a sixth, a half and five sixths of the way through. A short clip with few keyframes gives fewer. The middle one is the frame Tier 1 already decoded, shrunk and handed to a queue that drops work rather than wait, so Tier 1 is never held up. A dropped frame is decoded again later.

**Why it's built this way.** On the test Mac the video decoder is the wall: about 4.7 ms for a 4K frame, whatever the number of threads, so 2,919 frames need about 13.7 s. Reusing the middle frame takes a third of that off. Vision is the next wall. Classifying, faces, people and the feature print together take 2.9 ms a frame at any size, while reading words takes about 7.6 ms and barely runs in parallel. Finding where text might be takes 0.5 ms, so only frames that may have text get read. That lost 4 of 78 words on the clips we compared. One request handler per frame with all requests together took 14 ms a frame on one thread, against 25 ms for separate handlers.

**Frame size.** 1280 px on the long side. Labels, faces and people held up down to 512, but words didn't: at 768 px real signs were lost, and 1920 px took about a third longer.

**Log footage.** S-Log3 is named in Sony's data track or sidecar. Vision then gets a frame graded for display, because a flat frame is hard to read. The accuracy figures below were measured with it.

**Labels.** Apple publishes a precision curve for each of its 1,303 labels. A label is kept only where that curve says at least 75% of such calls are right.

**People.** The detector sees figures in walls and buildings, so a box counts only when the classifier agrees there are people in the frame, or a face was found.

**Shot size.** Head height against frame height: 0.25 and up is a close-up, 0.12 and up is medium, anything smaller is wide. A person cut off by the bottom of the frame is at least medium. 927 of the 973 clips were portrait, so landscape frames are much less tested.

**Words.** Language correction on, confidence 0.5 or more, four letters or more, no mixed case, and not mostly strokes like `Illi`.

**Sound.** Everything is resampled to 16 kHz first, upward too, so 8 kHz sound isn't heard at double speed. Three windows of 2 s from the existing sample tables, joined, at 16 kHz, with a 2 s classifier window. The classifier's default of 3 s gave nothing at all on short clips. Quieter than -60 dBFS skips the classifier. Speech and music need a confidence of 0.5, and a sound needs 0.3 to be listed.

**Shake.** The angular rate from three runs of about half a second, with each run's mean removed so a steady pan doesn't count, on a log scale from 0.3 to 30 deg/s. Tripods read 0.2 to 0.9 deg/s, handheld 1.5 to 4, and whip moves 20 and up.

**Colour.** Log goes back to linear light through its own curve and gamut first. Then about 3,200 pixels a moment go into Oklab. The dominant hue counts by how much of the frame wears it and how clearly. A clip is neutral when under 12% of it has any real colour, or when it's pale and warm like cream and stone.

**Similar shots.** Each moment's feature print goes in the cache. Two clips match when their closest moments are under the threshold and their average colours agree, because prints hardly see colour. Only clips in the same folder are compared, each with the 256 that follow it in name order: real repeated takes sat up to 156 apart, and no similar pair crossed folders in testing. That keeps grouping linear in the size of a project. Each group is anchored on its first clip, so it can't drift across a shoot. The threshold is 0.37 for print revision 2, set on real repeated takes, with no pair from different folders under it out of 22,773. Revision 1, which older macOS uses, has its own scale and a threshold of 11, chosen to pick out the same pairs on the same clips. A print is only compared with prints of the revision this Mac makes now, so after a macOS update old prints are worked out again, and an unknown revision gets no groups.

**Deadlines.** Every clip has a deadline in each tier: 20 s for Tier 0, 30 s for Tier 1, 45 s for Tier 2. Past it the clip gets its line with blanks and a `reason`, Vision is cancelled and ffmpeg stopped where they're running, and the scan moves on, so `groups` and `done` always arrive. A thread that's truly stuck is left behind and replaced. The engine also notices a closed stdout within a quarter of a second, without waiting to write.

**Memory.** Only what grouping needs stays in memory: where each print sits in the cache file, not the print itself. The middle frames looked at beside Tier 1 are capped at 1,024, and past 4,096 clips plans are read again rather than kept. `engine/tests/scale.sh` runs 50,000 generated clips, with a stand-in for Vision's models and everything else real: 32 s and a peak of 469 MB cold, 3.0 s and 662 MB cached. The cached peak is mostly the cache's own index.

### Speed

M5 Max, 973 Sony clips, 510 GB, on a USB SSD, with an empty cache.

| Pass | Target | Measured |
|---|---|---|
| Tiers 0 and 1 | no slower than before | 4.8 s |
| All tiers | 15 s | 14.2 s |
| Rerun, cached | 1 s | 0.07 s |
| Grouping | | 11 ms |
| Peak memory, cold | | 1.1 GB, Vision's models included |

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

A Mac that lacks a decoder shouldn't lose time finding that out, so the first clips of each format go one at a time. A format stops being tried for the rest of the run when a session won't open, or when three frames fail in a row with none decoded. After that it's tried once in 16 clips, so a wrong call can't last the whole run. In the contract test, 240 clips with a forced decoder failure make 15 to 17 attempts. Only so many ffmpeg processes run at once, and after three hangs in a row the slow route stops for the run.

## The cache

The key is the absolute path, file size, modification time and schema version. It's local to the Mac and holds paths, thumbnails and feature prints, so it stays out of bug reports. A blank Tier 1 or Tier 2 result is never remembered, and neither is a Tier 2 result that has lost its print.

It's kept under 2 GB, about 50,000 clips, or what `--cache-limit-mb` says. At the end of every scan the clips used longest ago go first, with their thumbnails, until it's under 80% of the limit. Clips the scan just used are never dropped. Thumbnails nothing points to any more are deleted, and the prints file is rewritten once superseded records outnumber live ones by half. When each clip was last used is written at most every six hours, so rescans cost nothing extra.

## Nothing leaves the Mac

The engine has no networking in it. To check, we ran 30 real clips in a macOS sandbox that denies all network access, and all 30 Tier 2 lines came out the same as without it. `lsof` saw no internet socket during a scan, and the binary imports no socket or URL calls. The sandbox covers the engine itself. Anything macOS does in its own background services is beyond what this can show.

## For tests

These are set only by `engine/tests/contract.sh`, and the panel never sets them.

| Variable | Effect |
|---|---|
| `ENGINE_TEST_DECODER=open` | VideoToolbox sessions refuse to open |
| `ENGINE_TEST_DECODER=frame` | Sessions open and every frame fails |
| `ENGINE_TEST_NO_FFMPEG=1` | ffmpeg is treated as missing |
| `ENGINE_TEST_HANG=<stage>` | a clip whose path contains `hang` stops for good at `tier0`, `tier1`, `vision`, `sound` or `middle` |
| `ENGINE_TEST_DEADLINE=<s>` | every deadline becomes this many seconds |
| `ENGINE_TEST_PRINT_REVISION=<n>` | asks Vision for another feature print revision |
| `ENGINE_TEST_FAKE_VISION=1` | prints from the pixels instead of the models, for `scale.sh` |
| `ENGINE_TRACE=<file>` | writes per-clip timings to a file, and totals by stage to stderr |

## The panel's side

- Premiere's panel runs on CEP, with Node enabled.
- Sorting happens in the panel and changes nothing in the project. Every write to the project is a separate button.
- Clips are never renamed, files are never moved, and sequences aren't touched.
