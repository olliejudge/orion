# Releasing

Push a `vX.Y.Z` tag. The [release workflow](../.github/workflows/release.yml) runs GoReleaser on a macOS runner. It builds the darwin and linux binaries, signs and notarizes the darwin ones (when the Apple secrets are set), publishes the GitHub release and updates the cask in [olliejudge/homebrew-tap](https://github.com/olliejudge/homebrew-tap).

Signing and notarization are optional. GoReleaser does them only when the `MACOS_SIGN_P12` secret is set. Without the Apple secrets, the release still goes out, with unsigned macOS binaries. The five `MACOS_*` secrets are all or nothing: for a stable tag, the workflow fails before publishing if only some of them are set, so a half-finished setup can't ship binaries that are signed but not notarized. The cask clears the quarantine bit after install either way, so `brew install` works in both cases.

The steps below are a one-time setup. Everything happens on a Mac signed in to the Apple Developer account, with the [GitHub CLI](https://cli.github.com/) logged in to an account that can admin `olliejudge/orion`.

## 1. Homebrew tap token

1. Create the public repo `olliejudge/homebrew-tap` if it doesn't exist yet.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to that repo only, with **Contents: Read and write**.
3. Store it on this repo (`gh` prompts for the value):

   ```sh
   gh secret set HOMEBREW_TAP_GITHUB_TOKEN -R olliejudge/orion
   ```

Without this secret the workflow fails a stable tag before it publishes anything. Prerelease tags such as `v1.2.3-rc.1` don't update the tap, so they don't need it.

## 2. Developer ID Application certificate

The certificate signs the binaries. It must be a **Developer ID Application** certificate. Apple Development, Apple Distribution and Mac App Distribution certificates won't pass notarization. Creating one needs the Account Holder role.

Create it one of two ways.

**With Xcode:** Xcode → Settings → Accounts → select your Apple ID and team → **Manage Certificates…** → **+** → **Developer ID Application**. Xcode puts the certificate and its private key in your login keychain. If the certificate is listed as cloud-managed or "Not in Keychain", its private key can't be exported, so use the website route instead.

**On developer.apple.com:**

1. Make a certificate signing request. In Keychain Access, choose Keychain Access → Certificate Assistant → **Request a Certificate From a Certificate Authority…**. Enter your email and name, leave CA Email empty, choose **Saved to disk**, and save the `.certSigningRequest` file. Keychain Access creates the private key in your login keychain at the same time.
2. Go to [Certificates, Identifiers & Profiles → Certificates](https://developer.apple.com/account/resources/certificates/list) → **+** → **Developer ID Application** → Continue. Keep the default profile type (G2 Sub-CA) and upload the CSR.
3. Download the `.cer` file and double-click it to add it to your login keychain, next to the private key.

Check that the identity is usable:

```sh
security find-identity -v -p codesigning
# 1) ABCDEF… "Developer ID Application: <Team Name> (TEAMID)"
```

Export it as a `.p12`:

1. In Keychain Access, open the **login** keychain → **My Certificates**.
2. Find `Developer ID Application: <Team Name> (TEAMID)`. Expand it and check that a private key is underneath. Without the key, the export is useless.
3. Right-click the certificate → **Export "Developer ID Application: …"…** → File Format **Personal Information Exchange (.p12)** → save as `cert.p12`.
4. Set a strong password when asked. This becomes `MACOS_SIGN_PASSWORD`.

## 3. App Store Connect API key

The API key lets GoReleaser submit the binaries to Apple's notary service.

1. Go to [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api) → **Team Keys**. The first time, the account holder has to click **Request Access** and accept the terms.
2. Click **Generate API Key** (or **+**). Name it, for example `orion-notary`, set Access to **Developer**, and click **Generate**.
3. Note the **Issuer ID**, shown above the keys table, and the key's **Key ID**, shown in its row.
4. Click **Download** to get `AuthKey_<KEY_ID>.p8`. **Apple lets you download it only once.** Keep a copy in your password manager. If you lose it, revoke the key and generate a new one.

## 4. GitHub secrets

Run these in the directory holding `cert.p12` and the `.p8`. `gh secret set` reads the value from stdin when piped, and prompts for it otherwise.

```sh
# The certificate, base64-encoded. macOS's base64 prints a single line, which
# is what GoReleaser expects. On Linux, use `base64 -w0 cert.p12` instead.
base64 -i cert.p12 | gh secret set MACOS_SIGN_P12 -R olliejudge/orion

# The .p12 export password (prompted).
gh secret set MACOS_SIGN_PASSWORD -R olliejudge/orion

# The API key, base64-encoded.
base64 -i AuthKey_XXXXXXXXXX.p8 | gh secret set MACOS_NOTARY_KEY -R olliejudge/orion

# The Key ID (for example XXXXXXXXXX) and the Issuer ID (a UUID) from step 3.
gh secret set MACOS_NOTARY_KEY_ID -R olliejudge/orion
gh secret set MACOS_NOTARY_ISSUER_ID -R olliejudge/orion

# Check that all six secrets are there.
gh secret list -R olliejudge/orion
```

Then delete `cert.p12` and the `.p8` from disk, keeping the copies in your password manager.

Only the GoReleaser step of the release workflow gets these secrets. The `notarize.macos` section of [`.goreleaser.yaml`](../.goreleaser.yaml) uses them:

| Secret | What it is |
|---|---|
| `MACOS_SIGN_P12` | base64 of the Developer ID Application `.p12` |
| `MACOS_SIGN_PASSWORD` | the `.p12` export password |
| `MACOS_NOTARY_KEY` | base64 of `AuthKey_<KEY_ID>.p8` |
| `MACOS_NOTARY_KEY_ID` | the API key's Key ID |
| `MACOS_NOTARY_ISSUER_ID` | the team's Issuer ID |

Set all five or none. For a stable tag, the workflow's **Check release secrets** step fails before anything is published if only some are set, and lists the missing ones. With none set, it warns that the macOS binaries will be unsigned. Prerelease tags skip the check.

## What happens during a release

For each darwin binary, GoReleaser (using [quill](https://github.com/goreleaser/quill)) signs with the hardened runtime and an Apple timestamp. It then submits the binary to the notary service and waits up to 15 minutes for the result. These are the log lines to look for in the `goreleaser` step:

- `sign & notarize macOS binaries … reason=disabled`: `MACOS_SIGN_P12` isn't set, so nothing was signed.
- `will not try to notarize`: signed, but one of the three notary secrets is missing. Only a prerelease tag can get this far with a partial setup.
- `notarized`: done.
- `notarize timeout`: Apple hadn't finished within 15 minutes. The release carries on with the signed binary, and Apple usually finishes later. Check with `notarytool history` (below).
- `invalid` or `rejected`: the release fails. Fetch Apple's log with `notarytool log` (below).

Signed binaries carry a timestamp from Apple's server, so, unlike unsigned ones, their archives and `checksums.txt` differ between two builds of the same commit.

## Checking a release

Download a darwin tarball from the release through a browser, so that it gets quarantined the way a user's download would, then unpack it:

```sh
tar -xzf orion_X.Y.Z_darwin_arm64.tar.gz

# Signature: expect "Authority=Developer ID Application: …", then the Developer
# ID Certification Authority and Apple Root CA, a Timestamp= line, and
# flags=0x10000(runtime) for the hardened runtime.
codesign -dv --verbose=4 orion
codesign --verify --strict --verbose=2 orion

# Gatekeeper: expect "accepted" and "source=Notarized Developer ID".
spctl -a -vvv -t install orion

# It should now run with no Gatekeeper prompt, quarantined or not.
./orion --version
```

To look at the notary service directly (`xcrun notarytool` ships with Xcode or the Command Line Tools):

```sh
xcrun notarytool history --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-id>
xcrun notarytool log <submission-id> --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-id>
```

Stapling doesn't apply here. `xcrun stapler staple` only works on `.app`, `.pkg` and `.dmg` files, not on a bare binary. The notarization ticket stays on Apple's servers, and Gatekeeper fetches it online the first time a quarantined `orion` runs. The first run of a freshly downloaded binary therefore needs network access to pass Gatekeeper.

Once one notarized release has passed these checks, the quarantine-clearing `postflight_steps` in the cask (`custom_block` in `.goreleaser.yaml`) is no longer needed and can be removed. Likewise, the `xattr` note in the README then only applies to older releases.

## Renewals

- A Developer ID Application certificate is valid for 5 years. Binaries signed with it, with a timestamp, stay valid after it expires. Before it expires, create a new one, export it and replace `MACOS_SIGN_P12` and `MACOS_SIGN_PASSWORD`.
- App Store Connect API keys don't expire. Revoke the key in App Store Connect if it leaks, then generate a new one and replace the three `MACOS_NOTARY_*` secrets.
