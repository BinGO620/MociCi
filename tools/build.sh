#!/usr/bin/env bash
# MociCi build pipeline: aapt2 -> javac -> d8 -> zip -> zipalign -> apksigner.
# Usage: tools/build.sh [--qa] [--no-archive]
# Version numbers come from version.json; artifacts land in dist/ and are
# archived with a SHA-256 manifest so every previous build stays retrievable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export JAVA_HOME="${JAVA_HOME:-D:/android-build/jdk/jdk-17.0.21.1+2}"
SDK="${ANDROID_SDK:-D:/android-build/sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
QA=0
ARCHIVE=1
for arg in "$@"; do
  case "$arg" in
    --qa) QA=1 ;;
    --no-archive) ARCHIVE=0 ;;
  esac
done

step() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'BUILD FAILED: %s\n' "$1" >&2; exit 1; }

step "environment"
[[ -x "$JAVA_HOME/bin/javac.exe" || -x "$JAVA_HOME/bin/javac" ]] || fail "javac not found under $JAVA_HOME"
[[ -f "$PLATFORM" ]] || fail "android.jar not found: $PLATFORM"
for t in aapt2 d8 apksigner zipalign; do
  ls "$BT/$t"* >/dev/null 2>&1 || fail "missing build tool: $t"
done
command -v zip >/dev/null || fail "zip is required"
[[ -f version.json ]] || fail "version.json missing"
echo "JAVA_HOME=$JAVA_HOME"
echo "SDK=$SDK"
[[ $QA == 1 ]] && echo "QA build: debuggable" || echo "Release build"

step "version"
VC="$(node -e "process.stdout.write(String(require('./version.json').versionCode))")"
VN="$(node -e "process.stdout.write(String(require('./version.json').versionName))")"
STAGE="$(node -e "process.stdout.write(String(require('./version.json').stage||'release'))")"
[[ -n "$VC" && -n "$VN" ]] || fail "version.json must define versionCode and versionName"
echo "versionCode=$VC versionName=$VN stage=$STAGE"

step "clean"
rm -rf build/compiled build/gen build/classes build/dex build/apk
mkdir -p build/compiled build/gen build/classes build/dex build/apk/assets
mkdir -p dist

step "icons"
node tools/gen-icons.js

step "aapt2 compile"
"$BT/aapt2.exe" compile --dir app/src/main/res -o build/compiled/res.zip

step "aapt2 link"
LINK_ARGS=(
  -o build/apk/base.apk
  -I "$PLATFORM"
  --manifest app/src/main/AndroidManifest.xml
  --java build/gen
  --version-code "$VC"
  --version-name "$VN"
  --replace-version
  --min-sdk-version 24
  --target-sdk-version 34
  --no-version-vectors
)
[[ $QA == 1 ]] && LINK_ARGS+=(--debug-mode)
"$BT/aapt2.exe" link "${LINK_ARGS[@]}" build/compiled/res.zip

step "javac"
find app/src/main/java build/gen -name '*.java' > build/javac.list
"$JAVA_HOME/bin/javac.exe" -encoding UTF-8 -source 17 -target 17 \
  -classpath "$PLATFORM" -d build/classes @build/javac.list

step "d8"
find build/classes -name '*.class' > build/d8.list
"$BT/d8.bat" --min-api 24 --lib "$PLATFORM" --output build/dex @build/d8.list

step "stage + zip"
# Copy the resource APK contents, then add dex and assets ourselves so every
# archive entry uses forward slashes (aapt on Windows writes assets/tts\a.mp3).
rm -rf build/apk/stage
mkdir -p build/apk/stage
(cd build/apk/stage && unzip -q -o ../base.apk)
cp build/dex/classes.dex build/apk/stage/classes.dex
cp -R app/src/main/assets/. build/apk/stage/assets/

# Remove straight from stage; re-create archive with resources.arsc stored and
# uncompressed (required by Android 11+ for targetSdk >= 30).
(cd build/apk/stage && zip -q -r -X ../app-unsigned.apk . -x 'resources.arsc')
(cd build/apk/stage && zip -q -X -0 ../app-unsigned.apk resources.arsc)

