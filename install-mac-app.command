#!/bin/bash

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_APP="$REPO_ROOT/macos/Live Translate.app"
APPLICATIONS_DIR="${LIVE_TRANSLATE_APPLICATIONS_DIR:-$HOME/Applications}"
DESTINATION_APP="$APPLICATIONS_DIR/Live Translate.app"
CONFIG_DIR="$HOME/Library/Application Support/LiveTranslation"
TEMP_APP="$APPLICATIONS_DIR/.Live Translate.app.installing"
BACKUP_APP="$APPLICATIONS_DIR/.Live Translate.app.previous"
REPO_PATH_FILE="$CONFIG_DIR/repo-path.txt"
TEMP_REPO_PATH="$CONFIG_DIR/.repo-path.installing"
BACKUP_REPO_PATH="$CONFIG_DIR/.repo-path.previous"
INSTALL_MARKER="$CONFIG_DIR/install-transaction"
TEMP_INSTALL_MARKER="$CONFIG_DIR/.install-transaction.$$"
INSTALL_COMPLETE=0

write_install_marker() {
  local phase="$1"
  /usr/bin/printf '%s\n%s\n%s\n' "$HAD_APP" "$HAD_REPO_PATH" "$phase" > "$TEMP_INSTALL_MARKER" || return 1
  /bin/chmod 600 "$TEMP_INSTALL_MARKER" || return 1
  /bin/mv "$TEMP_INSTALL_MARKER" "$INSTALL_MARKER"
}

recover_install() {
  local had_app had_repo_path phase
  [ -f "$INSTALL_MARKER" ] || return 0
  had_app="$(/usr/bin/sed -n '1p' "$INSTALL_MARKER")"
  had_repo_path="$(/usr/bin/sed -n '2p' "$INSTALL_MARKER")"
  phase="$(/usr/bin/sed -n '3p' "$INSTALL_MARKER")"

  case "$had_app" in 0|1) ;; *) return 1 ;; esac
  case "$had_repo_path" in 0|1) ;; *) return 1 ;; esac
  case "$phase" in prepared|backed_up|installed) ;; *) return 1 ;; esac

  if [ "$had_app" = "1" ]; then
    if [ -d "$BACKUP_APP" ]; then
      /bin/rm -rf "$DESTINATION_APP" || return 1
      /usr/bin/ditto "$BACKUP_APP" "$DESTINATION_APP" || return 1
    elif [ "$phase" != "prepared" ] || [ ! -d "$DESTINATION_APP" ]; then
      return 1
    fi
  elif [ "$phase" != "prepared" ]; then
    /bin/rm -rf "$DESTINATION_APP" || return 1
  fi
  if [ "$had_repo_path" = "1" ]; then
    if [ -f "$BACKUP_REPO_PATH" ]; then
      /bin/rm -f "$REPO_PATH_FILE" || return 1
      /bin/cp "$BACKUP_REPO_PATH" "$REPO_PATH_FILE" || return 1
    elif [ "$phase" != "prepared" ] || [ ! -f "$REPO_PATH_FILE" ]; then
      return 1
    fi
  elif [ "$phase" != "prepared" ]; then
    /bin/rm -f "$REPO_PATH_FILE" || return 1
  fi

  /bin/rm -rf "$TEMP_APP" "$TEMP_REPO_PATH" "$TEMP_INSTALL_MARKER" || return 1
  /bin/rm -f "$INSTALL_MARKER" || return 1
  /bin/rm -rf "$BACKUP_APP" "$BACKUP_REPO_PATH" || return 1
  return 0
}

cleanup() {
  if [ "$INSTALL_COMPLETE" != "1" ] && [ -f "$INSTALL_MARKER" ]; then
    recover_install || true
  else
    /bin/rm -rf "$TEMP_APP" "$TEMP_REPO_PATH" "$TEMP_INSTALL_MARKER"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

if [ ! -d "$SOURCE_APP" ]; then
  /usr/bin/osascript -e 'display dialog "The Live Translate app template is missing." with title "Live Translate Installer" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

/bin/mkdir -p "$APPLICATIONS_DIR"
/bin/mkdir -p -m 700 "$CONFIG_DIR"
/bin/chmod 700 "$CONFIG_DIR"

if [ -f "$INSTALL_MARKER" ] && ! recover_install; then
  /usr/bin/osascript -e 'display dialog "A previous Live Translate installation was interrupted and could not be recovered automatically." with title "Live Translate Installer" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi
/bin/rm -rf "$TEMP_APP" "$BACKUP_APP" "$TEMP_REPO_PATH" "$TEMP_INSTALL_MARKER" "$BACKUP_REPO_PATH"

/usr/bin/ditto "$SOURCE_APP" "$TEMP_APP"
/bin/chmod +x "$TEMP_APP/Contents/MacOS/live-translate" "$REPO_ROOT/macos/launch-live-translate.sh"
/usr/bin/codesign --force --deep --sign - "$TEMP_APP" >/dev/null 2>&1
/usr/bin/codesign --verify --deep --strict "$TEMP_APP"
/usr/bin/printf '%s\n' "$REPO_ROOT" > "$TEMP_REPO_PATH"
/bin/chmod 600 "$TEMP_REPO_PATH"

HAD_APP=0
HAD_REPO_PATH=0
if [ -d "$DESTINATION_APP" ]; then HAD_APP=1; fi
if [ -f "$REPO_PATH_FILE" ]; then HAD_REPO_PATH=1; fi
write_install_marker prepared
if [ -d "$DESTINATION_APP" ]; then /bin/mv "$DESTINATION_APP" "$BACKUP_APP"; fi
if [ -f "$REPO_PATH_FILE" ]; then /bin/mv "$REPO_PATH_FILE" "$BACKUP_REPO_PATH"; fi
write_install_marker backed_up
/bin/mv "$TEMP_APP" "$DESTINATION_APP"
/bin/mv "$TEMP_REPO_PATH" "$REPO_PATH_FILE"
write_install_marker installed
/usr/bin/xattr -dr com.apple.quarantine "$DESTINATION_APP" 2>/dev/null || true
/usr/bin/touch "$DESTINATION_APP"
/bin/rm -f "$INSTALL_MARKER"
/bin/rm -rf "$BACKUP_APP" "$BACKUP_REPO_PATH"
INSTALL_COMPLETE=1
trap - EXIT INT TERM

if [ "${LIVE_TRANSLATE_SKIP_LAUNCH:-0}" = "1" ]; then
  echo "Installed Live Translate.app at $DESTINATION_APP"
  exit 0
fi

CHOICE="$(/usr/bin/osascript <<'APPLESCRIPT'
set result to display dialog "Live Translate was installed in your Applications folder. Drag it to the Dock for one-click access. Future code updates will be offered when the app starts." with title "Live Translate Installed" buttons {"Open Applications", "Launch Now"} default button "Launch Now" with icon note
return button returned of result
APPLESCRIPT
)"

if [ "$CHOICE" = "Launch Now" ]; then
  /usr/bin/open "$DESTINATION_APP"
else
  /usr/bin/open "$APPLICATIONS_DIR"
fi
