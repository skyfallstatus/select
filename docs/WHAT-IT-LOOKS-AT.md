# What Select looks at

Everything Select shows is a place to look first, never a verdict on a clip. This page says what each choice measures and how sure it is, from checks on real footage.

**Show** picks which clips are on screen.

- **Interviews.** Speech heard clearly (Apple's sound model at least 70% sure it's speech), a face seen, a medium shot (from about the waist up, or closer), and 15 seconds or longer. Camera shake doesn't count against it, so handheld interviews and vox pops stay in. The rule is the same whatever else is in the scan. Checked by eye on the 326 clips with any speech in two real projects: it found all 46 interviews, and let in one clip that wasn't one. The rule before it found 42, missed 4 and let in 12. It finds likely interviews, not certain ones, and a vlog can pass too.
- **People, No people.** Whether Select saw anyone in three moments of the clip. It misses people in the dark and undercounts crowds. On 60 real clips it was right about whether anyone was there on 57.
- **Mediums, Wides.** From the size of the head or body in the frame, on tall frames as well as wide ones: medium is someone from about the waist up, or closer; wide is people small in the frame. A statue can get a face. On 30 real clips with someone in them it agreed with a person's call on 27. Nearly all of those clips were tall frames, so wide frames are less tested.
- **Speech, Music, Silent.** From six seconds of sound sampled across the clip, so a word or a song elsewhere in it can be missed. Crowd noise can read as speech. Silent is clips with no audio track, or silence wherever it was sampled. We've checked sound less than the rest.
- **Text on screen.** Words on signs and titles. It found about half of what was readable, mostly big clear lettering, and about two words in five are misreads. It's good for finding the shot of the sign.
- **Similar shots.** Groups clips that show the same setup, such as repeated takes, among the clips in one folder, and keeps each group together. On 973 real clips it made 45 groups. Of 33 we checked, 31 were true repeats, and the two misses were flat textures. The same place from another angle usually stays apart.

**Sort** puts them in order. Each starts the useful way round, and the arrows beside it turn it round.

- **Shoot order.** By when each clip was recorded, from the camera's clock, so a clock set wrong stays wrong. Times show in this Mac's time zone, so a clip reads the same whether or not its sidecar file came along. A copied DJI, ARRI, Pixel or Android clip often carries the day it was copied. When the date in its name is more than a day away from the file's, or the file has none, the name's date is used, and the clip's tooltip says so and gives the file's own date. ARRI names hold the day only, so those clips sit at noon.
- **Duration, Loudness.** Longest first, loudest first. Loudness is the average level of the sampled sound.
- **Sharpness.** Sharpest first, or softest first turned round. Good at finding soft clips. It doesn't rank in-focus clips against each other, so the top isn't "your best shot". It reads one frame per clip, so a clip that's soft for a moment can slip past, and a plain wall scores low because it has no fine detail.
- **Brightness.** The average brightness of that one frame. Log footage and night scenes sit low on purpose.
- **Highlights.** How much of that one frame hits the top of the range. It can do little on log footage, because log rarely clips. A window or a lamp can account for all of it.
- **Motion.** A stand-in, not real motion tracking. It reads how much the compressed frame sizes change along the clip, without looking at a single frame. It's weak on all-intra footage, where every frame is stored whole, and busy detail or a change of light can read as motion.
- **Camera shake.** Steadiest first, from the camera's own gyro, on the Sony clips that record one. Other clips stay blank at the end. It's measured over about a second and a half of the clip.
- **Camera.** A to Z by maker and model, from the file or its sidecar. Clips with no camera named come last, both ways round.
- **Colour.** Clips in rainbow order by their main colour, with neutral clips last. Footage in S-Log3 with S-Gamut3.Cine is read through that curve and gamut, so it has real colours here. Other log footage, such as S-Log2 or S-Log3 with another gamut, and HLG or PQ, is left as recorded: its colours and thumbnail look flatter than the shot, and the clip's tooltip says so. On 60 real clips it matched what a person would say on 57. A colour dot shows that colour, and Shift-click adds more.

**Sort into Bins** follows what's on screen. Similar shots makes a bin per group. Sorted by colour, shoot order or camera, it makes a bin per colour, per day (this Mac's days, from midnight to midnight) or per camera. Otherwise a Show makes one bin, a sort such as Sharpness makes five from top to bottom, and a colour dot, a search or clips you picked make one. Two colour dots or more make a bin per colour. **Other** in the sheet adds a bin for the clips the view leaves out, and clips with no value go in `No value`. Clips whose values read the same stay in one bin, so ten clips with the same sharpness never end up in five. Subclips are left alone. What it writes, and how Select's Undo takes it back: [What Select writes](WHAT-IT-WRITES.md).

**Search** finds clips by name, by the Premiere bins they sit in and their last three folders on disk (a card, a camera, a day), and by what the frames show, words on screen, sounds, camera, lens, shot size and colour. A clip found by a folder or a bin shows its name under the clip's: `DAY 2`. A number has to follow its word in the same folder, bin or phrase, so `day 2` finds `DAY 2` and `DAY2`, but not `DAY 1/CARD 2`, `DAY 24` or a 24-70mm lens. Each part of a dotted or comma number is found as well as the whole: `2026` finds `04.11.2026`. In a file name a number finds the start of a run of digits, so `0412` finds `C0412.MP4`. Suggestions come up as you type, from this scan's labels, words on screen, sounds, cameras, folders and bins, each with how many clips picking it shows.

## Speed and other details

- **It's quick, and how quick depends on your Mac.** On an M5 Max from a USB SSD, 973 clips, 510 GB, got their file details and scores in about 5 seconds, which is about 2 seconds per 400, and the full look at people, words, sound and colour finished after 14 seconds. The list is usable from the start. A rescan took under a tenth of a second, because results are remembered. Yours will vary.
- **Labels and words are suggestions.** They come from Apple's on-device models, and they're often right and sometimes odd. On 60 real clips the top labels were fair on 47 of 57, and the misses were mostly art taken literally.
- **Camera and lens come from the camera's own record.** Sony keeps it beside each clip in `M01.XML` and again inside the file, and Canon inside the file, so they survive a copy. Clips from other cameras, and files written by an editing program, may have none.
- **A blank score means Select couldn't get it, never a guess.** Blank clips sort last. A clip whose people, faces or sound couldn't be measured stays blank there too, and it never counts as No people or Silent. When a clip's picture can't be read, Select says why. If your Mac has no decoder for a clip, the file details stay and the picture scores stay blank. Open **Formats** below for more.

## Formats

MP4 and MOV work on their own. MXF works when [ffmpeg](https://ffmpeg.org) is installed (`brew install ffmpeg`), and it's slower. RED and BRAW aren't supported yet. The full picture is in [FORMATS.md](FORMATS.md).
