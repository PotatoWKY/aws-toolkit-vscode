/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts'
import {
    DataZoneClient,
    ListEnvironmentBlueprintsCommand,
    ListEnvironmentsCommand,
    GetEnvironmentCredentialsCommand,
} from '@aws-sdk/client-datazone'
import { SageMakerClient, CreatePresignedDomainUrlCommand } from '@aws-sdk/client-sagemaker'
import fetch from 'cross-fetch'

const REGION = 'us-west-2'
const domainId = 'dzd_5hknkem8c5x2a8'
const projectId = 'bhzh72l5rwvqq8'
const userId = '68117300-f051-70c3-9d2e-62f9548c2c62'

// 1. assumeRole with tags
async function getTaggedAssumeRoleCredentials(roleArn: string, sessionName: string) {
    try {
        console.log('Creating STS client for region:', REGION)
        const sts = new STSClient({ region: REGION })

        console.log('AssumeRole parameters:', {
            RoleArn: roleArn,
            RoleSessionName: sessionName,
            Tags: [
                { Key: 'datazone-domainId', Value: domainId },
                { Key: 'datazone-userId', Value: userId },
            ],
        })

        const cmd = new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: sessionName,
            Tags: [
                { Key: 'datazone-domainId', Value: domainId },
                { Key: 'datazone-userId', Value: userId },
            ],
        })

        console.log('Sending AssumeRole command...')
        const res = await sts.send(cmd)

        if (!res.Credentials) {
            throw new Error('No credentials returned from AssumeRole')
        }

        console.log('AssumeRole successful, credentials received')
        return res.Credentials
    } catch (error) {
        console.error('AssumeRole failed:', error)
        throw error
    }
}

// 2. find default tooling environment
function findDefaultToolingEnvironment(environments: any[]) {
    const filtered = environments.filter((env) => (env as any).deploymentOrder !== undefined)
    if (filtered.length === 0) {
        return undefined
    }
    return filtered.reduce((a, b) => ((a as any).deploymentOrder < (b as any).deploymentOrder ? a : b))
}

async function getProjectDefaultToolingEnvironment(datazone: DataZoneClient) {
    console.log('Listing environment blueprints...')
    const blueprintsRes = await datazone.send(
        new ListEnvironmentBlueprintsCommand({
            domainIdentifier: domainId,
            managed: true,
            name: 'Tooling',
        })
    )
    const toolingBlueprints = blueprintsRes.items ?? []
    console.log('Found tooling blueprints:', toolingBlueprints.length)
    console.log(
        'Blueprint names:',
        toolingBlueprints.map((bp) => bp.name)
    )

    if (toolingBlueprints.length === 0) {
        throw new Error('Tooling environment blueprint not found')
    }

    const toolingEnvBlueprint = toolingBlueprints.find((bp) => bp.name === 'Tooling')
    if (!toolingEnvBlueprint) {
        throw new Error('Tooling blueprint not found')
    }
    console.log('Using tooling blueprint:', toolingEnvBlueprint.id)

    console.log('Listing environments for project...')
    const envsRes = await datazone.send(
        new ListEnvironmentsCommand({
            domainIdentifier: domainId,
            projectIdentifier: projectId,
            environmentBlueprintIdentifier: toolingEnvBlueprint.id,
        })
    )

    const toolingEnvs = envsRes.items ?? []
    console.log('Found tooling environments:', toolingEnvs.length)
    console.log(
        'Environment details:',
        toolingEnvs.map((env) => ({
            id: env.id,
            name: env.name,
            status: env.status,
        }))
    )

    const defaultEnv = findDefaultToolingEnvironment(toolingEnvs)
    if (defaultEnv) {
        console.log('Selected default environment:', defaultEnv.id)
        return defaultEnv
    }

    throw new Error('Default Tooling environment not found')
}

// 3. get SageMaker AI DomainId from provisioned resources
function getSagemakerAiDomainId(toolingEnv: any) {
    const res = toolingEnv.provisionedResources.find((r: any) => r.name === 'SageMakerSpacesDomain')
    if (!res) {
        throw new Error('SageMakerSpacesDomain not found')
    }
    return res.value
}

