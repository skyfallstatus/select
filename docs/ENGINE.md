# The engine

`select-engine` is a native macOS command line program, written in Swift, that ships inside the panel at `bin/select-engine`. The panel starts it, reads its output and never waits on it, so Premiere is never blocked by a scan.

It's a universal binary, for Apple silicon and Intel, and runs on macOS 13 or later. The name, id and version come from `product.conf`.

## Command line

```
select-engine scan --paths-file <file|-> [--tier 0|1] [--cache <dir>] [--workers <n>] [--no-thumbs]
select-engine version
select-engine --version
```

- `--tier` defaults to 1, which emits both tiers.
- `--cache` defaults to `~/Library/Caches/com.skyfallstatus.select`.
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
{"type":"error","path":"/abs/clip.mp4","message":"..."}
{"type":"done","clips":400,"failed":0,"cached":0,"wallMs":7300,"degraded":0}
```

A Tier 1 line carries only Tier 1 fields, and the panel merges lines by `path`. A field the engine can't get is `null`, never a guess. New fields may be added, so ignore ones you don't know.

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
| `thumb` | string or null | absolute path to a JPEG in the cache, 240 px on the long side |
| `reason` | string | only when there are no picture scores: why, in plain English |

### Sharpness

The score is meant to measure focus, not exposure, scene brightness or log flatness:

- It's measured on tiles at native resolution, because a 4K focus miss doesn't survive a scale to 320 px.
- It uses the sharpest tiles, so shallow focus on a subject scores well against a soft background.
- It's normalised by local contrast, so dark or flat log footage isn't ranked soft.

It finds soft clips. It doesn't rank in-focus ones, and it reads one frame per clip.

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

The key is the absolute path, file size, modification time and schema version. It's local to the Mac and holds paths and thumbnails, so it stays out of bug reports.

## For tests

These are set only by `engine/tests/contract.sh`, and the panel never sets them.

| Variable | Effect |
|---|---|
| `ENGINE_TEST_DECODER=open` | VideoToolbox sessions refuse to open |
| `ENGINE_TEST_DECODER=frame` | Sessions open and every frame fails |
| `ENGINE_TEST_NO_FFMPEG=1` | ffmpeg is treated as missing |
| `ENGINE_TRACE=<file>` | writes per-clip timings to a file |

## The panel's side

- Premiere's panel runs on CEP, with Node enabled.
- Sorting happens in the panel and changes nothing in the project. Every write to the project is a separate button.
- Clips are never renamed, files are never moved, and sequences aren't touched.
