# Releasing

Everything here is run by hand. Nothing publishes on its own. [PACKAGING.md](PACKAGING.md) says why it works this way.

## Once: set up signing

The certificate is yours to make. It never goes in the login keychain or in this repository. The scripts read it from a file and take its password from the environment.

1. **Install Rosetta.** Adobe's tool is an Intel program.

   ```sh
   softwareupdate --install-rosetta
   ```

   Apple is ending general Rosetta after macOS 27, so read the last section of [PACKAGING.md](PACKAGING.md) before you update the Mac you sign on.

2. **Get ZXPSignCmd** from [Adobe's CEP Resources](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD), the newest macOS folder, 4.1.3 at the time of writing. Keep it outside this repository, make it executable with `chmod +x`, and run it once. macOS blocks it the first time: allow it in **System Settings › Privacy & Security**.

3. **Make the certificate.** Keep the password in your password manager. The file below goes somewhere backed up and private, outside this repository.

   ```sh
   read -rs "ZXP_PASSWORD?Certificate password: "; export ZXP_PASSWORD
   /path/to/ZXPSignCmd -selfSignedCert <country code> <state> skyfallstatus Select "$ZXP_PASSWORD" /path/to/select-signing.p12 -validityDays 3650
   ```

   The country code is two letters. The state is your region, in quotes if it has spaces.

## Once: the update key

Installed copies of Select take an update only when its manifest is signed with the Ed25519 key they carry. [PACKAGING.md](PACKAGING.md#updates) says how updates work.

The key pair was made on 3 Nov 2026. The private half is `~/.config/skyfallstatus/signing/select-update-ed25519.pem`, mode 600, with no password, so `scripts/release.sh` can sign with no prompt. The public half is in `KEYS` in `panel/client/update.js`, id `477ec9c948d3721b`.

- **Back it up**, privately, for example in your password manager. Without it, installed copies can't update any more, and everyone has to install a new package by hand.
- **Never put it in the repository.** The script refuses a key inside it, and one that others on the Mac can read.
- To check it: `node scripts/sign-update.js check-key`. On a new Mac, put the backup at the same path and run `chmod 600` on it.
- Only if it's lost for good: `node scripts/sign-update.js keygen` makes a new one and prints the line for `KEYS`. It refuses to replace a key that exists.

## Once: the private patterns file

`scripts/privacy-scan.sh` reads `.local/private-patterns.txt`, one regular expression per line, in Python syntax. A line starting `(?i)` ignores case, and lines starting `#` are skipped. The file is git-ignored, so it never enters the repository. Keep it up to date when there's a new client. The scan fails loudly if the file is missing.

## Once: the GitHub repository

Check before the first push, because history is forever:

```sh
scripts/privacy-scan.sh
```

Then create the repository, and push. The Mac's git name and email go into every commit and are public.

## Each release

1. Raise `VERSION` in `product.conf`, and commit.
2. Push the commit. A release is built from a commit GitHub already has.
3. Set the environment:

   ```sh
   export ZXP_CERT=/path/to/select-signing.p12
   read -rs "ZXP_PASSWORD?Certificate password: "; export ZXP_PASSWORD
   export ZXPSIGNCMD=/path/to/ZXPSignCmd
   ```

   `ZXPSignCmd` takes the password on its command line, so it's visible to other processes on the Mac while it runs. `ZXP_TSA` picks another timestamp server if the default, Apple's, fails. `http://timestamp.identrust.com` also works. DigiCert, Sectigo, GlobalSign, SSL.com, Entrust and Microsoft were all refused by `ZXPSignCmd` 4.1.3 on 3 Nov 2026: it couldn't verify their timestamps.

4. Rehearse:

   ```sh
   scripts/release.sh --dry-run
   ```

   That runs every test and the privacy scan, builds, signs, timestamps, packages and checks, signs `dist/Select-update.json`, writes the release notes to `dist/release-notes.md`, and uploads nothing. It stops at a changed tree, a missing signature, a missing update key or private words. The notes' install steps are README's **Steps** section, word for word, so change them there.

5. Install `dist/Select.pkg` on a test Mac and go through the checks below.
6. Release:

   ```sh
   scripts/release.sh
   ```

   This checks GitHub read-only, refuses a version that isn't higher than the last, builds again, and asks you to type `yes`. Then `gh release create` uploads `Select.pkg`, `Select.zxp` and `Select-update.json` as a draft. Once the draft's files match what was built, it publishes it. Within a day, every installed copy with automatic checks on picks it up.

Don't mark a release as a pre-release. The links in the README and BETA.md use `releases/latest`, which skips those, and so does the updater.

A bad release can't be taken back from Macs that already have it, since installed copies only move forward. Release a fixed, higher version instead. Deleting the bad release only stops new downloads.

## Checks on the first signed build

Do these before anyone else gets it. Debug mode lets unsigned panels load, so **a Mac with `PlayerDebugMode` on proves nothing**. Use another Mac, or another user account on this one where it was never set. If an old copy with another bundle id is installed, remove it first.

1. **The package opens.** Put `Select.pkg` somewhere private you can reach from a browser, such as a draft GitHub release, and download it in Safari so that macOS quarantines it. A copy made with `scp` or `curl` won't do. Double-click it, then follow the steps in the README word for word, and correct them if macOS says something else.
2. **The panel loads with debug mode off.** Open Premiere, then **Window › Extensions › Select**. This is the proof that a self-signed, timestamped signature is enough.
3. **The engine runs.** Press **Scan** on a few clips. A block from macOS here would mean the engine stayed quarantined.
4. **The Intel slice runs.** With Rosetta installed:

   ```sh
   arch -x86_64 engine/build/select-engine --version
   ```

   Then run the contract test under it: `arch -x86_64 zsh engine/tests/contract.sh`.

5. **The buttons work.** Label, Add Columns, Sort into Bins and Undo, on a copy of a project. The manifest's schema version changed for this build, so this is its first real run.

## Checks on the first update

0.2.0 is the first version that can update itself, so the update itself can only be proved with a second release, 0.2.1 or 0.3.0. Do this on the test Mac or account from the checks above, with debug mode off, before you tell anyone that updates work.

1. **Install 0.2.0 from the package.** It asks for no administrator password. Then `ls -l ~/Library/Application\ Support/Adobe/CEP/extensions/` shows `com.skyfallstatus.select` owned by you, not root. If 0.1 is still in `/Library`, leave it there: **About Select** must say 0.2.0, which proves the newer copy wins.
2. **Release the next version** as above.
3. **Check by hand.** Open the panel and choose **··· › Check for Updates**. Within a minute the line should read "Select 0.2.1 is ready" with **Restart**, without a scan running. Then:

   ```sh
   ls ~/Library/Application\ Support/Adobe/CEP/extensions/                        # one com.skyfallstatus.select, nothing beside it
   ls ~/Library/Application\ Support/com.skyfallstatus.select/updates/previous/   # the old version
   xattr -l ~/Library/Application\ Support/Adobe/CEP/extensions/com.skyfallstatus.select/bin/select-engine   # no com.apple.quarantine
   ```

4. **Restart.** Press **Restart**. The panel reloads with Premiere still open. **About Select** says the new version. Then press **Scan**, and run a Label and an Undo on a copy of a project. That proves the new host script is the one answering, and that the new engine runs. If the panel goes blank or a write fails, quit and reopen Premiere. If that fixes it, Restart isn't enough, and the line should say "Restart Premiere" instead: write it down in [PACKAGING.md](PACKAGING.md#restart-without-quitting-premiere).
5. **Quit and reopen Premiere.** The panel loads, so the swapped-in folder passes Adobe's signature check with debug mode off.
6. **A scan holds it back.** Turn back to the previous version by hand, as in PACKAGING.md's rollback steps. Start a long scan, then choose **Check for Updates**. The line says the update installs as soon as the scan ends, and the folder doesn't change until it does.
7. **Turning it off works.** Turn off **Check Automatically**, quit Premiere, and set `lastCheck` in `~/Library/Application Support/com.skyfallstatus.select/updates/state.json` to `0`. Open the panel and wait a minute. No request goes out: Little Snitch or `nettop -p` on the CEP process shows nothing.

## Renaming

The name, ids, repository and engine file name live in `product.conf`, and the scripts and engine read them from there. The rest needs changing by hand: `panel/CSXS/manifest.xml`, which is stamped for builds but should stay in step, the panel's own text and bug link, and these documents.
