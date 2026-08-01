# SENTROID — QR-Code Provisioning Guide (fleet onboarding)

QR provisioning lets IT onboard phones with **no cable and no typing**: factory-reset
the phone, tap the welcome screen 6 times, scan one QR code, and the phone
automatically downloads the SENTROID agent, becomes **Device Owner**, and
**auto-enrolls** against your server.

This is the recommended method for onboarding more than a handful of devices.
(For a few devices, the USB/ADB method in `REAL_DEVICE_TEST_CHECKLIST.md` is simpler.)

---

## One-time setup (IT admin, on a computer)

### 1. Build a signed release APK
The debug APK works for testing, but distribute a **release** build signed with a
key you keep. Sign with the same key every time so you never have to regenerate QRs
when you update the app (the QR pins the *signing certificate*, not the APK bytes).

### 2. Host the APK at a URL the phones can reach
Put the APK on any web server the target phones can download from — **HTTPS strongly
recommended** (e.g. `https://mdm.yourorg.com/agent/sentroid.apk`). The phone fetches
it during provisioning, before it has your app.

### 3. Create an enrollment token
In the dashboard → **Enrollment** → create a token (or via the API). One token can be
reused for a batch, or issue per-device tokens for tighter control.

### 4. Generate the QR
```bash
python3 tools/generate-provisioning-qr.py \
  --apk        path/to/sentroid-release.apk \
  --download-url https://mdm.yourorg.com/agent/sentroid.apk \
  --server     https://mdm.yourorg.com:4000 \
  --token      ENR-xxxxxxxxxxxx \
  --out        sentroid-qr.png
```
Optional — have the phone join Wi-Fi automatically during setup so it can download
the APK before any network is configured:
```bash
  --wifi-ssid "CorpWifi" --wifi-pass "secret" --wifi-security WPA
```
The script prints the exact provisioning JSON embedded in the QR and computes the
APK's signing-certificate checksum for you.

---

## Per-device onboarding (takes ~2 minutes, no cable)

1. **Factory reset** the phone (or use a new one). Do **not** add a Google account.
2. On the very first **"Hi there / Welcome"** setup screen, **tap the screen 6 times**.
3. The phone opens a **QR scanner** → scan `sentroid-qr.png` (on a monitor or printed).
4. It connects to Wi-Fi (if provided), **downloads and installs SENTROID**, sets it as
   **Device Owner**, and finishes setup.
5. SENTROID starts automatically and **auto-enrolls** using the token in the QR — the
   device appears **online / compliant** in your dashboard within a minute. No typing.

---

## How it works (for reference)
- The QR carries: the Device-Owner component, the APK download URL, the APK's signing
  checksum, and an *admin-extras bundle* with `server_url` + `enrollment_token`.
- After the OS makes SENTROID the Device Owner, it calls the agent's
  `onProfileProvisioningComplete()`, which reads those extras, then the background
  service auto-enrolls as soon as the network is up (retrying until it succeeds).
- Location permissions are auto-granted (Device Owner), so live tracking works
  immediately with no user prompts.

## Troubleshooting
- **"Can't set up device / checksum mismatch"** → the hosted APK doesn't match the QR.
  Re-run the generator against the exact APK you hosted (or keep the same signing key).
- **Download fails** → the phone can't reach `--download-url`. Verify it's reachable
  from the phone's network (add Wi-Fi args, or use a public HTTPS URL).
- **Device Owner step fails** → the phone already had an account. Factory reset and
  do NOT sign into any account before scanning.
