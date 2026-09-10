#!/usr/bin/env bash
set -euo pipefail

# Required env vars (export before running, or inline: VAR=val ./deploy.sh)
: "${ACR_NAME:?Set ACR_NAME - globally unique, alphanumeric, 5-50 chars}"
: "${STORAGE_ACCOUNT_NAME:?Set STORAGE_ACCOUNT_NAME - globally unique, lowercase alphanumeric, <=24 chars}"

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-migration-app}"
LOCATION="${LOCATION:-eastus}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
CORS_ALLOWED_ORIGINS_INITIAL="${CORS_ALLOWED_ORIGINS_INITIAL:-https://placeholder.azurecontainerapps.io}"
DEPLOYMENT_NAME="migration-app-$(date +%Y%m%d%H%M%S)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Creating resource group ${RESOURCE_GROUP} in ${LOCATION}"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

echo "==> Ensuring Azure Container Registry ${ACR_NAME} exists"
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  az acr create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$ACR_NAME" \
    --sku Standard \
    --admin-enabled false \
    --output none
fi

ACR_LOGIN_SERVER=$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)

echo "==> Building and pushing python-engine:${IMAGE_TAG}"
az acr build \
  --registry "$ACR_NAME" \
  --image "python-engine:${IMAGE_TAG}" \
  --image "python-engine:latest" \
  "${SCRIPT_DIR}/../backend-python"

echo "==> Building and pushing angular-frontend:${IMAGE_TAG}"
az acr build \
  --registry "$ACR_NAME" \
  --image "angular-frontend:${IMAGE_TAG}" \
  --image "angular-frontend:latest" \
  --file "${SCRIPT_DIR}/../frontend/Dockerfile.prod" \
  "${SCRIPT_DIR}/../frontend"

echo "==> Deploying infrastructure via Bicep"
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOYMENT_NAME" \
  --template-file "${SCRIPT_DIR}/main.bicep" \
  --parameters \
    acrName="$ACR_NAME" \
    storageAccountName="$STORAGE_ACCOUNT_NAME" \
    corsAllowedOrigins="$CORS_ALLOWED_ORIGINS_INITIAL" \
    frontendImage="${ACR_LOGIN_SERVER}/angular-frontend:${IMAGE_TAG}" \
    backendImage="${ACR_LOGIN_SERVER}/python-engine:${IMAGE_TAG}"

echo "==> Triggering Ollama model pull job"
az containerapp job start \
  --name ollama-pull \
  --resource-group "$RESOURCE_GROUP" \
  --output none

echo "==> Waiting for ollama-pull job to complete"
while true; do
  STATUS=$(az containerapp job execution list \
    --name ollama-pull \
    --resource-group "$RESOURCE_GROUP" \
    --query "[0].properties.status" -o tsv)
  echo "    status: ${STATUS}"
  if [[ "$STATUS" == "Succeeded" ]]; then
    break
  fi
  if [[ "$STATUS" == "Failed" ]]; then
    echo "ollama-pull job failed. Check logs with:"
    echo "  az containerapp job logs show --name ollama-pull --resource-group ${RESOURCE_GROUP}"
    exit 1
  fi
  sleep 10
done

FRONTEND_FQDN=$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOYMENT_NAME" \
  --query properties.outputs.frontendFqdn.value -o tsv)

echo "==> Patching backend CORS_ALLOWED_ORIGINS with the actual frontend URL"
az containerapp update \
  --name python-engine \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "CORS_ALLOWED_ORIGINS=https://${FRONTEND_FQDN}" \
  --output none

echo "==> Restarting backend to pick up new CORS config"
az containerapp revision restart \
  --name python-engine \
  --resource-group "$RESOURCE_GROUP" \
  --revision "$(az containerapp revision list --name python-engine --resource-group "$RESOURCE_GROUP" --query '[0].name' -o tsv)" \
  --output none

echo "==> Deployment complete"
echo "    Frontend: https://${FRONTEND_FQDN}"