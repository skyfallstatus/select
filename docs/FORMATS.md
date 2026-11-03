# Formats and decoders

Select reads MP4 and MOV itself and decodes one frame through VideoToolbox, the Mac's own video system. That's what makes it fast, and it means a format only gets picture scores if the Mac has a decoder for it. ffmpeg is the optional slow route. MXF always needs it, because the direct reader doesn't handle MXF.

Every claim here carries a label, explained in [CONTRIBUTING.md](../CONTRIBUTING.md). So far only one Mac has been tested, so most of what matters about other Macs is still `[UNKNOWN]`.

## What was measured

`[TESTED]` M5 Max, macOS 27.2, November 2026. Tiny generated clips, 4K unless noted, through the engine with ffmpeg turned off. **Normal** is how the engine runs. **Hardware off** asks VideoToolbox not to use hardware, which shows whether macOS has a software decoder to fall back on.

| Format | Normal | Hardware off |
|---|---|---|
| H.264 8-bit 4:2:0 | hardware | software |
| H.264 10-bit 4:2:0 | hardware | **no decoder** |
| H.264 8-bit 4:2:2 | hardware | **no decoder** |
| H.264 10-bit 4:2:2, long GOP | hardware | **no decoder** |
| H.264 10-bit 4:2:2, all-intra, 4K and 1080p | hardware | **no decoder** |
| H.264 8-bit 4:4:4 | hardware | **no decoder** |
| HEVC 8-bit 4:2:0 | hardware | software |
| HEVC 10-bit 4:2:0 | hardware | software |
| HEVC 10-bit 4:2:2 | hardware | software |
| HEVC 10-bit 4:4:4 | hardware | software |
| ProRes 422 HQ | hardware | software |
| ProRes 4444 | hardware | software |
| AV1 10-bit 4:2:0, 1080p | hardware | **no decoder** |
| Motion JPEG, 1080p | software | software |
| MPEG-2 8-bit 4:2:2, 1080p | no decoder | no decoder |
| VP9 8-bit 4:2:0, 1080p | no decoder | no decoder |
| DNxHR HQ, 1080p | no decoder | no decoder |
| FFV1 | no decoder | not run |

The clips were generated with ffmpeg, not recorded by a camera, so they show what the decoder accepts, not how a given camera's files behave.

With hardware off, H.264 10-bit 4:2:2 is the awkward case: the decoder session opens, then every frame fails with error -8969. That's why the engine gives up on a format after three failed frames, not only when a session won't open.

**What this means.** `[TESTED]` macOS 27 has a software decoder for HEVC and ProRes, but for H.264 only at 8-bit 4:2:0. So any Mac whose hardware doesn't take H.264 10-bit 4:2:2 should have no system decoder for it at all. That last step is an inference from one Mac with hardware turned off. No such Mac has been tested.

## What Adobe and Apple say

- `[ADOBE]` "Apple silicon (M1 Pro, M1 Max, M1 Ultra or newer) supports hardware-accelerated encoding and decoding for H.264 and H.265, including 10-bit 4:2:2 decoding." From [Hardware-accelerated encoding and decoding in Premiere](https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/hardware-accelerated-decoding-and-encoding.html), last updated January 2026. This is about Premiere, but it describes the chips.
- `[ADOBE]` Adobe turned on hardware decoding of HEVC and H.264 4:2:2 10-bit on Apple silicon in a 2021 beta, without naming chips: [announcement](https://community.adobe.com/announcements-732/discuss-hardware-acceleration-decode-for-4-2-2-10-bit-h264-hevc-now-available-on-mac-arm-beta-312861).
- `[ADOBE]` "Premiere, Adobe Media Encoder, and After Effects (version 22.0 and later) support HEVC 4:2:2 10-bit decoding on Intel platforms." From [Supported codecs for hardware-accelerated decoding](https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/supported-codecs-and-drivers-for-hardware-accelerated-decoding.html). The page doesn't claim the same for H.264 10-bit 4:2:2.
- `[APPLE]` Apple's specifications list the media engine as, for M1 Max, "Hardware-accelerated H.264, HEVC, ProRes, and ProRes RAW" ([Mac Studio 2022](https://support.apple.com/en-us/111900)). They name codecs only, not bit depth or chroma, so they don't settle this question.

A format playing in Premiere doesn't prove the engine can read it. Premiere has decoders of its own, and the engine only has what macOS offers.

## What isn't known

- `[UNKNOWN]` Whether the base M1 decodes H.264 10-bit 4:2:2 through VideoToolbox. Adobe's sentence starts at M1 Pro, and we found no clear statement from Apple. Forum reports disagree.
- `[UNKNOWN]` Whether "or newer" covers the base M2, M3, M4 and M5 through VideoToolbox. It reads that way, but only an M5 Max has been run.
- `[UNKNOWN]` Any Intel Mac. The inference above says H.264 10-bit 4:2:2 needs ffmpeg there.
- `[UNKNOWN]` macOS 13, 14, 15 and 26. Decoders may differ from macOS 27.

If you're on one of these, a scan of a few clips and the message on a blank row would answer it. See [BETA.md](../BETA.md).

## What happens on a Mac without the decoder

`[TESTED]` Forced on the same Mac, with the failure injected.

- The clip keeps everything that needs no decoding: size, duration, codec, bit depth, camera, motion stand-in, and usually the sound level.
- The picture scores are `null`, and the clip gets a plain reason.
- 240 clips cost 15 to 17 decoder attempts, not 240, because a format that doesn't work stops being tried.
- With ffmpeg installed, picture scores come back through it, a good deal more slowly, because each clip takes its own process.

`[TESTED]` ffmpeg really out of reach: the contract test also runs the engine in a macOS sandbox that denies it the folder ffmpeg lives in. No crash, and the same plain messages.

## Containers

| Container | Needs ffmpeg |
|---|---|
| MP4, M4V, MOV | No, unless the file is fragmented |
| MXF | Yes |
| Anything else ffmpeg can open, such as MTS or AVI | Yes, and it's not tested |
| R3D, BRAW | Not supported. ffmpeg doesn't help |
