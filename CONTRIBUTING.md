# Contributing

Thanks for looking. Select sits inside other people's paid work, so it's run more carefully than most small projects.

## Three rules

- **Files are never written to.** The engine opens media read-only and writes nothing beside it. A change that breaks this won't be accepted.
- **Sorting changes nothing.** Every write to a project is a separate button that says what it does, and it has to be undoable from the panel. The one exception is importing a clip you asked to open.
- **A number the engine can't get is `null`, never a guess.** The words around it are honest too: a score is a place to look first, not a verdict.

## Keep private things out

- **No footage in the repository.** Tests make tiny clips with ffmpeg in a temp folder, and that folder goes away.
- **No real paths, client names, serials or personal names.** Use made-up values of the same shape.
- If a test really needs your own media, keep it in `.local/`, which git ignores.

## One real sample per format claim

A new format needs at least one real file from that camera before the README says it works. Documents are a good start, but they've been wrong before.

`docs/FORMATS.md` and `docs/PACKAGING.md` label every claim:

| Label | Meaning |
|---|---|
| `[TESTED]` | Run here, on the machine named |
| `[ADOBE]`, `[APPLE]` | Stated by Adobe or Apple, with a link |
| `[SECONDARY]` | A forum, third-party tool or article |
| `[UNKNOWN]` | Nobody here knows yet. Don't ship a claim on this |

Please don't move something up without the evidence for it.

## How to test

```sh
scripts/test.sh
```

That builds the engine and runs the contract test, the fuzz test and the panel's unit tests. It needs no footage, no Premiere and no hardware. ffmpeg makes the test clips, so without it the clip tests skip and say so. The contract test stops itself after 7 minutes, and the fuzz test stops at 64 MB of clips.

- **Engine changes** need a test in `engine/tests/contract.sh`. If you change a line of output, change `docs/ENGINE.md` too.
- **Anything that handles a broken file** goes through `engine/tests/fuzz.py`, with several `--seed` values. It must never crash. The build has no runtime checks, and Apple's frameworks can throw exceptions Swift can't catch, so check values before you hand them over. `engine/tests/rtmd_clip.py` builds a Sony-style data track, friendly or hostile, with no Sony file.
- **Decoder changes:** the engine has to stay usable on a Mac with no decoder for a format. `ENGINE_TEST_DECODER` and `ENGINE_TEST_NO_FFMPEG` force that path, and the contract test shows how.
- **Anything that holds a result per clip** must stay flat at 50,000 clips. `engine/tests/scale.sh` runs that many from generated clips in a few minutes, with a stand-in for Vision, and reports peak memory.
- **Anything that calls Apple's frameworks** must be able to hang without stopping the scan. The contract test forces a hang at each stage with `ENGINE_TEST_HANG`.
- **Panel changes:** run `node --test test/unit.test.js` in `panel/`.

To try the panel in Premiere, `scripts/dev-install.sh` copies an unsigned build to your own extensions folder. It needs Adobe's debug mode, which lets every unsigned extension load, so turn it off afterwards.

## Style

- No third-party dependencies. ffmpeg stays optional, and it's never bundled.
- Small and deliberate. Prefer deleting code to adding it.
- The engine never blocks Premiere. It runs out of process, and the panel never waits on it.
- Words shown to people are plain and calm, and they never claim more than was measured.
- The name, ids and version live in `product.conf`. Please don't add more copies.

## Reporting a bug

Use **Report a Bug** in the panel's `···` menu. Please say which Mac, which macOS and which Premiere, and which camera and recording format. Leave out file names, paths and client names.
