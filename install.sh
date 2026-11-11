#!/bin/sh
# Installs Tayang Studio, the latest release, on macOS or Linux:
#
#   curl -fsSL https://studio.tayang.app/install.sh | sh
#
# On Windows, run install.ps1 in PowerShell instead; from Git Bash this script hands over to it.
#
# Options (environment variables):
#   TAYANG_VERSION=0.0.2        install this version instead of the latest
#   TAYANG_INSTALL_DIR=<dir>    macOS: where the app goes (default /Applications, else ~/Applications)
#   TAYANG_LINUX_PACKAGE=deb|rpm|appimage
#                               Linux: the package to use (default: deb with apt, rpm with dnf,
#                               yum or zypper, else the AppImage, which needs no sudo)
#   TAYANG_NO_LAUNCH=1          don't open Tayang when done
#
# Installed copies update themselves, so this is only needed once.
set -eu

REPO="Maru-Yasa/tayang-studio"
BASE="${TAYANG_DOWNLOAD_BASE:-https://github.com/$REPO/releases}"
# studio.tayang.app serves install.sh and install.ps1 (copies of the ones in this repo).
SITE="${TAYANG_SITE:-https://studio.tayang.app}"
RAW="${TAYANG_RAW_BASE:-https://raw.githubusercontent.com/$REPO/main}"
APP="Tayang Studio"
# GitHub swaps the space in "Tayang Studio" for a dot in asset names.
ASSET="Tayang.Studio"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Tayang install failed: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

download() { # url file
  if has curl; then
    curl -fL --progress-bar --retry 3 -o "$2" "$1" || fail "couldn't download $1"
  elif has wget; then
    wget -q --show-progress -O "$2" "$1" || fail "couldn't download $1"
  else
    fail "this needs curl or wget"
  fi
}

fetch() { # url -> stdout
  if has curl; then
    curl -fsSL --retry 3 "$1"
  elif has wget; then
    wget -qO- "$1"
  else
    fail "this needs curl or wget"
  fi
}

# Root needs no sudo; otherwise sudo, or nothing when there is none.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}
can_root() { [ "$(id -u)" = 0 ] || has sudo; }

latest_version() {
  json=$(fetch "$BASE/latest/download/latest.json") || fail "couldn't find the latest release at $BASE"
  v=$(printf '%s' "$json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$v" ] || fail "the latest release has no version"
  printf '%s' "${v#v}"
}

TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

install_macos() {
  case "$(uname -m)" in
    arm64) arch=aarch64 ;;
    x86_64)
      # An Intel shell on an Apple chip (Rosetta) still gets the Apple chip build.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=aarch64; else arch=x64; fi
      ;;
    *) fail "unsupported Mac processor: $(uname -m)" ;;
  esac

  file="${ASSET}_${VERSION}_${arch}.app.tar.gz"
  say "Downloading $APP $VERSION for macOS ($arch)..."
  download "$BASE/download/v$VERSION/$file" "$TMP/app.tar.gz"
  mkdir "$TMP/app"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" || fail "the download is damaged; try again"
  [ -d "$TMP/app/$APP.app" ] || fail "the download has no $APP.app"

  dir="${TAYANG_INSTALL_DIR:-}"
  if [ -z "$dir" ]; then
    if [ -w /Applications ]; then dir=/Applications; else dir="$HOME/Applications"; fi
  fi
  mkdir -p "$dir"
  # This copy only: a dev build (Tayang Studio Dev) has the same process name.
  if pgrep -qf "$dir/$APP.app/Contents/MacOS/" 2>/dev/null; then
    say "Tayang is open; the new version starts the next time you open it."
  fi
  rm -rf "$dir/$APP.app"
  mv "$TMP/app/$APP.app" "$dir/" || fail "couldn't write to $dir (set TAYANG_INSTALL_DIR to another folder)"
  # Only browsers mark downloads for Gatekeeper, but clear the mark in case something added it.
  xattr -dr com.apple.quarantine "$dir/$APP.app" 2>/dev/null || true

  say "Installed $APP $VERSION in $dir."
  if [ -z "${TAYANG_NO_LAUNCH:-}" ]; then open "$dir/$APP.app" 2>/dev/null || true; fi
}

linux_package() {
  if [ -n "${TAYANG_LINUX_PACKAGE:-}" ]; then
    case "$TAYANG_LINUX_PACKAGE" in
      deb | rpm | appimage) printf '%s' "$TAYANG_LINUX_PACKAGE" ;;
      *) fail "TAYANG_LINUX_PACKAGE must be deb, rpm or appimage" ;;
    esac
    return
  fi
  if can_root && has apt-get && has dpkg; then
    printf deb
  elif can_root && { has dnf || has yum || has zypper; }; then
    printf rpm
  else
    printf appimage
  fi
}

