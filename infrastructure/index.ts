// Load environment variables from .env
import "dotenv/config";

import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as containerinstance from "@pulumi/azure-native/containerinstance";
import * as dockerBuild from "@pulumi/docker-build";

// 1) Grab your OpenWeather API key from the environment
const apiKey = process.env.WEATHER_API_KEY!;
if (!apiKey) {
    throw new Error("Missing WEATHER_API_KEY in environment (.env)");
}

// 2) Load Pulumi config values
const config        = new pulumi.Config();
const appPath       = config.require("appPath");
const prefixName    = config.require("prefixName");
const imageTag      = config.require("imageTag");
const containerPort = config.requireNumber("containerPort");
const publicPort    = config.requireNumber("publicPort");
const cpu           = config.requireNumber("cpu");
const memory        = config.requireNumber("memory");

// 3) Read Azure location from azure-native config
const azureConfig = new pulumi.Config("azure-native");
const location    = azureConfig.require("location");

// 4) Create a Resource Group in the specified location
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`, { location });

// 5) Sanitize registry name (only alphanumeric) and create ACR
const registryName = prefixName.replace(/-/g, "");
const registry = new containerregistry.Registry(`${prefixName}ACR`, {
    registryName:      registryName,
    resourceGroupName: resourceGroup.name,
    adminUserEnabled:  true,
    sku: { name: containerregistry.SkuName.Basic },
});

// 6) Fetch ACR credentials
const creds = containerregistry
    .listRegistryCredentialsOutput({ resourceGroupName: resourceGroup.name, registryName: registry.name })
    .apply(c => ({ username: c.username!, password: c.passwords![0].value! }));

// 7) Build & push the Docker image to ACR (amd64 only for speed)
const image = new dockerBuild.Image(`${prefixName}-img`, {
    context:    { location: appPath },
    dockerfile: { location: `${appPath}/Dockerfile` },
    tags:       [pulumi.interpolate`${registry.loginServer}/${prefixName}:${imageTag}`],
    platforms:  ["linux/amd64"],
    push:       true,
    registries: [{ address: registry.loginServer, username: creds.username, password: creds.password }],
});

// 8) Create an Azure Container Instances (ACI) container group
const containerGroup = new containerinstance.ContainerGroup(`${prefixName}-cg`, {
    resourceGroupName: resourceGroup.name,
    osType:            "linux",
    restartPolicy:     "always",
    imageRegistryCredentials: [{ server: registry.loginServer, username: creds.username, password: creds.password }],
    containers: [{
        name:     prefixName,
        image:    image.ref,
        ports:    [{ port: containerPort, protocol: "tcp" }],
        environmentVariables: [
            { name: "WEATHER_API_KEY", value: apiKey },
            { name: "PORT",            value: `${containerPort}` },
        ],
        resources: { requests: { cpu, memoryInGB: memory } },
    }],
    ipAddress: {
        type:         containerinstance.ContainerGroupIpAddressType.Public,
        dnsNameLabel: prefixName,
        ports:        [{ port: publicPort, protocol: "tcp" }],
    },
});

// 9) Export outputs
export const hostname = containerGroup.ipAddress.apply(i => i!.fqdn!);
export const ip       = containerGroup.ipAddress.apply(i => i!.ip!);
export const url      = containerGroup.ipAddress.apply(i => `http://${i!.fqdn!}:${publicPort}`);
