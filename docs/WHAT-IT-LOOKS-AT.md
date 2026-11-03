# What Select looks at

Everything Select shows is a place to look first, never a verdict on a clip. This page says what each choice measures and how sure it is, from checks on real footage.

**Show** picks which clips are on screen.

- **Interviews.** Speech heard and a face seen, 15 seconds or longer. Where the camera recorded its movement, a clip shakier than a handheld camera is left out, by a fixed line that doesn't depend on the other clips in the scan. Shorter clips with someone talking were nearly always not interviews. With an earlier rule, which kept only the steadier part of each scan, it found 20 clips on a real event shoot and 19 were interviews. The fixed line keeps more handheld clips, and it hasn't been checked clip by clip yet. It finds likely interviews, not certain ones.
- **People, No people.** Whether Select saw anyone in three moments of the clip. It misses people in the dark and undercounts crowds. On 60 real clips it was right about whether anyone was there on 57.
- **Mediums, Wides.** From the size of the head or body in the frame, on tall frames as well as wide ones: medium is someone from about the waist up, or closer; wide is people small in the frame. A statue can get a face. On 30 real clips with someone in them it agreed with a person's call on 27. Nearly all of those clips were tall frames, so wide frames are less tested.
- **Speech, Music, Silent.** From six seconds of sound sampled across the clip, so a word or a song elsewhere in it can be missed. Crowd noise can read as speech. Silent is clips with no audio track, or silence wherever it was sampled. We've checked sound less than the rest.
- **Text on screen.** Words on signs and titles. It found about half of what was readable, mostly big clear lettering, and about two words in five are misreads. It's good for finding the shot of the sign.
- **Similar shots.** Groups clips that show the same setup, such as repeated takes, among the clips in one folder, and keeps each group together. On 973 real clips it made 45 groups. Of 33 we checked, 31 were true repeats, and the two misses were flat textures. The same place from another angle usually stays apart.

**Sort** puts them in order. Each starts the useful way round, and the arrows beside it turn it round.

- **Shoot order.** By the time written in the file, then by name. It trusts the camera's clock. Times show in this Mac's time zone, so a clip reads the same whether or not its sidecar file came along.
- **Duration, Loudness.** Longest first, loudest first. Loudness is the average level of the sampled sound.
- **Sharpness.** Sharpest first, or softest first turned round. Good at finding soft clips. It doesn't rank in-focus clips against each other, so the top isn't "your best shot". It reads one frame per clip, so a clip that's soft for a moment can slip past, and a plain wall scores low because it has no fine detail.
- **Brightness.** The average brightness of that one frame. Log footage and night scenes sit low on purpose.
- **Highlights.** How much of that one frame hits the top of the range. It can do little on log footage, because log rarely clips. A window or a lamp can account for all of it.
- **Motion.** A stand-in, not real motion tracking. It reads how much the compressed frame sizes change along the clip, without looking at a single frame. It's weak on all-intra footage, where every frame is stored whole, and busy detail or a change of light can read as motion.
- **Camera shake.** Steadiest first, from the camera's own gyro, on the Sony clips that record one. Other clips stay blank at the end. It's measured over about a second and a half of the clip.
- **Colour.** Clips in rainbow order by their main colour, with neutral clips last. Footage in S-Log3 with S-Gamut3.Cine is read through that curve and gamut, so it has real colours here. Other log footage, such as S-Log2 or S-Log3 with another gamut, and HLG or PQ, is left as recorded: its colours and thumbnail look flatter than the shot, and the clip's tooltip says so. On 60 real clips it matched what a person would say on 57. The colour dots show one colour at a time.

**Sort into Bins** follows what's on screen: a bin per colour when sorted by colour, a bin per day in shoot order (this Mac's days, from midnight to midnight), a bin per group of similar shots, one bin for a Show such as Interviews, and five bins from top to bottom for the other sorts.

## Speed and other details

- **It's quick, and how quick depends on your Mac.** On an M5 Max from a USB SSD, 973 clips, 510 GB, got their file details and scores in about 5 seconds, which is about 2 seconds per 400, and the full look at people, words, sound and colour finished after 14 seconds. The list is usable from the start. A rescan took under a tenth of a second, because results are remembered. Yours will vary.
- **Labels and words are suggestions.** They come from Apple's on-device models, and they're often right and sometimes odd. On 60 real clips the top labels were fair on 47 of 57, and the misses were mostly art taken literally.
- **Camera and lens depend on sidecar files.** Select reads them from the small file some cameras write beside each clip, such as Sony's `M01.XML`. Move a clip without it and those columns go blank.
- **A blank score means Select couldn't get it, never a guess.** Blank clips sort last. A clip whose people, faces or sound couldn't be measured stays blank there too, and it never counts as No people or Silent. When a clip's picture can't be read, Select says why. If your Mac has no decoder for a clip, the file details stay and the picture scores stay blank. Open **Formats** below for more.

## Formats

MP4 and MOV work on their own. MXF works when [ffmpeg](https://ffmpeg.org) is installed (`brew install ffmpeg`), and it's slower. RED and BRAW aren't supported yet. The full picture is in [FORMATS.md](FORMATS.md).
