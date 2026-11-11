#!/usr/bin/env bash
# Signs an unsigned APK of the Atlas Android app and checks the signature:
#
#   bash apps/desktop/scripts/sign-apk.sh <unsigned.apk> <signed.apk>
#
# The key: when ANDROID_KEY_BASE64 (a keystore file, base64), ANDROID_KEY_ALIAS
# and ANDROID_KEY_PASSWORD (the password of the keystore and of the key) are
# all set, that key ("release"). Otherwise a key made for this run only and
# thrown away afterwards ("throwaway"): an APK signed with it cannot install
# over one signed with another key, so the old app must be uninstalled first.
# No key is ever written outside a temporary folder.
#
# It aligns the APK (16 KB pages), signs it with apksigner, verifies the
# signature and that its certificate is the key's, and checks the alignment.
# It prints, and writes to $GITHUB_OUTPUT when that is set, `key=release` or
# `key=throwaway` and `certificate=<SHA-256 of the signing certificate>`.
#
# Needs keytool, openssl and the Android build tools: BUILD_TOOLS (a
# build-tools folder, ending in /), else the newest under $ANDROID_HOME.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: sign-apk.sh <unsigned.apk> <signed.apk>" >&2
  exit 2
fi
unsigned="$1"
signed="$2"
build_tools="${BUILD_TOOLS:-$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -n 1)}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
keystore="$work/key.keystore"

if [ -n "${ANDROID_KEY_BASE64:-}" ] && [ -n "${ANDROID_KEY_ALIAS:-}" ] && [ -n "${ANDROID_KEY_PASSWORD:-}" ]; then
  kind=release
  alias="$ANDROID_KEY_ALIAS"
  KEY_PASSWORD="$ANDROID_KEY_PASSWORD"
  printf '%s' "$ANDROID_KEY_BASE64" | base64 --decode > "$keystore"
else
  kind=throwaway
  alias=throwaway
  KEY_PASSWORD="$(openssl rand -hex 24)"
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$KEY_PASSWORD"; fi
  keytool -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias" \
    -keyalg RSA -keysize 3072 -validity 10000 \
    -storepass "$KEY_PASSWORD" -keypass "$KEY_PASSWORD" \
    -dname "CN=Atlas throwaway key" > /dev/null 2>&1
fi
export KEY_PASSWORD

"${build_tools}zipalign" -P 16 -f 4 "$unsigned" "$work/aligned.apk"
"${build_tools}apksigner" sign \
  --ks "$keystore" --ks-key-alias "$alias" \
  --ks-pass env:KEY_PASSWORD --key-pass env:KEY_PASSWORD \
  --out "$signed" "$work/aligned.apk"

"${build_tools}apksigner" verify --verbose --print-certs "$signed" | tee "$work/verify.txt"
certificate="$(keytool -list -v -keystore "$keystore" -storepass "$KEY_PASSWORD" -alias "$alias" 2> /dev/null \
  | sed -n 's/^[[:space:]]*SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f')"
if [ -z "$certificate" ] || ! grep -q "certificate SHA-256 digest: $certificate\$" "$work/verify.txt"; then
  echo "$signed is not signed with the certificate of the key ($kind)" >&2
  exit 1
fi
"${build_tools}zipalign" -c -P 16 4 "$signed"

echo "key=$kind"
echo "certificate=$certificate"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "key=$kind"
    echo "certificate=$certificate"
  } >> "$GITHUB_OUTPUT"
fi
