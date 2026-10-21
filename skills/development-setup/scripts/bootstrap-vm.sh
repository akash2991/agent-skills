#!/bin/bash
# Sourceable for hermetic tests; no actions occur until main is called.

log() { printf 'bootstrap-vm: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }
usage() {
  printf '%s\n' 'Usage: bootstrap-vm.sh [--dry-run|--apply] [--with-docker] [--with-terraform]' \
    'Default: JSON plan only, no mutations. --apply requires non-root Ubuntu 24.04,' \
    'x86_64/aarch64, writable durable HOME and passwordless sudo apt privileges.' \
    'Docker apt installation may start/enable its daemon; no group changes are made.'
}
# These small host probes can be replaced by shell functions in sourced tests.
host_uid() { id -u; }
host_os() { uname -s; }
host_arch() { uname -m; }
host_release() {
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]]
}
check_host() {
  [[ $(host_uid) != 0 ]] || fail 'do not run apply as root'
  [[ ${HOME:-} == /* && -d $HOME && -w $HOME ]] || fail 'HOME must be absolute, existing and writable'
  [[ $(host_os) == Linux ]] || fail 'Ubuntu 24.04 Linux required'
  host_release || fail 'Ubuntu 24.04 required'
  case $(host_arch) in
    x86_64) NODE_ARCH=x64; TF_ARCH=amd64 ;;
    aarch64) NODE_ARCH=arm64; TF_ARCH=arm64 ;;
    *) fail 'x86_64 or aarch64 required' ;;
  esac
  command -v flock >/dev/null || fail 'flock (util-linux) required'
  command -v timeout >/dev/null || fail 'GNU timeout (coreutils) required'
  command -v sudo >/dev/null || fail 'sudo required'
  sudo -n apt-get --version >/dev/null || fail 'noninteractive sudo apt privileges required (authenticate with sudo first)'
}
working() { command -v "$1" >/dev/null && "$1" --version >/dev/null 2>&1; }
node_sufficient() {
  local v major minor patch
  v=$(node --version 2>/dev/null) || return 1
  [[ $v =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}; patch=${BASH_REMATCH[3]}
  [[ -n $patch ]] && (( 10#$major > 22 || (10#$major == 22 && 10#$minor >= 19) ))
}
record() {
  local action=$1 name=$2
  log "$action $name"
  if [[ $action == installed ]]; then INSTALLED+=("$name"); else SKIPPED+=("$name"); fi
}
summary() {
  local status=$1 item sep=''
  printf '{"status":"%s","mode":"%s","docker":%s,"terraform":%s,"installed":[' \
    "$status" "$MODE" "$WITH_DOCKER" "$WITH_TERRAFORM"
  for item in "${INSTALLED[@]-}"; do [[ -n $item ]] || continue; printf '%s"%s"' "$sep" "$item"; sep=,; done
  printf '],"skipped":['; sep=''
  for item in "${SKIPPED[@]-}"; do [[ -n $item ]] || continue; printf '%s"%s"' "$sep" "$item"; sep=,; done
  printf ']}\n'
}
cleanup() {
  local rc=$?
  trap - EXIT
  [[ -z ${WORK:-} ]] || rm -rf -- "$WORK"
  if (( rc != 0 )); then log "failed (exit $rc); partial installs may remain; rerun after fixing the cause"; summary error >&8; fi
  exit "$rc"
}
fetch() {
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --retry 2 --retry-max-time 180 --connect-timeout 15 --max-time 120 \
    "$1" --output "$2"
}
verify_archive() {
  local name=$1 sums=$2
  # Verify only the exact canonical archive name, never other manifest entries.
  awk -v name="$name" '$2 == name { print; n++ } END { if (n != 1) exit 1 }' \
    "$WORK/$sums" > "$WORK/checksum" || fail "missing/duplicate checksum for $name"
  (cd "$WORK" && sha256sum -c checksum) || fail "checksum failed for $name"
}
install_node() {
  local name="node-v22.23.2-linux-$NODE_ARCH" target
  target="$HOME/.local/lib/nodejs/$name"
  if node_sufficient && working npm; then record skipped node; return; fi
  [[ ! -e $target && ! -L $target ]] || fail "refusing to replace existing Node directory: $target"
  fetch "https://nodejs.org/dist/v22.23.2/$name.tar.xz" "$WORK/$name.tar.xz"
  fetch 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt' "$WORK/node-sums"
  verify_archive "$name.tar.xz" node-sums
  mkdir -p "$WORK/node" "$HOME/.local/lib/nodejs"
  tar -xJf "$WORK/$name.tar.xz" -C "$WORK/node"
  mv "$WORK/node/$name" "$target"
  hash -r
  if ! node_sufficient || ! working npm; then fail 'Node >=22.19 and working npm required'; fi
  record installed node
}
install_npm_tool() {
  local cmd=$1 package=$2
  if working "$cmd"; then record skipped "$cmd"; return; fi
  npm install --global --ignore-scripts --prefix "$HOME/.local/share/npm" "$package"
  hash -r
  working "$cmd" || fail "verification failed: $cmd"
  record installed "$cmd"
}
prepare_installer_runner() {
  local real_curl
  real_curl=$(command -v curl)
  [[ $real_curl == /* ]] || fail 'curl must be an executable on PATH'
  mkdir -p "$WORK/runner"
  # The private shim also bounds curl calls made INSIDE upstream installers.
  # The outer timeout bounds installers/downloaders that do not use curl.
  {
    printf '#!/usr/bin/env bash\nexec %q --connect-timeout 15 --max-time 120 --retry-max-time 180 ' "$real_curl"
    printf '%s\n' '--proto "=https" --proto-redir "=https" "$@"'
  } > "$WORK/runner/curl"
  chmod +x "$WORK/runner/curl"
}
run_installer() {
  local name=$1 url=$2
  shift 2
  fetch "$url" "$WORK/$name-install.sh"
  PATH="$WORK/runner:$PATH" timeout --kill-after=30s 900s bash -s -- "$@" < "$WORK/$name-install.sh"
}
install_native_tools() {
  local cmd
  for cmd in herdr uv bun claude; do
    if working "$cmd"; then record skipped "$cmd"; continue; fi
    case $cmd in
      herdr) HERDR_INSTALL_DIR="$HOME/.local/bin" run_installer herdr https://herdr.dev/install.sh ;;
      uv) UV_INSTALL_DIR="$HOME/.local/bin" UV_NO_MODIFY_PATH=1 \
          run_installer uv https://astral.sh/uv/0.12.5/install.sh ;;
      # Unknown shell avoids Bun's bash/zsh/fish profile editing branches.
      bun) BUN_INSTALL="$HOME/.local" SHELL=/bin/false \
          run_installer bun https://bun.sh/install bun-v1.3.14 ;;
      claude) run_installer claude https://claude.ai/install.sh 2.1.306 ;;
    esac
    hash -r
    working "$cmd" || fail "verification failed: $cmd"
    record installed "$cmd"
  done
}
install_terraform() {
  local name="terraform_1.16.1_linux_$TF_ARCH.zip"
  if working terraform; then record skipped terraform; return; fi
  fetch "https://releases.hashicorp.com/terraform/1.16.1/$name" "$WORK/$name"
  fetch 'https://releases.hashicorp.com/terraform/1.16.1/terraform_1.16.1_SHA256SUMS' "$WORK/tf-sums"
  verify_archive "$name" tf-sums
  mkdir -p "$WORK/terraform"
  unzip -q "$WORK/$name" -d "$WORK/terraform"
  install -m 755 "$WORK/terraform/terraform" "$HOME/.local/bin/terraform"
  hash -r
  working terraform || fail 'verification failed: terraform'
  record installed terraform
}
make_env() {
  # Exact content is also the ownership/collision check: never overwrite an
  # unrelated env file (or follow a symlink to one).
  printf '%s\n' '# Managed by vm-bootstrap; source from interactive shells or SSH explicitly.'
  # shellcheck disable=SC2016 # Literal variables belong to the generated file.
  printf '%s\n' 'for _vm_path in "$HOME/.local/bin" "$HOME/.local/share/npm/bin" "$HOME/.local/lib/nodejs/node-v22.23.2-linux-'"$NODE_ARCH"'/bin"; do' \
    '  case ":$PATH:" in *":$_vm_path:"*) ;; *) PATH="$_vm_path:$PATH" ;; esac' \
    'done' 'unset _vm_path' 'export PATH'
}
setup_path() {
  # shellcheck disable=SC2016 # Literal source line, not this shell's HOME.
  local f line='[ ! -r "$HOME/.config/vm-bootstrap-env.sh" ] || . "$HOME/.config/vm-bootstrap-env.sh"'
  mkdir -p "$HOME/.config"
  if [[ -L $ENVFILE ]]; then
    fail "refusing symlink PATH file: $ENVFILE"
  elif [[ -e $ENVFILE ]]; then
    cmp -s <(make_env) "$ENVFILE" || fail "PATH file changed during bootstrap: $ENVFILE"
  else
    # noclobber also protects against a file created since preflight.
    (set -o noclobber; make_env > "$ENVFILE")
  fi
  for f in "$HOME/.profile" "$HOME/.bashrc"; do
    [[ ! -L $f ]] || fail "refusing to append to symlink: $f"
    if [[ -e $f ]]; then [[ -f $f && -w $f ]] || fail "not a writable regular file: $f"; fi
    if [[ ! -e $f ]] || ! grep -Fxq "$line" "$f"; then printf '\n%s\n' "$line" >> "$f"; fi
  done
}
apply() {
  check_host
  log 'Ensure HOME is on durable storage before proceeding; no credentials/configuration are copied.'
  mkdir -p "$HOME/.cache"
  # Keep the lock inode: deleting it would allow two concurrent owners.
  [[ ! -L $HOME/.cache/vm-bootstrap.lock ]] || fail 'refusing symlink lock file'
  exec 9>>"$HOME/.cache/vm-bootstrap.lock"
  flock -n 9 || fail 'another bootstrap is running'
  WORK=$(mktemp -d "$HOME/.cache/vm-bootstrap.XXXXXXXX")
  ENVFILE="$HOME/.config/vm-bootstrap-env.sh"
  if [[ -L $ENVFILE ]] || { [[ -e $ENVFILE ]] && ! cmp -s <(make_env) "$ENVFILE"; }; then
    fail "refusing to overwrite unrelated PATH file: $ENVFILE"
  fi
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/npm/bin"
  export PATH="$HOME/.local/lib/nodejs/node-v22.23.2-linux-$NODE_ARCH/bin:$HOME/.local/share/npm/bin:$HOME/.local/bin:$PATH"
  export DEBIAN_FRONTEND=noninteractive
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get update
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git gh ripgrep jq rsync curl ca-certificates unzip xz-utils build-essential pkg-config python3 python3-venv
  install_node
  install_npm_tool pnpm pnpm@9.15.9
  install_npm_tool pi @earendil-works/pi-coding-agent@1.3.0
  prepare_installer_runner
  install_native_tools
  if [[ $WITH_DOCKER == true ]]; then
    log 'Docker apt maintainer scripts may enable/start the daemon (explicit opt-in).'
    sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
    if ! working docker || ! docker compose version >/dev/null; then fail 'verification failed: Docker/Compose'; fi
    record installed docker
  fi
  if [[ $WITH_TERRAFORM == true ]]; then install_terraform; fi
  setup_path
  local cmd
  for cmd in git gh rg jq rsync curl node npm pnpm pi herdr uv bun claude python3; do
    working "$cmd" || fail "verification failed: $cmd"
  done
  node_sufficient || fail 'verification failed: Node >=22.19 required'
  log 'Complete; source ~/.config/vm-bootstrap-env.sh in noninteractive SSH commands. Authenticate manually.'
}
main() {
  set -Eeuo pipefail
  MODE=plan WITH_DOCKER=false WITH_TERRAFORM=false WORK=''
  INSTALLED=() SKIPPED=()
  local arg
  for arg in "$@"; do
    case $arg in
      --apply) MODE=apply ;;
      --dry-run) MODE=plan ;;
      --with-docker) WITH_DOCKER=true ;;
      --with-terraform) WITH_TERRAFORM=true ;;
      --help|-h) usage; return 0 ;;
      *) log "unknown option: $arg"; return 2 ;;
    esac
  done
  if [[ $MODE == plan ]]; then
    log 'Plan only: apt base tools; Node >=22.19 (fallback 22.23.2), pnpm 9.15.9, Pi 1.3.0, Herdr official latest stable, uv 0.12.5, Bun 1.3.14, Claude 2.1.306. Working tools are retained.'
    log "Optional Docker=$WITH_DOCKER; Terraform 1.16.1=$WITH_TERRAFORM. No mutations."
    summary planned
    return 0
  fi
  exec 8>&1
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # Redirect every external tool/installer's stdout; stdout is JSON only.
  apply >&2
  summary ok
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
