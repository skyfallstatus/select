# Packaging

How Select gets onto a Mac, and why. Claims are labelled as in [CONTRIBUTING.md](../CONTRIBUTING.md). Researched in November 2026.

## The answer

A `.pkg` installer, built with Apple's tools, that puts a ZXP-signed extension folder into `/Library/Application Support/Adobe/CEP/extensions/`. The certificate is self-signed and the signature is timestamped. The package isn't signed by Apple, so a tester approves it once in System Settings, the same way as Ingest.

The sources agreed with that plan. They added four things worth knowing: UXP needs a Developer ID, Adobe's signing tool is Intel only, Apple is ending general Rosetta after macOS 27, and CEP has an end date.

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
| `.pkg` into the system folder | No | Admin password, one approval in System Settings | **Chosen** |
| ZXP through `UnifiedPluginInstallerAgent` | Yes | Creative Cloud's agent | Not for testers |
| ZXP through a third-party installer | No | Installing someone else's app first | Possible fallback |
| Adobe Marketplace | No | Adobe's review | Not for a beta |
| Copying to the per-user folder | Yes | Debug mode | Developers only, `scripts/dev-install.sh` |

- `[ADOBE]` The Cookbook names the system folder and the per-user folder. If both hold the same bundle id, the higher version loads, then the newest manifest.
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
- `[TESTED]` The payload is the extension folder itself, installed at its full path, so the package never touches the permissions of the folders above. It has no scripts. Everything is owned by root, the engine is `-rwxr-xr-x`, and `scripts/check-pkg.sh` checks all of this by expanding the package, without installing it.
- `hostArchitectures="arm64,x86_64"` stops Apple silicon asking for Rosetta. `[SECONDARY]` That's common practice. Apple's [archived reference](https://developer.apple.com/library/archive/documentation/DeveloperTools/Reference/DistributionDefinitionRef/Chapters/Distribution_XML_Ref.html) predates Apple silicon and doesn't list `arm64`.
- `[UNKNOWN]` Whether installing a newer version removes a file the new version no longer has. A leftover file could matter to the signature check, so try it when 0.2.0 drops or renames something.

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
