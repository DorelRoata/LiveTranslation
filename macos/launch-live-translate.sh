#!/bin/bash

set -u

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG_DIR="$HOME/Library/Application Support/LiveTranslation"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/LiveTranslate.log"
DASHBOARD_URL="https://localhost:5173"
SERVER_PID=""
BUILD_READY=0
UPDATE_MARKER="$CONFIG_DIR/update-transaction"
NODE_BACKUP=""
DIST_BACKUP=""

show_error() {
  if [ "${LIVE_TRANSLATE_DRY_RUN:-0}" = "1" ]; then
    /usr/bin/printf 'Live Translate: %s\n' "$1" >&2
    return 0
  fi
  /usr/bin/osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) with title "Live Translate" buttons {"OK"} default button "OK" with icon stop
end run
APPLESCRIPT
}

show_notice() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT'
on run argv
  display notification (item 1 of argv) with title "Live Translate"
end run
APPLESCRIPT
}

ask_to_update() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT'
on run argv
  set result to display dialog (item 1 of argv) with title "Live Translate Update" buttons {"Later", "Update and Start"} default button "Update and Start" cancel button "Later" with icon note
  return button returned of result
end run
APPLESCRIPT
}

ask_to_start_dirty() {
  /usr/bin/osascript - "$1" <<'APPLESCRIPT'
on run argv
  set result to display dialog (item 1 of argv) with title "Live Translate Update" buttons {"Cancel", "Start Current Version"} default button "Start Current Version" cancel button "Cancel" with icon caution
  return button returned of result
end run
APPLESCRIPT
}

write_update_marker() {
  local phase="$1" marker_temp="$CONFIG_DIR/.update-transaction.$$"
  /usr/bin/printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$REPO_ROOT" "$UPDATE_PREVIOUS_COMMIT" "$UPDATE_EXPECTED_COMMIT" \
    "$UPDATE_HAD_NODE" "$UPDATE_HAD_DIST" "$phase" > "$marker_temp" || return 1
  /bin/chmod 600 "$marker_temp" || return 1
  /bin/mv "$marker_temp" "$UPDATE_MARKER"
}

recover_incomplete_update() {
  local marker_repo previous_commit expected_commit had_node had_dist phase current_commit repository_status status_line tracked_changes
  [ -f "$UPDATE_MARKER" ] || return 0

  marker_repo="$(/usr/bin/sed -n '1p' "$UPDATE_MARKER")"
  previous_commit="$(/usr/bin/sed -n '2p' "$UPDATE_MARKER")"
  expected_commit="$(/usr/bin/sed -n '3p' "$UPDATE_MARKER")"
  had_node="$(/usr/bin/sed -n '4p' "$UPDATE_MARKER")"
  had_dist="$(/usr/bin/sed -n '5p' "$UPDATE_MARKER")"
  phase="$(/usr/bin/sed -n '6p' "$UPDATE_MARKER")"

  case "$had_node" in 0|1) ;; *) return 1 ;; esac
  case "$had_dist" in 0|1) ;; *) return 1 ;; esac
  case "$phase" in prepared|backed_up|updated) ;; *) return 1 ;; esac
  if [ "$marker_repo" != "$REPO_ROOT" ] || [ -z "$previous_commit" ] || [ -z "$expected_commit" ]; then
    show_error "An update recovery record does not match this repository. Remove $UPDATE_MARKER only after reviewing it."
    return 1
  fi
  current_commit="$(/usr/bin/git rev-parse HEAD 2>/dev/null || true)"
  if ! repository_status="$(/usr/bin/git status --porcelain --untracked-files=all 2>/dev/null)"; then
    show_error "Live Translate could not verify the repository state, so automatic recovery stopped."
    return 1
  fi
  tracked_changes=""
  while IFS= read -r status_line; do
    case "$status_line" in
      "?? .live-translate-node_modules-backup"|"?? .live-translate-node_modules-backup/"*|\
      "?? .live-translate-dist-backup"|"?? .live-translate-dist-backup/"*) ;;
      ?*) tracked_changes="${tracked_changes}${status_line}" ;;
    esac
  done <<EOF