install_linux() {
  # Release file names: .deb says amd64/arm64, .rpm and .AppImage say x86_64/aarch64 (amd64 for x86_64 AppImages).
  case "$(uname -m)" in
    x86_64 | amd64) deb_arch=amd64 rpm_arch=x86_64 appimage_arch=amd64 ;;
    aarch64 | arm64) deb_arch=arm64 rpm_arch=aarch64 appimage_arch=aarch64 ;;
    *) fail "Tayang for Linux is built for x86_64 and ARM64 (aarch64) only, not $(uname -m)" ;;
  esac
  kind=$(linux_package)
  case "$kind" in
    deb)
      file="${ASSET}_${VERSION}_${deb_arch}.deb"
      say "Downloading $APP $VERSION (.deb)..."
      download "$BASE/download/v$VERSION/$file" "$TMP/$file"
      chmod 644 "$TMP/$file"
      chmod 755 "$TMP"
      say "Installing (this may ask for your password)..."
      # apt-get pulls in the WebKit and tray libraries the app needs.
      as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$TMP/$file" || fail "apt-get couldn't install $file"
      bin=tayang-studio
      ;;
    rpm)
      file="${ASSET}-${VERSION}-1.${rpm_arch}.rpm"
      say "Downloading $APP $VERSION (.rpm)..."
      download "$BASE/download/v$VERSION/$file" "$TMP/$file"
      say "Installing (this may ask for your password)..."
      if has dnf; then
        as_root dnf install -y "$TMP/$file"
      elif has yum; then
        as_root yum install -y "$TMP/$file"
      else
        as_root zypper --non-interactive install --allow-unsigned-rpm "$TMP/$file"
      fi || fail "couldn't install $file"
      bin=tayang-studio
      ;;
    appimage)
      file="${ASSET}_${VERSION}_${appimage_arch}.AppImage"
      say "Downloading $APP $VERSION (AppImage)..."
      download "$BASE/download/v$VERSION/$file" "$TMP/$file"
      data="${XDG_DATA_HOME:-$HOME/.local/share}"
      dir="$data/tayang-studio"
      mkdir -p "$dir" "$HOME/.local/bin" "$data/applications"
      mv "$TMP/$file" "$dir/Tayang-Studio.AppImage"
      chmod 755 "$dir/Tayang-Studio.AppImage"
      ln -sf "$dir/Tayang-Studio.AppImage" "$HOME/.local/bin/tayang-studio"
      # The app menu entry; the AppImage updates itself in place, so the path stays the same.
      cat >"$data/applications/tayang-studio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP
Comment=Make animated videos with your AI agent
Exec="$dir/Tayang-Studio.AppImage" %U
Icon=tayang-studio
Terminal=false
Categories=AudioVideo;Video;
EOF
      # The menu icon, from the repo: a missing icon is cosmetic, so a failure here is ignored.
      mkdir -p "$data/icons/hicolor/128x128/apps"
      fetch "$RAW/apps/desktop/src-tauri/icons/128x128.png" >"$TMP/icon.png" 2>/dev/null &&
        mv "$TMP/icon.png" "$data/icons/hicolor/128x128/apps/tayang-studio.png" || true
      has update-desktop-database && update-desktop-database "$data/applications" >/dev/null 2>&1 || true
      if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
        say "Note: AppImages need FUSE 2 (libfuse2 on Ubuntu/Debian, fuse-libs on Fedora) to run."
      fi
      case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) say "Add ~/.local/bin to your PATH to start it with 'tayang-studio'." ;;
      esac
      bin="$dir/Tayang-Studio.AppImage"
      ;;
  esac

  say "Installed $APP $VERSION. Find it in your app menu, or run: tayang-studio"
  if [ -z "${TAYANG_NO_LAUNCH:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    (nohup "$bin" >/dev/null 2>&1 &) || true
  fi
}

install_windows() {
  has powershell.exe || fail "on Windows, run install.ps1 in PowerShell"
  say "Handing over to PowerShell..."
  exec powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm '$SITE/install.ps1' | iex"
}

main() {
  os=$(uname -s)
  case "$os" in
    MINGW* | MSYS* | CYGWIN*) install_windows ;;
  esac

  VERSION="${TAYANG_VERSION:-}"
  VERSION="${VERSION#v}"
  [ -n "$VERSION" ] || VERSION=$(latest_version)
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t tayang)

  case "$os" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) fail "unsupported system: $os (Tayang runs on macOS, Windows and Linux)" ;;
  esac
}

main "$@"
