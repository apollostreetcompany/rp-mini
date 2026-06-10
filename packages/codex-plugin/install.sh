#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: packages/codex-plugin/install.sh [--write-config | --uninstall]

Installs rp-mini Codex skills under ~/.codex/skills/rp-mini-* and prints the MCP
TOML snippet for ~/.codex/config.toml. By default this script does not edit
config.toml. --write-config appends the snippet only when [mcp_servers.rp-mini]
is absent. --uninstall removes the installed rp-mini skill directories.
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="${SCRIPT_DIR}/skills"
CONFIG_SNIPPET="${SCRIPT_DIR}/config/mcp-servers.toml"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SERVER_CLI="${REPO_ROOT}/packages/server/dist/cli.js"

render_snippet() {
  sed "s|{{RP_MINI_SERVER_CLI}}|${SERVER_CLI}|g" "${CONFIG_SNIPPET}"
}
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
SKILLS_DEST="${CODEX_HOME}/skills"
CONFIG_FILE="${CODEX_HOME}/config.toml"
WRITE_CONFIG=0
UNINSTALL=0

for arg in "$@"; do
  case "${arg}" in
    --write-config)
      WRITE_CONFIG=1
      ;;
    --uninstall)
      UNINSTALL=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${WRITE_CONFIG}" -eq 1 && "${UNINSTALL}" -eq 1 ]]; then
  echo "--write-config and --uninstall cannot be used together" >&2
  exit 2
fi

remove_skills() {
  if [[ -d "${SKILLS_DEST}" ]]; then
    find "${SKILLS_DEST}" -maxdepth 1 -type d -name 'rp-mini-*' -exec rm -rf {} +
  fi
}

install_skills() {
  mkdir -p "${SKILLS_DEST}"
  for skill_dir in "${SKILLS_SRC}"/*; do
    [[ -d "${skill_dir}" ]] || continue
    skill_name="$(basename "${skill_dir}")"
    target="${SKILLS_DEST}/rp-mini-${skill_name}"
    rm -rf "${target}"
    mkdir -p "${target}"
    cp -R "${skill_dir}/." "${target}/"
  done
}

write_config() {
  mkdir -p "${CODEX_HOME}"
  touch "${CONFIG_FILE}"
  if grep -Eq '^\[mcp_servers\.rp-mini\]$' "${CONFIG_FILE}"; then
    echo "Config already contains [mcp_servers.rp-mini]; leaving ${CONFIG_FILE} unchanged."
    return
  fi
  {
    printf '\n'
    render_snippet
  } >>"${CONFIG_FILE}"
  echo "Appended [mcp_servers.rp-mini] to ${CONFIG_FILE}."
}

if [[ "${UNINSTALL}" -eq 1 ]]; then
  remove_skills
  echo "Removed rp-mini Codex skills from ${SKILLS_DEST}."
  exit 0
fi

install_skills

if [[ "${WRITE_CONFIG}" -eq 1 ]]; then
  write_config
fi

cat <<EOF
Installed rp-mini Codex skills into ${SKILLS_DEST} with rp-mini-* prefixes.

Merge this snippet into ${CONFIG_FILE}:

$(render_snippet)

To append it automatically when absent, rerun:
  ${SCRIPT_DIR}/install.sh --write-config

To uninstall skills:
  ${SCRIPT_DIR}/install.sh --uninstall
EOF
