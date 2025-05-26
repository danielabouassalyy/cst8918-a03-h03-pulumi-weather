/* File: infrastructure/index.ts */
// Load environment variables from .env
import "dotenv/config";

import * as pulumi from '@pulumi/pulumi';
import * as resources from '@pulumi/azure-native/resources';
import * as containerregistry from '@pulumi/azure-native/containerregistry';
import * as containerinstance from '@pulumi/azure-native/containerinstance';
import * as dockerBuild from '@pulumi/docker-build';
import * as redisCache from '@pulumi/azure-native/redis';
import type { ListRedisKeysResult } from '@pulumi/azure-native/redis';

// 1) Grab your OpenWeather API key via Pulumi
const config       = new pulumi.Config();
const apiKeySecret = config.requireSecret('weatherApiKey');

// 2) Load your other Pulumi config values
const appPath       = config.require('appPath');
const prefixName    = config.require('prefixName');
const imageTag      = config.require('imageTag');
const containerPort = config.requireNumber('containerPort');
const publicPort    = config.requireNumber('publicPort');
const cpu           = config.requireNumber('cpu');
const memory        = config.requireNumber('memory');

// 3) Read Azure location
const azureCfg = new pulumi.Config('azure-native');
const location = azureCfg.require('location');

// 4) Resource Group
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`, { location });

// 5) Container Registry
const registry = new containerregistry.Registry(`${prefixName}ACR`, {
    registryName:      prefixName.replace(/-/g, ''),
    resourceGroupName: resourceGroup.name,
    sku:               { name: containerregistry.SkuName.Basic },
    adminUserEnabled:  true,
});
const creds = containerregistry.listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName:      registry.name,
}).apply((c: any) => ({ username: c.username!, password: c.passwords![0].value! }));

// 6) Build & Push your Docker Image
const image = new dockerBuild.Image(`${prefixName}-img`, {
    context:    { location: appPath },
    dockerfile: { location: `${appPath}/Dockerfile` },
    tags:       [pulumi.interpolate`${registry.loginServer}/${prefixName}:${imageTag}`],
    platforms:  ['linux/amd64'],
    push:       true,
    registries: [{
      address:  registry.loginServer,
      username: creds.username,
      password: creds.password,
    }],
});

// ───────────── Part Two: Redis cache ─────────────

// 7) Create a managed Azure Cache for Redis
const redisInstance = new redisCache.Redis(`${prefixName}-redis`, {
    resourceGroupName: resourceGroup.name,
    name:              `${prefixName}-weather-cache`,
    location:          resourceGroup.location,
    enableNonSslPort:  true,
    sku:               { name: 'Basic', family: 'C', capacity: 0 },
});

// 8) Extract its primary key
const redisKeys = redisCache.listRedisKeysOutput({
    name:              redisInstance.name,
    resourceGroupName: resourceGroup.name,
});
const redisAccessKey = redisKeys.apply((k: ListRedisKeysResult) => k.primaryKey);

// 9) Build the REDIS_URL connection string
const redisConnectionString = pulumi.interpolate`redis://:${redisAccessKey}@${redisInstance.hostName}:6379`;

// ───────────── Back to your ACI group ─────────────

// 10) Create the Container Group, injecting both secrets and exact image reference
const containerGroup = new containerinstance.ContainerGroup(`${prefixName}-cg`, {
    resourceGroupName: resourceGroup.name,
    osType:            'Linux',
    restartPolicy:     'Always',
    imageRegistryCredentials: [{
      server:   registry.loginServer,
      username: creds.username,
      password: creds.password,
    }],
    containers: [{
      name:    prefixName,
      image:   image.ref,         // exact digest reference
      resources: {
        requests: { cpu, memoryInGB: memory },
      },
      environmentVariables: [
        { name: 'WEATHER_API_KEY', value: apiKeySecret },
        { name: 'REDIS_URL',        value: redisConnectionString },
      ],
      ports:   [{ port: publicPort, protocol: 'TCP' }],
    }],
    ipAddress: {
      type:         containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: prefixName,
      ports:        [{ port: publicPort, protocol: 'TCP' }],
    },
});

// 11) Export your URL
export const url = containerGroup.ipAddress.apply(i => `http://${i!.fqdn!}:${publicPort}`);
