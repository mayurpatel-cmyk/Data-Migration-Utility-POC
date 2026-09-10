@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Name of the Azure Container Registry (5-50 alphanumeric chars, globally unique)')
param acrName string

@description('Name of the Log Analytics workspace')
param logAnalyticsName string = 'law-migration-app'

@description('Name of the Container Apps managed environment')
param environmentName string = 'cae-migration'

@description('Name of the storage account backing Ollama model persistence (3-24 lowercase alphanumeric, globally unique)')
param storageAccountName string

@description('Azure Files share name for Ollama model data')
param fileShareName string = 'ollama-data'

@description('Embedding model to pull into Ollama')
param embeddingModel string = 'mxbai-embed-large'

@description('Comma-separated list of allowed CORS origins for the backend')
param corsAllowedOrigins string

@description('Full ACR image reference for the frontend, e.g. myacr.azurecr.io/angular-frontend:latest')
param frontendImage string

@description('Full ACR image reference for the backend, e.g. myacr.azurecr.io/python-engine:latest')
param backendImage string

@description('Ollama base image')
param ollamaImage string = 'ollama/ollama:latest'

var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-acr-pull'
  location: location
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, uami.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    shareQuota: 50
    enabledProtocols: 'SMB'
  }
}

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2023-05-02-preview' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2023-05-02-preview' = {
  parent: containerAppsEnv
  name: 'ollama-storage'
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [
    fileShare
  ]
}

resource ollamaApp 'Microsoft.App/containerApps@2023-05-02-preview' = {
  name: 'ollama'
  location: location
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      ingress: {
        external: false
        targetPort: 11434
        transport: 'tcp'
      }
    }
    template: {
      containers: [
        {
          name: 'ollama'
          image: ollamaImage
          resources: {
            cpu: json('2.0')
            memory: '4Gi'
          }
          volumeMounts: [
            {
              volumeName: 'ollama-data'
              mountPath: '/root/.ollama'
            }
          ]
          probes: [
            {
              type: 'Readiness'
              tcpSocket: {
                port: 11434
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 5
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'ollama-data'
          storageType: 'AzureFile'
          storageName: envStorage.name
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource ollamaPullJob 'Microsoft.App/jobs@2023-05-02-preview' = {
  name: 'ollama-pull'
  location: location
  properties: {
    environmentId: containerAppsEnv.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 900
      replicaRetryLimit: 2
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: 'ollama-pull'
          image: ollamaImage
          command: [
            'sh'
            '-c'
            'ollama pull ${embeddingModel}'
          ]
          env: [
            {
              name: 'OLLAMA_HOST'
              value: '${ollamaApp.name}.internal.${containerAppsEnv.properties.defaultDomain}:11434'
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

resource backendApp 'Microsoft.App/containerApps@2023-05-02-preview' = {
  name: 'python-engine'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      registries: [
        {
          server: acr.properties.loginServer
          identity: uami.id
        }
      ]
      ingress: {
        external: false
        targetPort: 8000
        transport: 'http'
      }
    }
    template: {
      containers: [
        {
          name: 'python-engine'
          image: backendImage
          env: [
            {
              name: 'FASTAPI_ENV'
              value: 'production'
            }
            {
              name: 'OLLAMA_BASE_URL'
              value: 'http://${ollamaApp.name}.internal.${containerAppsEnv.properties.defaultDomain}:11434/api'
            }
            {
              name: 'EMBEDDING_MODEL'
              value: embeddingModel
            }
            {
              name: 'CORS_ALLOWED_ORIGINS'
              value: corsAllowedOrigins
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8000
              }
              initialDelaySeconds: 15
              periodSeconds: 10
              failureThreshold: 5
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8000
              }
              initialDelaySeconds: 20
              periodSeconds: 15
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    acrPullAssignment
    ollamaApp
  ]
}

resource frontendApp 'Microsoft.App/containerApps@2023-05-02-preview' = {
  name: 'angular-frontend'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      registries: [
        {
          server: acr.properties.loginServer
          identity: uami.id
        }
      ]
      ingress: {
        external: true
        targetPort: 80
        transport: 'http'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'angular-frontend'
          image: frontendImage
          env: [
            {
              name: 'BACKEND_HOST'
              value: '${backendApp.name}.internal.${containerAppsEnv.properties.defaultDomain}'
            }
            {
              name: 'BACKEND_PORT'
              value: '80'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 80
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    acrPullAssignment
    backendApp
  ]
}

output acrLoginServer string = acr.properties.loginServer
output frontendFqdn string = frontendApp.properties.configuration.ingress.fqdn
output backendInternalFqdn string = '${backendApp.name}.internal.${containerAppsEnv.properties.defaultDomain}'
output ollamaJobName string = ollamaPullJob.name