$repository_status
EOF
  if [ -n "$tracked_changes" ] || { [ "$current_commit" != "$previous_commit" ] && [ "$current_commit" != "$expected_commit" ]; }; then
    show_error "The repository changed after an interrupted update. Automatic recovery stopped to protect those changes. Review $UPDATE_MARKER manually."
    return 1
  fi
  if [ "$had_node" = "1" ] && [ ! -d "$NODE_BACKUP" ] && [ ! -d node_modules ]; then
    show_error "The dependency backup required to recover the previous version is missing."
    return 1
  fi
  if [ "$had_dist" = "1" ] && [ ! -d "$DIST_BACKUP" ] && [ ! -d dist ]; then
    show_error "The dashboard backup required to recover the previous version is missing."
    return 1
  fi
  if [ "$current_commit" != "$previous_commit" ] && ! /usr/bin/git reset --hard "$previous_commit" >>"$LOG_FILE" 2>&1; then
    show_error "Live Translate could not restore the previous Git revision. Check $LOG_FILE before starting."
    return 1
  fi

  if [ "$had_node" = "1" ]; then
    if [ -d "$NODE_BACKUP" ]; then
      /bin/rm -rf node_modules
      /bin/mv "$NODE_BACKUP" node_modules || return 1
    fi
  else
    /bin/rm -rf node_modules
  fi
  if [ "$had_dist" = "1" ]; then
    if [ -d "$DIST_BACKUP" ]; then
      /bin/rm -rf dist
      /bin/mv "$DIST_BACKUP" dist || return 1
    fi
    BUILD_READY=1
  else
    /bin/rm -rf dist
  fi

  /bin/rm -rf "$NODE_BACKUP" "$DIST_BACKUP"
  /bin/rm -f "$UPDATE_MARKER"
  show_notice "Recovered the previous version after an interrupted update."
  return 0
}

perform_update() {
  UPDATE_PREVIOUS_COMMIT="$(/usr/bin/git rev-parse HEAD)"
  UPDATE_EXPECTED_COMMIT="$REMOTE_COMMIT"
  UPDATE_HAD_NODE=0
  UPDATE_HAD_DIST=0
  if [ -d node_modules ]; then UPDATE_HAD_NODE=1; fi
  if [ -d dist ]; then UPDATE_HAD_DIST=1; fi

  /bin/rm -rf "$NODE_BACKUP" "$DIST_BACKUP"
  write_update_marker prepared || return 2
  if [ "$UPDATE_HAD_NODE" = "1" ]; then /bin/mv node_modules "$NODE_BACKUP" || return 2; fi
  if [ "$UPDATE_HAD_DIST" = "1" ]; then /bin/mv dist "$DIST_BACKUP" || return 2; fi
  write_update_marker backed_up || return 2

  if /usr/bin/git pull --ff-only origin main >>"$LOG_FILE" 2>&1; then
    write_update_marker updated || return 2
  fi
  if [ "$(/usr/bin/git rev-parse HEAD 2>/dev/null || true)" = "$UPDATE_EXPECTED_COMMIT" ] &&
     "$NPM_BIN" ci >>"$LOG_FILE" 2>&1 && "$NPM_BIN" run build >>"$LOG_FILE" 2>&1; then
    /bin/rm -f "$UPDATE_MARKER"
    /bin/rm -rf "$NODE_BACKUP" "$DIST_BACKUP"
    BUILD_READY=1
    return 0
  fi

  if recover_incomplete_update; then return 1; fi
  return 2
}

