/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    AuthorizationCodeClient,
    AuthorizationUrlRequest,
    AuthorizationCodeRequest,
    ClientConfiguration,
    RefreshTokenClient,
    RefreshTokenRequest,
    AuthenticationResult,
    Authority,
    AuthorityFactory,
    ClientAuthError,
    Constants,
    B2cAuthority,
    CacheInterface,
    IAccount,
} from '@azure/msal-common';
import { Configuration, buildAppConfiguration } from '../config/Configuration';
import { CryptoProvider } from '../crypto/CryptoProvider';
import { Storage } from '../cache/Storage';
import { version } from '../../package.json';
import { Constants as NodeConstants } from './../utils/Constants';
import { CacheManager } from '../cache/CacheManager';

export abstract class ClientApplication {
    private config: Configuration;
    private _authority: Authority;
    private readonly cryptoProvider: CryptoProvider;
    private storage: Storage;
    private cacheManager: CacheManager;
    private cacheInterface: CacheInterface;

    /**
     * @constructor
     * Constructor for the ClientApplication
     */
    protected constructor(configuration: Configuration) {
        this.config = buildAppConfiguration(configuration);
        this.storage = new Storage();
        this.cacheManager = new CacheManager(
            this.storage,
            this.config.cache?.cachePlugin
        );

        this.cryptoProvider = new CryptoProvider();
        B2cAuthority.setKnownAuthorities(this.config.auth.knownAuthorities!);
    }

    /**
     * Initialize the cache interface for the user to get account information and remove account
     */
    async initializeCacheInterface() {
        const config = await this.buildOauthClientConfiguration();
        this.cacheInterface = new CacheInterface(config);
    }

    /**
     * Creates the URL of the authorization request letting the user input credentials and consent to the
     * application. The URL target the /authorize endpoint of the authority configured in the
     * application object.
     *
     * Once the user inputs their credentials and consents, the authority will send a response to the redirect URI
     * sent in the request and should contain an authorization code, which can then be used to acquire tokens via
     * acquireToken(AuthorizationCodeRequest)
     * @param request
     */
    async getAuthCodeUrl(request: AuthorizationUrlRequest): Promise<string> {
        const authClientConfig = await this.buildOauthClientConfiguration(
            request.authority
        );
        const authorizationCodeClient = new AuthorizationCodeClient(
            authClientConfig
        );
        return authorizationCodeClient.getAuthCodeUrl(request);
    }

    /**
     * Acquires a token by exchanging the Authorization Code received from the first step of OAuth2.0
     * Authorization Code flow.
     *
     * getAuthCodeUrl(AuthorizationCodeUrlRequest) can be used to create the URL for the first step of OAuth2.0
     * Authorization Code flow. Ensure that values for redirectUri and scopes in AuthorizationCodeUrlRequest and
     * AuthorizationCodeRequest are the same.
     *
     * @param request
     */
    async acquireTokenByCode(
        request: AuthorizationCodeRequest
    ): Promise<AuthenticationResult> {
        const authClientConfig = await this.buildOauthClientConfiguration(
            request.authority
        );
        const authorizationCodeClient = new AuthorizationCodeClient(
            authClientConfig
        );
        return authorizationCodeClient.acquireToken(request);
    }

    /**
     * Acquires a token by exchanging the refresh token provided for a new set of tokens.
     *
     * This API is provided only for scenarios where you would like to migrate from ADAL to MSAL. Instead, it is
     * recommended that you use acquireTokenSilent() for silent scenarios. When using acquireTokenSilent, MSAL will
     * handle the caching and refreshing of tokens automatically.
     * @param request
     */
    async acquireTokenByRefreshToken(
        request: RefreshTokenRequest
    ): Promise<AuthenticationResult> {
        const refreshTokenClientConfig = await this.buildOauthClientConfiguration(
            request.authority
        );
        const refreshTokenClient = new RefreshTokenClient(
            refreshTokenClientConfig
        );
        return refreshTokenClient.acquireToken(request);
    }

    protected async buildOauthClientConfiguration(
        authority?: string
    ): Promise<ClientConfiguration> {
        // using null assertion operator as we ensure that all config values have default values in buildConfiguration()
        return {
            authOptions: {
                clientId: this.config.auth.clientId,
                authority: await this.createAuthority(authority),
                knownAuthorities: this.config.auth.knownAuthorities,
            },
            loggerOptions: {
                loggerCallback: this.config.system!.loggerOptions!
                    .loggerCallback,
                piiLoggingEnabled: this.config.system!.loggerOptions!
                    .piiLoggingEnabled,
            },
            cryptoInterface: this.cryptoProvider,
            networkInterface: this.config.system!.networkClient,
            storageInterface: this.storage,
            libraryInfo: {
                sku: NodeConstants.MSAL_SKU,
                version: version,
                cpu: process.arch || '',
                os: process.platform || '',
            },
        };
    }

    getCacheManager(): CacheManager {
        return this.cacheManager;
    }

    /**
     * Create authority instance. If authority not passed in request, default to authority set on the application
     * object. If no authority set in application object, then default to common authority.
     * @param authorityString
     */
    private async createAuthority(
        authorityString?: string
    ): Promise<Authority> {
        const authority: Authority = authorityString
            ? AuthorityFactory.createInstance(
                authorityString,
                this.config.system!.networkClient!
            ) : this.authority;

        if (authority.discoveryComplete()) {
            return authority;
        }

        try {
            await authority.resolveEndpointsAsync();
            return authority;
        } catch (error) {
            throw ClientAuthError.createEndpointDiscoveryIncompleteError(error);
        }
    }

    private get authority() {
        if (this._authority) {
            return this._authority;
        }

        this._authority = AuthorityFactory.createInstance(
            this.config.auth.authority || Constants.DEFAULT_AUTHORITY,
            this.config.system!.networkClient!
        );

        return this._authority;
    }

    /**
    * Public API to get all accounts in the cache
    */
    getAllAccounts(): IAccount[] {
        return this.cacheInterface.getAllAccounts();
    }

    /**
    * Public API to remove a given account
    * @param account
    */
    removeAccount(account: IAccount) {
        return this.cacheInterface.removeAccount(account);
    }
}
