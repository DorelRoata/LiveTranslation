#!/bin/bash

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Live Translate.app"
LOG_FILE="$HOME/Library/Logs/LiveTranslate.log"

cd "$REPO_ROOT"

{
  /usr/bin/printf '\n[%s] update-live-translate.command starting\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')"
} >>"$LOG_FILE"

if [ "$(/usr/bin/git rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]; then
  /usr/bin/osascript -e 'display dialog "This folder is not a Git repository, so Live Translate cannot pull an update." with title "Live Translate Update" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"

if ! /usr/bin/git fetch --quiet origin main >>"$LOG_FILE" 2>&1; then
  /usr/bin/osascript -e 'display dialog "Could not reach GitHub to pull the update. Check the network, then try again." with title "Live Translate Update" buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

if [ -n "$(/usr/bin/git status --porcelain)" ]; then
  /usr/bin/osascript -e 'display dialog "This repository has local changes, so the update was not applied. Commit or stash them, then run this shortcut again." with title "Live Translate Update" buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi

CURRENT="$(/usr/bin/git rev-parse HEAD)"
REMOTE="$(/usr/bin/git rev-parse origin/main)"
if [ "$CURRENT" != "$REMOTE" ]; then
  if ! /usr/bin/git merge-base --is-ancestor HEAD origin/main; then
    /usr/bin/osascript -e 'display dialog "The local branch differs from GitHub, so it was not updated automatically." with title "Live Translate Update" buttons {"OK"} default button "OK" with icon caution'
    exit 1
  fi
  if ! /usr/bin/git pull --ff-only origin main >>"$LOG_FILE" 2>&1; then
    /usr/bin/osascript -e 'display dialog "git pull failed. Check ~/Library/Logs/LiveTranslate.log." with title "Live Translate Update" buttons {"OK"} default button "OK" with icon stop'
    exit 1
  fi
fi

if [ -d "$APP" ]; then
  /usr/bin/open "$APP"
else
  /bin/bash "$REPO_ROOT/macos/launch-live-translate.sh" "$REPO_ROOT"
fi
