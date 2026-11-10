#!/usr/bin/env bash
# Builds a debug APK without Gradle, using aapt2 + javac + d8 + apksigner.
#
# Requires: JDK 17 and Android SDK build-tools 34 + platform 34.
#   export JAVA_HOME=/path/to/jdk
#   export ANDROID_SDK_ROOT=/path/to/android-sdk
#   ./android/build-apk.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
PLATFORM="${ANDROID_JAR:-$SDK/platforms/android-34/android.jar}"
VERSION="1.4.0"
OUT="$DIR/build"
APK="$DIR/bolti-bahi-$VERSION-debug.apk"

if [ -z "$SDK" ] || [ ! -f "$PLATFORM" ]; then
  echo "Android SDK not found. Set ANDROID_SDK_ROOT (needs platform 34 + build-tools 34.0.0)." >&2
  exit 1
fi

JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
JAR="${JAVA_HOME:+$JAVA_HOME/bin/}jar"
KEYTOOL="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"

rm -rf "$OUT"
mkdir -p "$OUT/res/drawable" "$OUT/gen" "$OUT/classes" "$OUT/dex"

cp "$DIR/res/values/strings.xml" "$OUT/res/" 2>/dev/null || true
mkdir -p "$OUT/res/values"
cp "$DIR/res/values/strings.xml" "$OUT/res/values/strings.xml"
cp "$DIR/../public/icons/icon-512.png" "$OUT/res/drawable/icon.png"

echo "==> compiling resources"
"$BUILD_TOOLS/aapt2" compile --dir "$OUT/res" -o "$OUT/resources.zip"

echo "==> linking manifest"
"$BUILD_TOOLS/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$DIR/AndroidManifest.xml" \
  -R "$OUT/resources.zip" \
  --java "$OUT/gen" \
  --auto-add-overlay

echo "==> compiling java"
"$JAVAC" -source 11 -target 11 -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find "$OUT/gen" "$DIR/java" -name '*.java')

echo "==> dexing"
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 23 --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

(cd "$OUT/dex" && "$JAR" uf "$OUT/base.apk" classes.dex)

echo "==> aligning"
"$BUILD_TOOLS/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"

KS="$DIR/keystore/debug.keystore"
if [ ! -f "$KS" ]; then
  mkdir -p "$DIR/keystore"
  "$KEYTOOL" -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

echo "==> signing"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$APK" "$OUT/aligned.apk"

echo "==> verifying"
"$BUILD_TOOLS/apksigner" verify --print-certs "$APK" | head -6
"$BUILD_TOOLS/aapt2" dump badging "$APK" | head -6

echo "APK: $APK"
