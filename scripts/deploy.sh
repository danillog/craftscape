#!/usr/bin/env bash
# Publica o Craftscape na Hostinger via SSH (rsync), em danillogomes.com/craftscape/.
# Configuração em .env.deploy (veja .env.deploy.example).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.deploy ] || { echo "Falta o .env.deploy (copie de .env.deploy.example)."; exit 1; }
# shellcheck disable=SC1091
source .env.deploy

: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_PORT:=65002}" "${DEPLOY_PATH:?}"
DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_hostinger}"

# trava de segurança: o --delete só pode agir dentro da pasta craftscape
case "$DEPLOY_PATH" in
  */craftscape/) ;;
  *) echo "DEPLOY_PATH precisa terminar em /craftscape/ (está: $DEPLOY_PATH)"; exit 1 ;;
esac

npm run build

rsync -avz --delete \
  -e "ssh -p $DEPLOY_PORT -i $DEPLOY_KEY" \
  dist/ "$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH"

echo "Publicado: https://danillogomes.com/craftscape/"