cleanup() {
  if [ -n "$SERVER_PID" ] && /bin/kill -0 "$SERVER_PID" 2>/dev/null; then
    /bin/kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

/bin/mkdir -p -m 700 "$CONFIG_DIR"
/bin/chmod 700 "$CONFIG_DIR"
/bin/mkdir -p "$LOG_DIR"
/usr/bin/printf '\n[%s] Live Translate launcher starting\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" >>"$LOG_FILE"

if [ ! -d "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/package.json" ]; then
  show_error "The Live Translate repository could not be found at:\n\n$REPO_ROOT\n\nRun install-mac-app.command again from the repository."
  exit 1
fi

cd "$REPO_ROOT" || exit 1
REPO_ROOT="$(pwd -P)"

BASE_PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
SELECTED_NODE_DIR=""

node_dir_is_compatible() {
  [ -x "$1/node" ] && [ -x "$1/npm" ] &&
    "$1/node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); const ok = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22; process.exit(ok ? 0 : 1)' >/dev/null 2>&1
}

get_running_repository() {
  local instance_json
  instance_json="$(/usr/bin/curl --insecure --silent --fail "$DASHBOARD_URL/api/instance" 2>/dev/null || true)"
  /usr/bin/printf '%s' "$instance_json" | node -e 'let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => { try { const data=JSON.parse(value); if(data.application==="live-translate") process.stdout.write(data.repositoryPath || ""); } catch {} });'
}

CURRENT_NODE="$(PATH="$BASE_PATH" command -v node 2>/dev/null || true)"
if [ -n "$CURRENT_NODE" ]; then
  CURRENT_NODE_DIR="$(/usr/bin/dirname "$CURRENT_NODE")"
  if node_dir_is_compatible "$CURRENT_NODE_DIR"; then SELECTED_NODE_DIR="$CURRENT_NODE_DIR"; fi
fi
if [ -z "$SELECTED_NODE_DIR" ] && node_dir_is_compatible "$REPO_ROOT/../node_binary/bin"; then
  SELECTED_NODE_DIR="$REPO_ROOT/../node_binary/bin"
fi
if [ -z "$SELECTED_NODE_DIR" ]; then
  for NODE_BIN_DIR in "$HOME"/.nvm/versions/node/*/bin; do
    if node_dir_is_compatible "$NODE_BIN_DIR"; then
      SELECTED_NODE_DIR="$NODE_BIN_DIR"
      break
    fi
  done
fi

if [ -z "$SELECTED_NODE_DIR" ]; then
  show_error "A compatible Node.js installation was not found. Install Node.js 22 LTS, then open Live Translate again."
  exit 1
fi
export PATH="$SELECTED_NODE_DIR:$BASE_PATH"
NODE_BIN="$SELECTED_NODE_DIR/node"
NPM_BIN="$SELECTED_NODE_DIR/npm"
/usr/bin/printf 'Repository: %s\nNode: %s (%s)\n' "$REPO_ROOT" "$NODE_BIN" "$($NODE_BIN --version)" >>"$LOG_FILE"

NODE_BACKUP="$REPO_ROOT/.live-translate-node_modules-backup"
DIST_BACKUP="$REPO_ROOT/.live-translate-dist-backup"
if [ -f "$UPDATE_MARKER" ]; then
  recover_incomplete_update || exit 1
else
  /bin/rm -rf "$NODE_BACKUP" "$DIST_BACKUP"
fi

if /usr/bin/curl --insecure --silent --fail "$DASHBOARD_URL/api/network-ip" >/dev/null 2>&1; then
  RUNNING_REPO="$(get_running_repository)"
  if [ "$RUNNING_REPO" = "$REPO_ROOT" ]; then
    /usr/bin/open "$DASHBOARD_URL"
    exit 0
  fi
  show_error "Port 5173 is already being used by another or older server. Stop that server, then open Live Translate again."
  exit 1
fi

if [ "$(/usr/bin/git rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ] && [ "${LIVE_TRANSLATE_SKIP_UPDATE:-0}" != "1" ]; then
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"
  CURRENT_BRANCH="$(/usr/bin/git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ "$CURRENT_BRANCH" != "main" ]; then
    show_notice "Automatic updates require the main branch. Starting the current checkout."
  elif /usr/bin/git fetch --quiet origin main >>"$LOG_FILE" 2>&1; then
    CURRENT_COMMIT="$(/usr/bin/git rev-parse HEAD 2>/dev/null)"
    REMOTE_COMMIT="$(/usr/bin/git rev-parse origin/main 2>/dev/null)"
    if [ -n "$CURRENT_COMMIT" ] && [ -n "$REMOTE_COMMIT" ] && [ "$CURRENT_COMMIT" != "$REMOTE_COMMIT" ]; then
      if [ -n "$(/usr/bin/git status --porcelain)" ]; then
        CHOICE="$(ask_to_start_dirty "An update is available, but this repository has local changes. Nothing will be overwritten. Commit or stash those changes before updating.")"
        if [ "$CHOICE" != "Start Current Version" ]; then exit 0; fi
      elif /usr/bin/git merge-base --is-ancestor HEAD origin/main; then
        CURRENT_SHORT="$(/usr/bin/git rev-parse --short HEAD)"
        REMOTE_SHORT="$(/usr/bin/git rev-parse --short origin/main)"
        CHOICE="$(ask_to_update "A Live Translate update is available ($CURRENT_SHORT to $REMOTE_SHORT). Install it before starting?")"
        if [ "$CHOICE" = "Update and Start" ]; then
          show_notice "Installing the latest update..."
          perform_update
          UPDATE_RESULT=$?
          if [ "$UPDATE_RESULT" = "1" ]; then
            show_error "The update failed, so the previous version was restored. It will start now. Check $LOG_FILE for details."
          elif [ "$UPDATE_RESULT" != "0" ]; then
            show_error "The update failed and automatic recovery could not complete. Check $LOG_FILE before starting."
            exit 1
          fi
        fi
      else
        show_notice "The local branch differs from GitHub, so it was not updated automatically."
      fi
    fi
  else
    show_notice "Could not check for updates. Starting the installed version."
  fi
fi

if [ "${LIVE_TRANSLATE_DRY_RUN:-0}" = "1" ]; then
  echo "Live Translate launcher ready"
  echo "Repository: $REPO_ROOT"
  echo "Node: $(node --version)"
  exit 0
fi

dependencies_are_ready() {
  "$NODE_BIN" -e "Promise.all([import('@vitejs/plugin-basic-ssl'), import('qrcode'), import('ws')]).catch(() => process.exit(1))" >/dev/null 2>&1
}

if ! dependencies_are_ready; then
  show_notice "Installing Live Translate dependencies..."
  if ! "$NPM_BIN" ci >>"$LOG_FILE" 2>&1; then
    show_error "Live Translate dependencies could not be installed. Check $LOG_FILE for details."
    exit 1
  fi
fi

# Release checkouts include a tested production build. Rebuilding it on every
# Dock launch made cold starts depend unnecessarily on npm/Vite and could fail
# on a second Mac even though the shipped dashboard was ready to serve.
if [ "$BUILD_READY" != "1" ] && [ ! -f dist/index.html ]; then
  show_notice "Preparing the dashboard..."
  if ! "$NPM_BIN" run build >>"$LOG_FILE" 2>&1; then
    show_error "The Live Translate dashboard could not be built. Check $LOG_FILE for details."
    exit 1
  fi
fi

"$NODE_BIN" server.js >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for ATTEMPT in {1..60}; do
  if /usr/bin/curl --insecure --silent --fail "$DASHBOARD_URL/api/network-ip" >/dev/null 2>&1; then
    READY_REPO="$(get_running_repository)"
    if [ "$READY_REPO" = "$REPO_ROOT" ]; then
      /usr/bin/open "$DASHBOARD_URL"
      show_notice "Dashboard ready"
      wait "$SERVER_PID"
      exit $?
    fi
    show_error "Another server claimed port 5173 during startup. Stop it, then open Live Translate again."
    exit 1
  fi
  if ! /bin/kill -0 "$SERVER_PID" 2>/dev/null; then
    show_error "The Live Translate server stopped during startup. Check $LOG_FILE for details."
    exit 1
  fi
  /bin/sleep 0.5
done

show_error "The Live Translate server did not become ready. Check $LOG_FILE for details."
exit 1
