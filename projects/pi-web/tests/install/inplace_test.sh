#!/usr/bin/env bash
# Real installer in an isolated HOME; service commands are test-only shims.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
run_case() {
  local mode="$1" workdir bindir shimdir calllog source
  workdir="$(mktemp -d)"
  bindir="$workdir/.pi/agent/bin"; shimdir="$workdir/shim"; calllog="$workdir/calls.log"; source="$workdir/source-pi-web"
  mkdir -p "$bindir" "$shimdir"
  printf '#!/usr/bin/env bash\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n' > "$shimdir/uname"
  for tool in systemctl launchctl pkill sudo; do
    printf '#!/usr/bin/env bash\necho "%s $*" >> "%s"\nexit 0\n' "$tool" "$calllog" > "$shimdir/$tool"
  done
  chmod +x "$shimdir"/*
  : > "$calllog"
  printf '#!/bin/sh\necho v0.0.0\n' > "$bindir/pi-web"
  [[ "$mode" == "same-version" ]] && printf '#!/bin/sh\n# old build\necho v9.9.9\n' > "$bindir/pi-web"
  printf '#!/bin/sh\necho v9.9.9\n' > "$source"
  chmod +x "$bindir/pi-web" "$source"
  local env_vars=("HOME=$workdir" "PI_WEB_INSTALL_DIR=$bindir" "PI_WEB_SOURCE_BINARY=$source" "PATH=$shimdir:/usr/bin:/bin")
  [[ "$mode" != "normal" ]] && env_vars+=("PI_WEB_INPLACE_UPDATE=1")
  env -i "${env_vars[@]}" bash "$REPO_ROOT/install.sh" </dev/null > "$workdir/out.log" 2>&1 \
    || fail "[$mode] installer failed: $(<"$workdir/out.log")"
  [[ -x "$bindir/pi-web" && -x "$source" ]] || fail "[$mode] installed/source binary missing"
  [[ "$("$bindir/pi-web" -version)" == "v9.9.9" ]] || fail "[$mode] wrong installed version"
  cmp -s "$source" "$bindir/pi-web" || fail "[$mode] source build was skipped"
  if [[ "$mode" != "normal" ]]; then
    [[ ! -s "$calllog" ]] || fail "in-place update changed the running service"
  else
    grep -Eq 'systemctl|launchctl|pkill' "$calllog" || fail "normal install did not replace the running instance"
  fi
  : > "$calllog"
  env -i "${env_vars[@]}" bash "$REPO_ROOT/install.sh" </dev/null > "$workdir/out.log" 2>&1 \
    || fail "[$mode] repeated install failed"
  [[ ! -s "$calllog" ]] || fail "[$mode] identical build restarted the service"
  mkdir -p "$workdir/.config/pi-web" "$workdir/.pi/agent/sessions" "$workdir/.pi/agent/pi-web"
  for file in .config/pi-web/env .pi/agent/pi-web.sqlite .pi/agent/pi-web-memory.sqlite .pi/agent/sessions/session.jsonl; do
    printf 'preserve data and credentials\n' > "$workdir/$file"
  done
  printf '{}' > "$workdir/.pi/agent/pi-web/pi-web-state.json"
  env -i "HOME=$workdir" "PATH=$shimdir:/usr/bin:/bin" bash "$REPO_ROOT/uninstall.sh" > "$workdir/out.log" 2>&1 \
    || fail "[$mode] uninstaller failed: $(<"$workdir/out.log")"
  [[ ! -e "$bindir/pi-web" && -x "$source" ]] || fail "[$mode] uninstaller used the wrong binary path"
  [[ ! -e "$workdir/.pi/agent/pi-web/pi-web-state.json" ]] || fail "[$mode] runtime state retained"
  for file in .config/pi-web/env .pi/agent/pi-web.sqlite .pi/agent/pi-web-memory.sqlite .pi/agent/sessions/session.jsonl; do
    [[ "$(<"$workdir/$file")" == 'preserve data and credentials' ]] || fail "[$mode] user data changed: $file"
  done
  echo "ok: $mode (install, no-op update, uninstall with data preserved)"
  rm -rf "$workdir"
}
run_case inplace
run_case normal
run_case same-version
echo "PASS: local install, same-version update and data-preserving uninstall"
