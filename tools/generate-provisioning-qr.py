#!/usr/bin/env python3
"""
SENTROID — Android Device Owner QR provisioning generator.

Produces the QR code that a factory-fresh phone scans (tap the setup "Welcome"
screen 6 times to open the scanner) to automatically download the SENTROID agent,
set it as Device Owner, and auto-enroll against your server — no cable, no typing.

Usage:
  python3 tools/generate-provisioning-qr.py \
      --apk android-agent/app/build/outputs/apk/debug/app-debug.apk \
      --download-url https://your-host.example.com/sentroid/app-debug.apk \
      --server https://mdm.example.com:4000 \
      --token ENR-xxxxxxxxxxxx \
      [--wifi-ssid MyWifi --wifi-pass secret --wifi-security WPA] \
      --out sentroid-provisioning-qr.png

Notes:
  * The phone must be able to download the APK from --download-url, so host the
    APK somewhere reachable (HTTPS strongly recommended).
  * The signature checksum is computed from the APK's signing certificate, so you
    can re-host an updated APK signed with the same key WITHOUT regenerating QRs.
  * Create the enrollment --token in the dashboard (Enrollment page) or via the API.
"""
import argparse, base64, json, re, shutil, subprocess, sys, hashlib

DPC_COMPONENT = "com.sentroid.agent/com.sentroid.agent.admin.SentroidDeviceAdminReceiver"


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def signature_checksum(apk_path):
    """URL-safe base64 (no padding) of the SHA-256 of the APK's signing cert."""
    # Prefer apksigner (authoritative), fall back to keytool.
    apksigner = shutil.which("apksigner")
    if not apksigner:
        import glob
        hits = sorted(glob.glob("/home/*/Android/Sdk/build-tools/*/apksigner")) + \
               sorted(glob.glob(f"{sys.prefix}/**/apksigner", recursive=True))
        apksigner = hits[-1] if hits else None
    hex_digest = None
    if apksigner:
        r = sh([apksigner, "verify", "--print-certs", apk_path])
        m = re.search(r"certificate SHA-256 digest:\s*([0-9a-fA-F]{64})", r.stdout)
        if m:
            hex_digest = m.group(1)
    if not hex_digest:
        keytool = shutil.which("keytool") or "/home/abubakar/.jdks/temurin-21/bin/keytool"
        r = sh([keytool, "-printcert", "-jarfile", apk_path])
        m = re.search(r"SHA256:\s*([0-9A-Fa-f:]+)", r.stdout)
        if m:
            hex_digest = m.group(1).replace(":", "")
    if not hex_digest:
        sys.exit("ERROR: could not read the APK signing certificate (need apksigner or keytool).")
    raw = bytes.fromhex(hex_digest)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def package_checksum(apk_path):
    """URL-safe base64 (no padding) of the SHA-256 of the whole APK file."""
    h = hashlib.sha256()
    with open(apk_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return base64.urlsafe_b64encode(h.digest()).decode().rstrip("=")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", required=True, help="path to the signed agent APK")
    ap.add_argument("--download-url", required=True, help="URL the phone downloads the APK from")
    ap.add_argument("--server", required=True, help="SENTROID server base URL for the agent")
    ap.add_argument("--token", required=True, help="enrollment token (from the dashboard)")
    ap.add_argument("--wifi-ssid")
    ap.add_argument("--wifi-pass")
    ap.add_argument("--wifi-security", default="WPA", choices=["WPA", "WEP", "NONE"])
    ap.add_argument("--out", default="sentroid-provisioning-qr.png")
    args = ap.parse_args()

    sig = signature_checksum(args.apk)

    payload = {
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": DPC_COMPONENT,
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": sig,
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": args.download_url,
        "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": True,
        "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": False,
        # Custom values handed to the agent's onProfileProvisioningComplete():
        "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
            "server_url": args.server,
            "enrollment_token": args.token,
        },
    }
    if args.wifi_ssid:
        payload["android.app.extra.PROVISIONING_WIFI_SSID"] = args.wifi_ssid
        payload["android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE"] = args.wifi_security
        if args.wifi_pass:
            payload["android.app.extra.PROVISIONING_WIFI_PASSWORD"] = args.wifi_pass

    data = json.dumps(payload, separators=(",", ":"))

    import qrcode
    from qrcode.constants import ERROR_CORRECT_M
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=8, border=4)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(args.out)

    print("=== SENTROID provisioning QR generated ===")
    print(f"  APK signature checksum : {sig}")
    print(f"  Download URL           : {args.download_url}")
    print(f"  Server                 : {args.server}")
    print(f"  Token                  : {args.token}")
    print(f"  QR image               : {args.out}")
    print(f"  QR version/modules     : {qr.version} ({qr.version*4+17} modules)")
    print("\n--- provisioning JSON (embedded in the QR) ---")
    print(json.dumps(payload, indent=2))
    print("\nHow to use on a factory-fresh phone:")
    print("  1) Power on; on the very first 'Welcome/Hi there' screen, tap 6 times.")
    print("  2) The QR scanner opens — scan this image.")
    print("  3) The phone downloads SENTROID, becomes Device Owner, and auto-enrolls.")


if __name__ == "__main__":
    main()