// 4. parse studio tokens
function parseStudioTokens(setCookie: string | undefined) {
    if (!setCookie) {
        return {}
    }
    const tokens: Record<string, string> = {}
    const regex = /(StudioAuthToken[01])=([^;]+)/g
    let match
    while ((match = regex.exec(setCookie)) !== null) {
        tokens[match[1]] = match[2]
    }
    return tokens
}

export async function getSmusCredentials() {
    console.log('Starting SMUS credentials retrieval...')
    try {
        // Step 1: assume role
        console.log('Step 1: Assuming role...')
        const creds = await getTaggedAssumeRoleCredentials(
            'arn:aws:iam::099100562013:role/service-role/AmazonSageMakerDomainExecution',
            `user-${userId}`
        )
        console.log('AssumeRole credentials obtained:', creds)
        // Step 2: init datazone client
        console.log('Step 2: Initializing DataZone client...')
        const datazone = new DataZoneClient({
            region: REGION,
            credentials: {
                accessKeyId: creds.AccessKeyId!,
                secretAccessKey: creds.SecretAccessKey!,
                sessionToken: creds.SessionToken,
            },
        })
        console.log('DataZone client initialized')

        console.log('Getting project default tooling environment...')
        const toolingEnv = await getProjectDefaultToolingEnvironment(datazone)
        console.log('Tooling environment found:', toolingEnv.id)

        console.log('Getting SageMaker AI Domain ID...')
        const smAIDomainId = getSagemakerAiDomainId(toolingEnv)
        console.log('SageMaker AI Domain ID:', smAIDomainId)

        // Step 3: get env credentials
        console.log('Step 3: Getting environment credentials...')
        const envCredsRes = await datazone.send(
            new GetEnvironmentCredentialsCommand({
                domainIdentifier: domainId,
                environmentIdentifier: toolingEnv.id,
            })
        )
        console.log('Environment credentials response keys:', Object.keys(envCredsRes))

        const envCreds = envCredsRes
        if (!envCreds) {
            throw new Error('No environment credentials returned')
        }
        console.log('Environment credentials obtained')

        if (!envCreds.accessKeyId || !envCreds.secretAccessKey || !envCreds.sessionToken) {
            console.log('Missing credential fields:', {
                hasAccessKeyId: !!envCreds.accessKeyId,
                hasSecretAccessKey: !!envCreds.secretAccessKey,
                hasSessionToken: !!envCreds.sessionToken,
            })
            throw new Error('Invalid environment credentials')
        }

        console.log('Initializing SageMaker client...')
        const sagemaker = new SageMakerClient({
            region: REGION,
            credentials: {
                accessKeyId: envCreds.accessKeyId,
                secretAccessKey: envCreds.secretAccessKey,
                sessionToken: envCreds.sessionToken,
            },
        })
        console.log('SageMaker client initialized')

        // Step 4: presigned URL
        console.log('Step 4: Creating presigned domain URL...')
        const urlRes = await sagemaker.send(
            new CreatePresignedDomainUrlCommand({
                DomainId: smAIDomainId,
                UserProfileName: userId,
                SpaceName: `default-${userId}`,
                LandingUri: 'app:JupyterLab:lab/tree/src/',
            })
        )
        const presignedUrl = urlRes.AuthorizedUrl!
        console.log('Presigned URL created:', presignedUrl.substring(0, 50) + '...')

        // Step 5: request and parse cookies
        console.log('Step 5: Fetching presigned URL to get cookies...')
        const response = await fetch(presignedUrl, { redirect: 'manual' })
        console.log('HTTP response status:', response.status)

        const setCookieHeader = response.headers.get('set-cookie') || ''
        console.log('Set-Cookie header length:', setCookieHeader.length)

        const xsrf = /_xsrf=([^;]+)/.exec(setCookieHeader)?.[1]
        console.log('XSRF token found:', !!xsrf)

        const tokens = parseStudioTokens(setCookieHeader)
        console.log('Studio tokens found:', Object.keys(tokens))

        console.log('SMUS credentials retrieval completed successfully')
        return {
            tokens,
            xsrf,
            presignedUrl,
            credentials: envCreds,
        }
    } catch (error) {
        console.error('Error in getSmusCredentials:', error)
        throw error
    }
}
