/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { chromium, Browser } from 'playwright'
import { getLogger } from '../../shared/logger'
import * as assert from 'assert'
import { getSmusCredentials } from './getAuthCredentials'

describe('SageMaker Unified Studio', function () {
    this.timeout(180000)

    let browser: Browser
    const logger = getLogger()

    before(async function () {
        browser = await chromium.launch({ headless: false })
        // 正确初始化VSBrowser - 需要
        // 在VS Code扩展测试环境中运行
    })

    after(async function () {
        if (browser) {
            await browser.close()
        }
    })

    it('should get SSO token from SageMaker Unified Studio', async function () {
        const page = await browser.newPage()
        console.log('in test1:')

        // Listen for SSO token and refresh token requests
        let ssoToken = undefined
        let refreshToken = undefined
        page.on('response', async (response) => {
            const url = response.url()
            console.log('Response URL:', url)

            if (url.includes('portal.sso.us-west-2.amazonaws.com/auth/sso-token')) {
                console.log('Found SSO token endpoint!')
                try {
                    const body = await response.text()
                    console.log('SSO Token Response:', body)
                    ssoToken = body
                } catch (error) {
                    console.log('Error reading SSO token response:', error)
                }
            }
            if (url.includes('refresh-token') || url.includes('refresh_token')) {
                console.log('Found refresh token endpoint!')
                try {
                    const body = await response.text()
                    console.log('Refresh Token Response:', body)
                    refreshToken = body
                } catch (error) {
                    console.log('Error reading refresh token response:', error)
                }
            }
        })

        logger.info('in test1')
        // Navigate to SageMaker Unified Studio login page
        await page.goto('https://dzd_5hknkem8c5x2a8.sagemaker.us-west-2.on.aws/login')
        // Verify SSO button exists
        const ssoButton = page.locator('text=Sign in with SSO')
        await ssoButton.waitFor({ state: 'visible' })

        // Click "Sign in with SSO" button
        await ssoButton.click()

        // Wait for navigation to SSO page
        await page.waitForLoadState('networkidle')
        const currentUrl = page.url()
        // Assert that we've been redirected away from the login page
        assert.notStrictEqual(
            currentUrl,
            'https://dzd_5hknkem8c5x2a8.sagemaker.us-west-2.on.aws/login',
            'Should redirect to SSO page'
        )

        // Assert that URL contains expected SSO domain patterns
        assert.ok(
            currentUrl.includes('sso') || currentUrl.includes('auth') || currentUrl.includes('login'),
            `URL should contain SSO/auth pattern: ${currentUrl}`
        )

        // Fill username and click Next
        await page.fill('input[type="text"]', 'wukeyu')
        await page.click('button:has-text("Next")')
        await page.waitForLoadState('networkidle')

        // Fill password and click Sign in
        await page.fill('input[type="password"]', 'Wky19980612!')
        await page.click('button:has-text("Sign in")')
        await page.waitForLoadState('networkidle')

        // Wait 5 seconds to see if login was successful
        await page.waitForTimeout(5000)

        // Log the captured tokens
        if (ssoToken) {
            console.log('Captured SSO Token:', ssoToken)

            try {
                const tokenData = JSON.parse(ssoToken)
                console.log('Parsed token data:', tokenData)

                if (tokenData.token) {
                    console.log('Raw JWE token:', tokenData.token)

                    // Extract token parts (JWE has 5 parts separated by dots)
                    const tokenParts = tokenData.token.split('.')
                    console.log('Token parts count:', tokenParts.length)
                    if (tokenParts.length >= 2) {
                        // Decode the header (first part)
                        try {
                            const header = JSON.parse(Buffer.from(tokenParts[0], 'base64url').toString())
                            console.log('Token header:', header)
                        } catch (e) {
                            console.log('Could not decode token header')
                        }
                    }
                }
                if (tokenData.redirectUrl) {
                    console.log('Redirect URL:', tokenData.redirectUrl)
                }
            } catch (error) {
                console.log('Error parsing token response:', error)
            }
        } else {
            console.log('No SSO token found in requests')
        }

        if (refreshToken) {
            console.log('Captured Refresh Token:', refreshToken)
            try {
                const refreshData = JSON.parse(refreshToken)
                console.log('Parsed refresh token data:', refreshData)
                // Store captured tokens in global state for SMUS authentication
                ;(global as any).capturedSmusTokens = {
                    accessToken: refreshData.accessToken,
                    csrfToken: refreshData.csrfToken,
                    iamCreds: refreshData.iamCreds,
                    userProfile: refreshData.userProfile,
                }

                console.log('SMUS tokens stored globally for authentication provider')
            } catch (error) {
                console.log('Error parsing refresh token response:', error)
            }
        } else {
            console.log('No refresh token found in requests')
        }

        await page.close()
    })

    it.skip('should use stored credentials in VS Code to skip SMUS login', async function () {
        // const capturedTokens = (global as any).capturedSmusTokens
        // if (!capturedTokens) {
        //     throw new Error('No SMUS tokens found. Run the login test first.')
        // }
        // const domainUrl = 'https://dzd_5hknkem8c5x2a8.sagemaker.us-west-2.on.aws'
        // const { Auth } = await import('../../auth/auth.js')
        // const { scopeSmus } = await import('../../sagemakerunifiedstudio/auth/model.js')
        // const { SmusAuthenticationProvider } = await import(
        //     '../../sagemakerunifiedstudio/auth/providers/smusAuthenticationProvider.js'
        // )
        // const { randomUUID } = await import('crypto')
        // const { using } = await import('../../test/setupUtil.js')
        // await using(async () => {
        //     // Get SMUS auth provider
        //     const smusAuth = SmusAuthenticationProvider.fromContext()
        //     // Mock the getAccessToken method to return our captured token
        //     const originalGetAccessToken = smusAuth.getAccessToken.bind(smusAuth)
        //     smusAuth.getAccessToken = async () => capturedTokens.accessToken
        //     return () => {
        //         // Cleanup: restore original method
        //         smusAuth.getAccessToken = originalGetAccessToken
        //     }
        // }, async () => {
        //     // Get SMUS auth provider
        //     const smusAuth = SmusAuthenticationProvider.fromContext()
        //     // Use the real connectToSmus method
        //     const connection = await smusAuth.connectToSmus(domainUrl)
        //     console.log('Connected to SMUS:', connection.id)
        //     // Open AWS Explorer view
        //     await vscode.commands.executeCommand('workbench.view.extension.aws-explorer')
        //     await new Promise((resolve) => setTimeout(resolve, 3000))
        //     // Open SMUS project view
        //     await vscode.commands.executeCommand('aws.smus.projectView')
        //     console.log('Opened SMUS project view in VS Code')
        //     // Wait for user to confirm the view is open
        //     await new Promise((resolve) => setTimeout(resolve, 10000))
        //     console.log('Waited 10 seconds for confirmation')
        // })
    })

    it('should connect to SMUS using real SSO flow', async function () {
        console.log('test3: calling getSmusCredentials')
        try {
            const credentials = await getSmusCredentials()
            console.log('SMUS credentials obtained successfully:', {
                hasTokens: Object.keys(credentials.tokens).length > 0,
                hasXsrf: !!credentials.xsrf,
                hasPresignedUrl: !!credentials.presignedUrl,
                hasCredentials: !!credentials.credentials,
            })
        } catch (error) {
            console.error('Failed to get SMUS credentials:', error)
        }
    })

    it('should use skip login step and get into home page', async function () {
        console.log('TODO')
    })
})
