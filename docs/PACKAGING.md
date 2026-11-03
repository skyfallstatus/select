# Packaging

How Select gets onto a Mac, and why. Claims are labelled as in [CONTRIBUTING.md](../CONTRIBUTING.md). Researched in November 2026.

## The answer

A `.pkg` installer, built with Apple's tools, that puts a ZXP-signed extension folder into the user's own `~/Library/Application Support/Adobe/CEP/extensions/`, with no administrator password. The certificate is self-signed and the signature is timestamped. The package isn't signed by Apple, so a tester approves it once in System Settings, the same way as Ingest. From then on the panel updates itself from GitHub Releases: see [Updates](#updates).

The sources agreed with that plan. They added four things worth knowing: UXP needs a Developer ID, Adobe's signing tool is Intel only, Apple is ending general Rosetta after macOS 27, and CEP has an end date.

Select 0.1 installed for all users, into `/Library/Application Support/Adobe/CEP/extensions/`. From 0.2 it installs for the user, so that it can replace its own folder without asking for a password.

## Does an unsigned panel load?

- `[ADOBE]` No. With debug mode off, no signature or an invalid one means "Extension does not run", and "CEP checks for a valid certificate each time a host application tries to run an extension." From the [signing guide](https://github.com/Adobe-CEP/Getting-Started-guides/tree/master/Package%20Distribute%20Install).
- `[ADOBE]` Debug mode is the `PlayerDebugMode` preference, which "bypass[es] the need to sign". It's a per-Mac setting for development, from the [CEP 12 Cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md). Testers shouldn't have to touch it.

## What does a self-signed ZXP give us?

- `[ADOBE]` The guide offers self-signing as a way to sign a package, alongside a paid certificate, and `ZXPSignCmd -selfSignedCert` makes one. Its example output shows `OS Trusted: false` for such a certificate.
- `[ADOBE]` The rule is about validity, not who issued it: "Signature valid: Extension runs normally."
- `[ADOBE]` A timestamp is what makes it last. A certificate that has expired with no timestamp means "Extension does not run". Expired with a valid timestamp means "Extension runs normally."
- `[UNKNOWN]` A self-signed build hasn't been loaded in Premiere 26.5 with debug mode off yet. That's the first thing to prove on the first signed build, and [RELEASING.md](RELEASING.md) says how.

## Ways to install

| Route | Terminal? | Needs | Verdict |
|---|---|---|---|
| `.pkg` into the per-user folder | No | One approval in System Settings | **Chosen** from 0.2 |
| `.pkg` into the system folder | No | Admin password, one approval in System Settings | 0.1 only. It can't update itself without a password |
| ZXP through `UnifiedPluginInstallerAgent` | Yes | Creative Cloud's agent | Not for testers |
| ZXP through a third-party installer | No | Installing someone else's app first | Possible fallback |
| Adobe Marketplace | No | Adobe's review | Not for a beta |
| Copying an unsigned build to the per-user folder | Yes | Debug mode | Developers only, `scripts/dev-install.sh` |

- `[ADOBE]` Which copy loads, from the [CEP 12 Cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md)'s Extension Folders, the same in 11.1: "CEP first searches the product extension folder, then the system extension folder, and finally per-user extension folder." "If two extensions have same extension bundle ID, the one with higher version is loaded." "If two extensions have same extension bundle ID and same version, the one whose manifest file has latest modification date is loaded."
- So with 0.1 left in `/Library` and 0.2 in `~/Library`, Premiere loads 0.2, and keeps loading the per-user copy as it updates. The 0.1 copy can stay, and the README says how to remove it. `[UNKNOWN]` Which of the two version attributes CEP compares isn't documented. The build stamps both from `product.conf`, so they never differ.
- `[SECONDARY]` A copy that wins on version but fails its signature check doesn't fall back to the other one: "the 'good' version kept getting blocked by the 'bad' version" ([forum, 2024](https://community.adobe.com/feature-requests-730/possible-to-improve-how-premiere-pro-or-cep-in-general-loads-extensions-1327987)). A broken per-user copy would hide Select even with 0.1 in `/Library`. That's why an update is checked in full before it goes in.
- `[ADOBE]` Adobe has a [known issue](https://github.com/Adobe-CEP/CEP-Resources/blob/master/ZXPSignCMD/KnownIssue2024.md) where a ZXP installed through UPIA, or a tool built on it, shows a blank panel: symbolic links unpack as text files and the signature fails. It says tools such as ZXPInstaller use UPIA, so they inherit it. Its advice for developers is to have no symlinks, sign on the platform the panel runs on, and delete `.DS_Store`. The build refuses symlinks and copies only named folders.
- `[TESTED]` A `.pkg` depends on none of that, and carries the signed folder byte for byte. It also doesn't depend on Creative Cloud's agent.
- `[UNKNOWN]` Whether a ZXP keeps the engine's execute bit through a real install. `scripts/sign-zxp.sh` checks this on the unpacked folder and sets it there. Modes aren't part of what's signed, as far as we can tell, and it re-verifies to prove it.

A `.zxp` goes on each release too, for anyone who prefers their own installer.

## Gatekeeper and the engine

`select-engine` is a command line program inside the extension. It has an ad hoc signature, which Apple silicon requires of all code and which needs no certificate. It has no Developer ID and isn't notarized.

- `[APPLE]` Safari and other apps mark downloads with quarantine. Finder's Archive Utility passes it on to what it unpacks. `curl`, `scp`, `tar` and `unzip` don't. "Running a quarantined app always invokes Gatekeeper." From Apple's [Resolving Trusted Execution Problems](https://developer.apple.com/forums/thread/706442).
- `[APPLE]` "If you use an installer package to install the tool, it's no longer quarantined and thus avoids this check." From an Apple engineer in [this thread](https://developer.apple.com/forums/thread/689337).
- `[APPLE]` Since macOS 15, Control-click no longer overrides Gatekeeper. People go to System Settings › Privacy & Security instead: [Apple's notice](https://developer.apple.com/news/?id=saqachfa). The [support page](https://support.apple.com/en-us/102445) describes **Open Anyway** "to open or install the app".

| Route | What Gatekeeper sees | What the tester does |
|---|---|---|
| `.pkg` from a browser | The package, once | Open Anyway, then the installer. The engine isn't quarantined afterwards |
| ZXP through an installer | `[UNKNOWN]` whether quarantine reaches the engine | Possibly a block when Scan runs |
| Folder unzipped in Finder | The engine is quarantined | A block when Scan runs |

We don't strip quarantine behind anyone's back. No script, step or panel code removes it. The tester approves the package, which is the point of the prompt.

- `[TESTED]` `spctl --assess --type install` rejects the unsigned package here with "no usable signature", as expected. That's the approval a tester gives by hand.
- `[UNKNOWN]` **Open Anyway** on this package hasn't been clicked on a real Mac. Apple's page covers installing, and Ingest's steps are for an app. The first signed build has to prove it, downloaded in a browser so that it really is quarantined.

A Developer ID would remove all of this. With one, `INSTALLER_IDENTITY` signs the package in `scripts/build-pkg.sh`, and the engine should get a real signature too.

## How the package is built

- `[TESTED]` `pkgbuild` isn't used. On macOS 27 it wrote an empty `._` file beside every file in the payload, even with `COPYFILE_DISABLE` set, because macOS adds an extended attribute to everything a tool writes. Those would land inside the signed extension. `scripts/build-pkg.sh` builds the same component by hand from `cpio`, `mkbom` and `pkgutil --flatten`, then `productbuild` wraps it.
- `[TESTED]` The payload is the extension folder itself, installed at its full path, so the package never touches the permissions of the folders above. It has no scripts. The bill of materials says root for every file, the engine is `-rwxr-xr-x`, and `scripts/check-pkg.sh` checks all of this by expanding the package, without installing it.
- `[TESTED]` The Distribution enables only the home domain: `enable_currentUserHome="true"`, `enable_localSystem="false"`, `enable_anywhere="false"`, and the component says `auth="none"`. `scripts/check-pkg.sh` refuses anything else.
- `[APPLE]` From the [Distribution XML reference](https://developer.apple.com/library/archive/documentation/DeveloperTools/Reference/DistributionDefinitionRef/Chapters/Distribution_XML_Ref.html): "A home directory installation is done as the current user (not as `root`), and it cannot write outside of the home directory." On `auth`: "Deprecated. The installation domain determines the necessary authorization level." So no administrator password, and the files belong to the user, which the updater needs.
- `[SECONDARY]` The install location, `/Library/Application Support/Adobe/CEP/extensions/com.skyfallstatus.select`, lands under the home folder in a home install. Apple's reference doesn't say so; electron-builder's docs and older answers do.
- `[UNKNOWN]` A real install hasn't been run yet. Check that it asks for no administrator password, that the folder lands in `~/Library`, and that `ls -l` shows the user, not root, as the owner. If root owns it, the panel says it can't replace itself and points to the package, rather than failing half way.
- `hostArchitectures="arm64,x86_64"` stops Apple silicon asking for Rosetta. `[SECONDARY]` That's common practice. Apple's [archived reference](https://developer.apple.com/library/archive/documentation/DeveloperTools/Reference/DistributionDefinitionRef/Chapters/Distribution_XML_Ref.html) predates Apple silicon and doesn't list `arm64`.
- `[UNKNOWN]` Whether installing a newer version removes a file the new version no longer has. A leftover file could matter to the signature check: `[SECONDARY]` "any leftover file in the folders will break this even with valid signature" ([forum](https://community.adobe.com/t5/photoshop-ecosystem-discussions/extension-signing/m-p/7695615)). Updates from the panel don't have this problem, since they replace the whole folder. The package still might, so try it when a version drops or renames something.

## Updates

Like Ingest with Sparkle, Select updates itself, from GitHub Releases. The code is `panel/client/update.js`, and `panel/test/update.test.js` runs all of it against a local stand-in for GitHub.

### What it does

1. **Asks.** Once a day the panel asks `https://api.github.com/repos/skyfallstatus/select/releases/latest` for the latest release. It asks when it opens if no answer has come in the last day, and once a day while it stays open. The request carries `User-Agent: Select`, which GitHub requires, and an `Accept` header: no token, no cookie, no identifier. **Check Automatically** in the `···` menu turns this off, and **Check for Updates** asks now. The setting is in `~/Library/Application Support/com.skyfallstatus.select/updates/state.json`.
2. **Checks the manifest.** When the release's tag is newer than the running manifest's version, it fetches `Select-update.json` from that release. Its Ed25519 signature must verify against a key the panel carries. The signed part names the bundle id, version, file name, size and SHA-256 of `Select.zxp`, and each must match this panel and the release. A replayed manifest for an older version is refused. All of this happens before the `.zxp` is fetched.
3. **Downloads.** It fetches `Select.zxp`, stops the moment it's longer than the signed size, and checks the size and SHA-256.
4. **Stages.** It unpacks with `ditto` into `~/Library/Application Support/com.skyfallstatus.select/updates/work-…`, outside Adobe's folder. A second folder with the same bundle id inside `extensions` would compete with the real one, so nothing is ever staged there. Then it checks the folder: its manifest's bundle id and version, Adobe's `META-INF/signatures.xml`, the page and host script, no links, no quarantine on the engine, and `select-engine version` printing the new version.
5. **Swaps.** It waits until no scan, write or dialog is running, read from `window.SelectApp.state` (`scan.handle`, `listing`, `busy`, `modalOpen`). Then it moves the current folder to `updates/previous/` and the new one into its place: two renames on one volume, synchronous, so nothing in the panel can start in between. If the second rename fails, or the result doesn't read back as the new version, the old folder goes back.
6. **Says so once.** A quiet line at the bottom of the panel reads "Select 0.2 is ready", with **Restart**. If it's ignored, Premiere loads the new folder the next time it opens.

The only requests are these GETs, and only over https to `api.github.com`, `github.com` and GitHub's asset hosts (`release-assets`, `objects` and `github-releases` under `githubusercontent.com`), on the default port. Every redirect is checked against that list. A development copy is never replaced: an unsigned folder, or a link. Nor is a copy the user can't write to: the line asks for the package instead.

### Restart without quitting Premiere

- `[ADOBE]` The host script runs "in host application's ExtendScript engine, which runs in host application's main thread", shared by every panel in Premiere ([Cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md)).
- `[SECONDARY]` Whether CEP evaluates `ScriptPath` again when the page reloads isn't documented, and forum answers differ. Adobe's PProPanel sample evaluates its host files itself on every load. So Select doesn't rely on it. When the page loads, `update.js` asks the host for `SELECT_HOST_VERSION`, and if it's another version it evaluates the new `host/select.jsx` with `$.evalFile`. `[TESTED]` against a stand-in for ExtendScript only.
- `[SECONDARY]` Manifest changes apply only when the host app restarts ([InDesign forum](https://community.adobe.com/t5/exchange-discussions/clear-cep-extension-cache-in-indesign/m-p/10297331)). So when the new manifest differs in anything but its versions, such as a CEF flag, the script path, the size or the host range, the line says "Restart Premiere to use it" and offers no button. The same goes when the running copy is somewhere else, such as 0.1 in `/Library`.
- After the swap, the page that's running is older than the files on disk, and a scan would start the new engine. So a **Scan** pressed then restarts the panel and scans in the new version. If Premiere needs a restart, the line says so instead of scanning.
- `[UNKNOWN]` Whether the reload really brings the new page and host up in Premiere, and whether CEP checks the signature again on a reload. RELEASING.md has the test.

### Keys and trust

- The private key is `~/.config/skyfallstatus/signing/select-update-ed25519.pem`, mode 600, outside the repository, with no password. `scripts/sign-update.js` refuses it if anyone else can read it or if it's inside the repository. The public key is in `KEYS` in `update.js`, named by the first 16 hex digits of its SHA-256.
- Losing the private key means installed copies can't update any more: the next version would go out as a package with a new key, installed by hand. To change keys on purpose, ship a release that trusts both, signed with the old one, then sign with the new one.
- `[ADOBE]` CEP 11.1 ships Node 15.9.0, and CEP 12 ships 17.7.1 (the Cookbooks' tables). `[SECONDARY]` Node's docs give `crypto.verify` with Ed25519 from version 12. `[UNKNOWN]` Adobe builds its own Node, so `update.js` first proves Ed25519 works on RFC 8032's first test vector. If it doesn't, the line asks for the package instead of calling a good signature bad.
- `[APPLE]` Quarantine: see [Gatekeeper and the engine](#gatekeeper-and-the-engine). Nothing here removes it. If the downloaded engine is quarantined, the update stops before running it, and the line asks for the package. `[UNKNOWN]` Whether Premiere marks the files its panels write. The test in RELEASING.md looks with `xattr`.

### GitHub

- `[SECONDARY]` GitHub's REST docs: "The primary rate limit for unauthenticated requests is 60 requests per hour", per IP address, and "Requests with no `User-Agent` header will be rejected" ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [getting started](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)). One request a day is far below the limit.
- `[TESTED]` On 3 Nov 2026 a release download on github.com redirected to `release-assets.githubusercontent.com`. `api.github.com/meta` also lists `objects.githubusercontent.com`, the older host. Both are allowed.
- `scripts/release.sh` uploads a draft and publishes it after its three files are in, so `releases/latest` never shows a release without its manifest. A release that has no manifest makes the panel ask for the package.

### Rolling back by hand

Quit Premiere. Move `~/Library/Application Support/Adobe/CEP/extensions/com.skyfallstatus.select` somewhere else, then move `~/Library/Application Support/com.skyfallstatus.select/updates/previous/com.skyfallstatus.select` into `extensions`. Turn off **Check Automatically**, or the next check installs the newer version again. For everyone, the fix is a new release with a higher version, since installed copies only move forward.

## Which Premiere

The manifest says `PPRO [23.0,99.9]` with `CSXS 11.0`. **Only Premiere 26.5 has been run.**

- `[ADOBE]` The Cookbook's table lists CEP 11 from Premiere 15.4 and CEP 12 from Premiere 25.0, so `CSXS 11.0` is right for a floor of 23.0. It doesn't list 23 and 24 by name, so that step is an inference.
- `[ADOBE]` `ExtensionManifest Version` is the schema, not the CEP version. Adobe's guide uses `7.0` and the Cookbook says no elements have changed since CEP 7. It was `12.0` before, which a CEP 11 Premiere might not accept, so it's now `7.0`. `[UNKNOWN]` Premiere 26.5 hasn't run with this value yet.
- `[TESTED]` A search of the panel found no JavaScript or CSS newer than Chromium 88, which is what CEP 11 uses.

So the honest claim is: Premiere 23 or later is what the manifest allows and nothing rules it out, and 26.5 is what's been tested.

## Which macOS

The engine is built for macOS 13. `[ADOBE]` Premiere 24 asks for macOS 12, 25 for macOS 13 and 26 for macOS 14: [24.x](https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/adobe-premiere-24x-technical-requirements.html), [25.x](https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/adobe-premiere-25x-technical-requirements.html), [26.x](https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/adobe-premiere-pro-technical-requirements.html). Adobe's page for 23.x is gone, and Premiere 26.5 is the first it confirms for [macOS 27](https://helpx.adobe.com/download-install/apps/system-requirements/apps-compatible-macos.html). So macOS 13 covers every supported Premiere, and leaves out only Premiere 23 and 24 on macOS 12.

`[TESTED]` The compiler checks each API against that target, and `vtool` shows `minos 13.0` on both slices. `otool -L` shows it links only libraries that ship with macOS. It has only been run on macOS 27.

## CEP's future

- `[ADOBE]` For Premiere: UXP is generally available, new CEP submissions to the Marketplace end in December 2027, CEP is disabled by default from December 2028, and "Starting December 2029, CEP will no longer be included in these apps." From the [developer blog](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications) and [help page](https://helpx.adobe.com/creative-cloud/apps/integration-with-other-apps/manage-plugins/cep-uxp-plugin-transition.html).
- `[ADOBE]` The page says plugins outside the Marketplace aren't affected by the submission cutoff, but it doesn't say how "disabled by default" will treat them.
- `[ADOBE]` UXP can't run the engine as it stands. `shell.openPath()` can't pass arguments or capture output: [Launch External Processes](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/external-process/).
- `[ADOBE]` The way forward is a Hybrid plugin, in [Premiere 26.2 or later](https://blog.developer.adobe.com/en/publish/2026/04/uxp-hybrid-plugins-now-available-for-premiere), which loads a C++ library. It must be signed and notarized with a Developer ID, "Self-signed or test certificates are not accepted", and it prompts for an admin password: [Package a UXP plugin](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package/).

So a later version means a UXP panel, the engine as a library inside a Hybrid addon, a paid Apple Developer account, and rebuilding the panel. There's time, but not unlimited time.

## Signing needs Rosetta, and Rosetta is ending

- `[TESTED]` Adobe's `ZXPSignCmd` 4.1.3 for macOS is an Intel program with no Apple silicon slice, and it isn't signed.
- `[APPLE]` macOS 27 is the last general release of Rosetta. From macOS 28 Intel-only apps stop running on Apple silicon: [Apple's notice](https://developer.apple.com/news/?id=w5ngl9k2), [support page](https://support.apple.com/en-us/102527).

So signing has to stay on macOS 27 or earlier, or move to an Intel Mac, unless Adobe ships a new tool. It's worth keeping one Mac for this before updating. Adobe's current advice is to sign on the platform the panel runs on, which argues against using Windows for a macOS build.