step "zipalign"
"$BT/zipalign.exe" -f -p 4 build/apk/app-unsigned.apk build/apk/app-aligned.apk

step "keystore"
# The signing key lives outside build/ on purpose: build/ is disposable and
# losing the key permanently breaks upgrade-in-place for every installed copy.
KS=secrets/moci-release.jks
KSP=secrets/keystore.properties
if [[ ! -f "$KS" ]]; then
  if [[ -f build/moci-release.jks ]]; then
    echo "migrating existing key from build/ to secrets/"
    mkdir -p secrets
    cp build/moci-release.jks "$KS"
    cp build/keystore.properties "$KSP" 2>/dev/null || true
  else
    mkdir -p secrets
    PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    "$JAVA_HOME/bin/keytool.exe" -genkeypair -keystore "$KS" -alias moci \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -storepass "$PW" -keypass "$PW" \
      -dname "CN=MociCi, OU=Local, O=MociCi, L=Local, ST=Local, C=CN" >/dev/null 2>&1
    printf 'STORE_PASS=%s\nKEY_PASS=%s\nALIAS=moci\n' "$PW" "$PW" > "$KSP"
    echo "generated $KS (password in $KSP) -- BACK THIS UP OUTSIDE THE REPO"
  fi
fi
[[ -f "$KSP" ]] || fail "keystore.properties missing at $KSP"
# shellcheck disable=SC1091
source <(cat "$KSP")

step "sign"
# Artifacts are version-stamped so an old build can never be mistaken for a new
# one; dist/ keeps every release while build/ stays disposable.
SUFFIX="-qa"
[[ $QA == 1 ]] || SUFFIX=""
OUT="dist/MociCi-${VN}${SUFFIX}.apk"
"$BT/apksigner.bat" sign --ks "$KS" --ks-key-alias "${ALIAS:-moci}" \
  --ks-pass "pass:${STORE_PASS}" --key-pass "pass:${KEY_PASS}" \
  --out "$OUT" build/apk/app-aligned.apk

step "verify"
"$BT/apksigner.bat" verify "$OUT"
"$BT/zipalign.exe" -c -p 4 "$OUT"

step "assert assets"
unzip -l "$OUT" > build/apk/entries.txt
grep -q 'assets/index.html' build/apk/entries.txt || fail "assets/index.html missing from APK"
if grep ' assets/' build/apk/entries.txt | grep -q '\\\\'; then
  fail "assets entry contains a backslash -> unreadable on device"
fi
grep -q 'classes.dex' build/apk/entries.txt || fail "classes.dex missing"
echo "APK entries OK"

step "done"
ls -lh "$OUT"
"$BT/aapt.exe" dump badging "$OUT" | head -5

# Checksum + a copy under the archive directory keyed by version, so the exact
# bytes of every build stay retrievable even after a later rebuild.
step "archive"
SHA="$(sha256sum "$OUT" | awk '{print $1}')"
ARCHIVE_DIR="dist/archive/${VN}${SUFFIX}"
mkdir -p "$ARCHIVE_DIR"
cp "$OUT" "$ARCHIVE_DIR/"
printf '%s  %s\n' "$SHA" "$(basename "$OUT")" > "$ARCHIVE_DIR/SHA256SUMS.txt"
if [[ -f KNOWN-ISSUES.md ]]; then cp KNOWN-ISSUES.md "$ARCHIVE_DIR/"; fi
cp version.json "$ARCHIVE_DIR/"
echo "sha256=$SHA"
echo "archived to $ARCHIVE_DIR"
cat > MANIFEST.txt <<EOF
MociCi build manifest
built: $(date -Is)
versionCode: $VC
versionName: $VN
stage: $STAGE
artifact: $OUT
sha256: $SHA
qaBuild: $QA
EOF
echo "manifest written to MANIFEST.txt"
