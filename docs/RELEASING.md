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

   That runs every test and the privacy scan, builds, signs, timestamps, packages and checks, and uploads nothing. It stops at a changed tree, a missing signature or private words.

5. Install `dist/Select.pkg` on a test Mac and go through the checks below.
6. Release:

   ```sh
   scripts/release.sh
   ```

   This checks GitHub read-only, refuses a version that isn't higher than the last, builds again, and asks you to type `yes` before `gh release create` uploads `Select.pkg` and `Select.zxp`.

Don't mark a release as a pre-release. The links in the README and BETA.md use `releases/latest`, which skips those.

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

## Renaming

The name, ids, repository and engine file name live in `product.conf`, and the scripts and engine read them from there. The rest needs changing by hand: `panel/CSXS/manifest.xml`, which is stamped for builds but should stay in step, the panel's own text and bug link, and these documents.
