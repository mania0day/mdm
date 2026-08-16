#!/usr/bin/env python3
"""Generate a Device Owner provisioning QR for the SENTROID agent.

Emits, next to this script's output dir:
  do-provisioning.json  - the exact QR payload (for inspection / re-encoding)
  do-provisioning.svg   - a scannable QR (inline-SVG, no external deps)

Run via make-do-qr.sh, which fills in the current server IP, a fresh
enrollment token, and the APK signing checksum. All values can also be passed
as env vars so it can be re-run whenever the hotspot IP or token changes:
  SERVER_URL, ENROLL_TOKEN, DOWNLOAD_URL, SIGNATURE_CHECKSUM, WIFI_SSID,
  WIFI_PASSWORD, WIFI_SECURITY, OUT_DIR
"""
import base64
import json
import os
import sys

COMPONENT = "com.sentroid.agent/com.sentroid.agent.admin.SentroidDeviceAdminReceiver"


def main():
    server_url = os.environ.get("SERVER_URL", "http://192.168.1.11:4000").rstrip("/")
    token = os.environ.get("ENROLL_TOKEN", "")
    download_url = os.environ.get("DOWNLOAD_URL", server_url + "/sentroid-agent.apk")
    checksum = os.environ.get("SIGNATURE_CHECKSUM", "")
    out_dir = os.environ.get("OUT_DIR", os.path.dirname(os.path.abspath(__file__)))

    if not checksum:
        sys.exit("SIGNATURE_CHECKSUM is required")

    payload = {
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": COMPONENT,
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": checksum,
        "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": download_url,
        "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": {
            # Read by SentroidDeviceAdminReceiver.onProfileProvisioningComplete
            "server_url": server_url,
            "enrollment_token": token,
        },
        # Leave the just-provisioned device connected and skip the encryption
        # step (it is already encrypted on modern devices).
        "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": True,
        "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": True,
    }

    # Optional Wi-Fi so the fresh device auto-joins a network that can reach the
    # server to download the APK. Omitted by default — the setup wizard prompts
    # for Wi-Fi before the QR download anyway.
    ssid = os.environ.get("WIFI_SSID")
    if ssid:
        payload["android.app.extra.PROVISIONING_WIFI_SSID"] = ssid
        pw = os.environ.get("WIFI_PASSWORD")
        if pw:
            payload["android.app.extra.PROVISIONING_WIFI_PASSWORD"] = pw
        payload["android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE"] = os.environ.get(
            "WIFI_SECURITY", "WPA"
        )

    data = json.dumps(payload)

    json_path = os.path.join(out_dir, "do-provisioning.json")
    with open(json_path, "w") as f:
        json.dump(payload, f, indent=2)

    import qrcode
    import qrcode.image.svg

    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    svg_path = os.path.join(out_dir, "do-provisioning.svg")
    img.save(svg_path)

    print("checksum      :", checksum)
    print("server_url    :", server_url)
    print("download_url  :", download_url)
    print("enroll_token  :", token or "(none — set ENROLL_TOKEN)")
    print("qr version    :", qr.version, "modules:", qr.modules_count)
    print("json          :", json_path)
    print("svg           :", svg_path)
    print("payload_bytes :", len(data))


if __name__ == "__main__":
    main()
