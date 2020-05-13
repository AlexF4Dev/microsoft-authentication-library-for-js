/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import { BaseClient } from "./BaseClient";
import { ClientConfiguration } from "../config/ClientConfiguration";
import { AuthenticationParameters } from "../request/AuthenticationParameters";
import { TokenExchangeParameters } from "../request/TokenExchangeParameters";
import { TokenRenewParameters } from "../request/TokenRenewParameters";
import { ServerTokenRequestParameters } from "../server/ServerTokenRequestParameters";
import { CodeResponse } from "../response/CodeResponse";
import { TokenResponse } from "../response/TokenResponse";
import { ResponseHandler } from "../response/ResponseHandler";
import { ServerAuthorizationCodeResponse } from "../server/ServerAuthorizationCodeResponse";
import { ServerAuthorizationTokenResponse } from "../server/ServerAuthorizationTokenResponse";
import { ClientAuthError } from "../error/ClientAuthError";
import { ClientConfigurationError } from "../error/ClientConfigurationError";
import { AccessTokenCacheItem } from "../cache/AccessTokenCacheItem";
import { AuthorityFactory } from "../authority/AuthorityFactory";
import { IdToken } from "../account/IdToken";
import { ScopeSet } from "../request/ScopeSet";
import { TemporaryCacheKeys, PersistentCacheKeys, AADServerParamKeys, Constants } from "../utils/Constants";
import { TimeUtils } from "../utils/TimeUtils";
import { StringUtils } from "../utils/StringUtils";
import { UrlString } from "../url/UrlString";
import { Account } from "../account/Account";
import { buildClientInfo } from "../account/ClientInfo";
import { B2cAuthority } from "../authority/B2cAuthority";
import { RequestParameterBuilder } from "../server/RequestParameterBuilder";
import { RequestValidator } from "../request/RequestValidator";
import { ProtocolUtils } from '../utils/ProtocolUtils';
import { PkceCodes } from '../crypto/ICrypto';

/**
 * SPAClient class
 *
 * Object instance which will construct requests to send to and handle responses
 * from the Microsoft STS using the authorization code flow.
 */
export class SPAClient extends BaseClient {

    constructor(configuration: ClientConfiguration) {
        // Implement base module
        super(configuration);

        // Initialize default authority instance
        B2cAuthority.setKnownAuthorities(this.config.authOptions.knownAuthorities);
    }

    /**
     * Creates a url for logging in a user. This will by default append the client id to the list of scopes,
     * allowing you to retrieve an id token in the subsequent code exchange. Also performs validation of the request parameters.
     * Including any SSO parameters (account, sid, login_hint) will short circuit the authentication and allow you to retrieve a code without interaction.
     * @param request
     */
    async createLoginUrl(request: AuthenticationParameters): Promise<string> {
        return this.createUrl(request, true);
    }

    /**
     * Creates a url for logging in a user. Also performs validation of the request parameters.
     * Including any SSO parameters (account, sid, login_hint) will short circuit the authentication and allow you to retrieve a code without interaction.
     * @param request
     */
    async createAcquireTokenUrl(request: AuthenticationParameters): Promise<string> {
        return this.createUrl(request, false);
    }

    /**
     * Helper function which creates URL. If isLoginCall is true, MSAL appends client id scope to retrieve id token from the service.
     * @param request
     * @param isLoginCall
     */
    private async createUrl(request: AuthenticationParameters, isLoginCall: boolean): Promise<string> {
        // Initialize authority or use default, and perform discovery endpoint check.
        const acquireTokenAuthority = (request && request.authority) ? AuthorityFactory.createInstance(request.authority, this.networkClient) : this.defaultAuthority;
        try {
            await acquireTokenAuthority.resolveEndpointsAsync();
        } catch (e) {
            throw ClientAuthError.createEndpointDiscoveryIncompleteError(e);
        }

        const parameterBuilder = new RequestParameterBuilder();

        parameterBuilder.addClientId(this.config.authOptions.clientId);

        // Set scopes, append extra scopes if there is a login call.
        const scopeset = new ScopeSet(
            (request && request.scopes) || [],
            this.config.authOptions.clientId,
            !isLoginCall
        );
        if (isLoginCall) {
            scopeset.appendScopes(request && request.extraScopesToConsent);
        }
        parameterBuilder.addScopes(scopeset);

        // validate the redirectUri (to be a non null value)
        RequestValidator.validateRedirectUri(this.getRedirectUri());
        parameterBuilder.addRedirectUri(this.getRedirectUri());

        // generate the correlationId if not set by the user and add
        const correlationId = (request && request.correlationId) || this.config.cryptoInterface.createNewGuid();
        parameterBuilder.addCorrelationId(correlationId);

        // add response_mode. If not passed in it defaults to query.
        parameterBuilder.addResponseMode(`${Constants.FRAGMENT_RESPONSE_MODE}`);

        // add response_type = code
        parameterBuilder.addResponseTypeCode();

        // add code challenge
        const generatedPkce: PkceCodes = await this.config.cryptoInterface.generatePkceCodes();
        parameterBuilder.addCodeChallengeParams(generatedPkce.challenge, `${Constants.S256_CODE_CHALLENGE_METHOD}`);

        // generate state
        const state = ProtocolUtils.setRequestState(
            request && request.userRequestState,
            this.config.cryptoInterface.createNewGuid()
        );
        parameterBuilder.addState(state);

        // add prompt
        if (request && request.prompt) {
            RequestValidator.validatePrompt(request.prompt);
            parameterBuilder.addPrompt(request.prompt);
        }

        // add login_hint
        // TODO: Are we supporting adal -> msal 2.0 migration?
        if (request) {
            const loginHint: string =
                request.account && request.account.userName
                    ? request.account.userName
                    : request.loginHint ? request.loginHint : "";
            parameterBuilder.addLoginHint(loginHint);
        }

        // add nonce
        parameterBuilder.addNonce(this.config.cryptoInterface.createNewGuid());

        // add extraQueryParams
        parameterBuilder.addExtraQueryParameters(request && request.extraQueryParameters);

        // TODO: Add explicit support for DOMAIN_HINT, break it from extraQueryParams; fixes with common request for node and browser
        // TODO: Add a PR to remove "resource" support altogether
        // TODO: Add `extraQueryParameters` support in node
        // TODO: Why are we not adding LibraryInfo for /authorize endpoint?

        return parameterBuilder.createQueryString();
    }

    /**
     * Given an authorization code, it will perform a token exchange using cached values from a previous call to
     * createLoginUrl() or createAcquireTokenUrl(). You must call this AFTER using one of those APIs first. You should
     * also use the handleFragmentResponse() API to pass the codeResponse to this function afterwards.
     * @param codeResponse
     */
    async acquireToken(codeResponse: CodeResponse): Promise<TokenResponse> {
        try {
            // If no code response is given, we cannot acquire a token.
            if (!codeResponse || StringUtils.isEmpty(codeResponse.code)) {
                throw ClientAuthError.createTokenRequestCannotBeMadeError();
            }

            // Get request from cache
            const tokenRequest: TokenExchangeParameters = this.getCachedRequest(codeResponse.userRequestState);

            // Initialize authority or use default, and perform discovery endpoint check.
            const acquireTokenAuthority = (tokenRequest && tokenRequest.authority) ? AuthorityFactory.createInstance(tokenRequest.authority, this.networkClient) : this.defaultAuthority;
            if (!acquireTokenAuthority.discoveryComplete()) {
                try {
                    await acquireTokenAuthority.resolveEndpointsAsync();
                } catch (e) {
                    throw ClientAuthError.createEndpointDiscoveryIncompleteError(e);
                }
            }

            // Get token endpoint.
            const { tokenEndpoint } = acquireTokenAuthority;
            // Initialize request parameters.
            const tokenReqParams = new ServerTokenRequestParameters(
                this.config.authOptions.clientId,
                tokenRequest,
                codeResponse,
                this.getRedirectUri(),
                this.cryptoUtils
            );

            // User helper to retrieve token response.
            // Need to await function call before return to catch any thrown errors.
            // if errors are thrown asynchronously in return statement, they are caught by caller of this function instead.
            return await this.getTokenResponse(tokenEndpoint, tokenReqParams, tokenRequest, codeResponse);
        } catch (e) {
            // Reset cache items and set account to null before re-throwing.
            this.cacheManager.resetTempCacheItems(codeResponse && codeResponse.userRequestState);
            this.account = null;
            throw e;
        }
    }

    /**
     * Retrieves a token from cache if it is still valid, or uses the cached refresh token to renew
     * the given token and returns the renewed token. Will throw an error if login is not completed (unless
     * id tokens are not being renewed).
     * @param request
     */
    async getValidToken(request: TokenRenewParameters): Promise<TokenResponse> {
        try {
            // Cannot renew token if no request object is given.
            if (!request) {
                throw ClientConfigurationError.createEmptyTokenRequestError();
            }

            // Get account object for this request.
            const account = request.account || this.getAccount();
            const requestScopes = new ScopeSet(request.scopes || [], this.config.authOptions.clientId, true);
            // If this is an id token renewal, and no account is present, throw an error.
            if (requestScopes.isLoginScopeSet()) {
                if (!account) {
                    throw ClientAuthError.createUserLoginRequiredError();
                }
            }

            // Initialize authority or use default, and perform discovery endpoint check.
            const acquireTokenAuthority = request.authority ? AuthorityFactory.createInstance(request.authority, this.networkClient) : this.defaultAuthority;
            if (!acquireTokenAuthority.discoveryComplete()) {
                try {
                    await acquireTokenAuthority.resolveEndpointsAsync();
                } catch (e) {
                    throw ClientAuthError.createEndpointDiscoveryIncompleteError(e);
                }
            }

            // Get current cached tokens
            const cachedTokenItem = this.getCachedTokens(requestScopes, acquireTokenAuthority.canonicalAuthority, request.resource, account && account.homeAccountIdentifier);
            const expirationSec = Number(cachedTokenItem.value.expiresOnSec);
            const offsetCurrentTimeSec = TimeUtils.nowSeconds() + this.config.systemOptions.tokenRenewalOffsetSeconds;
            // Check if refresh is forced, or if tokens are expired. If neither are true, return a token response with the found token entry.
            if (!request.forceRefresh && expirationSec && expirationSec > offsetCurrentTimeSec) {
                const cachedScopes = ScopeSet.fromString(cachedTokenItem.key.scopes, this.config.authOptions.clientId, true);
                const defaultTokenResponse: TokenResponse = {
                    uniqueId: "",
                    tenantId: "",
                    scopes: cachedScopes.asArray(),
                    tokenType: cachedTokenItem.value.tokenType,
                    idToken: "",
                    idTokenClaims: null,
                    accessToken: cachedTokenItem.value.accessToken,
                    refreshToken: cachedTokenItem.value.refreshToken,
                    expiresOn: new Date(expirationSec * 1000),
                    account: account,
                    userRequestState: ""
                };

                // Only populate id token if it exists in cache item.
                return StringUtils.isEmpty(cachedTokenItem.value.idToken) ? defaultTokenResponse :
                    ResponseHandler.setResponseIdToken(defaultTokenResponse, new IdToken(cachedTokenItem.value.idToken, this.cryptoUtils));
            } else {
                // Renew the tokens.
                request.authority = cachedTokenItem.key.authority;
                const { tokenEndpoint } = acquireTokenAuthority;

                return this.renewToken(request, tokenEndpoint, cachedTokenItem.value.refreshToken);
            }
        } catch (e) {
            // Reset cache items and set account to null before re-throwing.
            this.cacheManager.resetTempCacheItems();
            this.account = null;
            throw e;
        }
    }

    // #region Logout

    /**
     * Use to log out the current user, and redirect the user to the postLogoutRedirectUri.
     * Default behaviour is to redirect the user to `window.location.href`.
     * @param authorityUri
     */
    async logout(authorityUri?: string): Promise<string> {
        const currentAccount = this.getAccount();
        // Check for homeAccountIdentifier. Do not send anything if it doesn't exist.
        const homeAccountIdentifier = currentAccount ? currentAccount.homeAccountIdentifier : "";
        // Remove all pertinent access tokens.
        this.cacheManager.removeAllAccessTokens(this.config.authOptions.clientId, authorityUri, "", homeAccountIdentifier);
        // Clear remaining cache items.
        this.cacheStorage.clear();
        // Clear current account.
        this.account = null;
        // Get postLogoutRedirectUri.
        let postLogoutRedirectUri = "";
        try {
            postLogoutRedirectUri = `?${AADServerParamKeys.POST_LOGOUT_URI}=` + encodeURIComponent(this.getPostLogoutRedirectUri());
        } catch (e) {}

        // Acquire token authorities.
        const acquireTokenAuthority = (authorityUri) ? AuthorityFactory.createInstance(authorityUri, this.networkClient) : this.defaultAuthority;
        if (!acquireTokenAuthority.discoveryComplete()) {
            try {
                await acquireTokenAuthority.resolveEndpointsAsync();
            } catch (e) {
                throw ClientAuthError.createEndpointDiscoveryIncompleteError(e);
            }
        }

        // Construct logout URI.
        const logoutUri = `${acquireTokenAuthority.endSessionEndpoint}${postLogoutRedirectUri}`;
        return logoutUri;
    }

    // #endregion

    // #region Response Handling

    /**
     * Handles the hash fragment response from public client code request. Returns a code response used by
     * the client to exchange for a token in acquireToken.
     * @param hashFragment
     */
    public handleFragmentResponse(hashFragment: string): CodeResponse {
        // Handle responses.
        const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheStorage, this.cacheManager, this.cryptoUtils, this.logger);
        // Deserialize hash fragment response parameters.
        const hashUrlString = new UrlString(hashFragment);
        const serverParams = hashUrlString.getDeserializedHash<ServerAuthorizationCodeResponse>();
        // Get code response
        return responseHandler.handleServerCodeResponse(serverParams);
    }

    // #endregion

    // #region Helpers

    /**
     * Clears cache of items related to current request.
     */
    public cancelRequest(): void {
        const cachedState = this.cacheStorage.getItem(TemporaryCacheKeys.REQUEST_STATE);
        this.cacheManager.resetTempCacheItems(cachedState || "");
    }

    /**
     * Gets the token exchange parameters from the cache. Throws an error if nothing is found.
     */
    private getCachedRequest(state: string): TokenExchangeParameters {
        try {
            // Get token request from cache and parse as TokenExchangeParameters.
            const encodedTokenRequest = this.cacheStorage.getItem(TemporaryCacheKeys.REQUEST_PARAMS);
            const parsedRequest = JSON.parse(this.cryptoUtils.base64Decode(encodedTokenRequest)) as TokenExchangeParameters;
            this.cacheStorage.removeItem(TemporaryCacheKeys.REQUEST_PARAMS);
            // Get cached authority and use if no authority is cached with request.
            if (StringUtils.isEmpty(parsedRequest.authority)) {
                const authorityKey: string = this.cacheManager.generateAuthorityKey(state);
                const cachedAuthority: string = this.cacheStorage.getItem(authorityKey);
                parsedRequest.authority = cachedAuthority;
            }
            return parsedRequest;
        } catch (err) {
            throw ClientAuthError.createTokenRequestCacheError(err);
        }
    }

    /**
     * Gets all cached tokens based on the given criteria.
     * @param requestScopes
     * @param authorityUri
     * @param resourceId
     * @param homeAccountIdentifier
     */
    private getCachedTokens(requestScopes: ScopeSet, authorityUri: string, resourceId: string, homeAccountIdentifier: string): AccessTokenCacheItem {
        // Get all access tokens with matching authority, resource id and home account ID
        const tokenCacheItems: Array<AccessTokenCacheItem> = this.cacheManager.getAllAccessTokens(this.config.authOptions.clientId, authorityUri || "", resourceId || "", homeAccountIdentifier || "");
        if (tokenCacheItems.length === 0) {
            throw ClientAuthError.createNoTokensFoundError(requestScopes.printScopes());
        }

        // Filter cache items based on available scopes.
        const filteredCacheItems: Array<AccessTokenCacheItem> = tokenCacheItems.filter(cacheItem => {
            const cachedScopes = ScopeSet.fromString(cacheItem.key.scopes, this.config.authOptions.clientId, true);
            return cachedScopes.containsScopeSet(requestScopes);
        });

        // If cache items contains too many matching tokens, throw error.
        if (filteredCacheItems.length > 1) {
            throw ClientAuthError.createMultipleMatchingTokensInCacheError(requestScopes.printScopes());
        } else if (filteredCacheItems.length === 1) {
            // Return single cache item.
            return filteredCacheItems[0];
        }
        // If cache items are empty, throw error.
        throw ClientAuthError.createNoTokensFoundError(requestScopes.printScopes());
    }

    /**
     * Makes a request to the token endpoint with the given parameters and parses the response.
     * @param tokenEndpoint
     * @param tokenReqParams
     * @param tokenRequest
     * @param codeResponse
     */
    private async getTokenResponse(tokenEndpoint: string, tokenReqParams: ServerTokenRequestParameters, tokenRequest: TokenExchangeParameters, codeResponse?: CodeResponse): Promise<TokenResponse> {
        // Perform token request.
        const acquiredTokenResponse = await this.networkClient.sendPostRequestAsync<ServerAuthorizationTokenResponse>(
            tokenEndpoint,
            {
                body: tokenReqParams.createRequestBody(),
                headers: tokenReqParams.createRequestHeaders()
            }
        );

        // Create response handler
        const responseHandler = new ResponseHandler(this.config.authOptions.clientId, this.cacheStorage, this.cacheManager, this.cryptoUtils, this.logger);
        // Validate response. This function throws a server error if an error is returned by the server.
        responseHandler.validateServerAuthorizationTokenResponse(acquiredTokenResponse.body);
        // Return token response with given parameters
        const tokenResponse = responseHandler.createTokenResponse(acquiredTokenResponse.body, tokenRequest.authority, tokenRequest.resource, codeResponse && codeResponse.userRequestState);
        // Set current account to received response account, if any.
        this.account = tokenResponse.account;
        return tokenResponse;
    }

    /**
     * Creates refreshToken request and sends to given token endpoint.
     * @param refreshTokenRequest
     * @param tokenEndpoint
     * @param refreshToken
     */
    private async renewToken(refreshTokenRequest: TokenRenewParameters, tokenEndpoint: string, refreshToken: string): Promise<TokenResponse> {
        // Initialize request parameters.
        const tokenReqParams = new ServerTokenRequestParameters(
            this.config.authOptions.clientId,
            refreshTokenRequest,
            null,
            this.getRedirectUri(),
            this.cryptoUtils,
            refreshToken
        );

        // User helper to retrieve token response.
        // Need to await function call before return to catch any thrown errors.
        // if errors are thrown asynchronously in return statement, they are caught by caller of this function instead.
        return await this.getTokenResponse(tokenEndpoint, tokenReqParams, refreshTokenRequest);
    }

    // #endregion

    // #region Getters and setters

    /**
     *
     * Use to get the redirect uri configured in MSAL or null.
     * Evaluates redirectUri if its a function, otherwise simply returns its value.
     * @returns {string} redirect URL
     *
     */
    public getRedirectUri(): string {
        if (this.config.authOptions.redirectUri) {
            if (typeof this.config.authOptions.redirectUri === "function") {
                return this.config.authOptions.redirectUri();
            } else if (!StringUtils.isEmpty(this.config.authOptions.redirectUri)) {
                return this.config.authOptions.redirectUri;
            }
        }
        // This should never throw unless window.location.href is returning empty.
        throw ClientConfigurationError.createRedirectUriEmptyError();
    }

    /**
     * Use to get the post logout redirect uri configured in MSAL or null.
     * Evaluates postLogoutredirectUri if its a function, otherwise simply returns its value.
     *
     * @returns {string} post logout redirect URL
     */
    public getPostLogoutRedirectUri(): string {
        if (this.config.authOptions.postLogoutRedirectUri) {
            if (typeof this.config.authOptions.postLogoutRedirectUri === "function") {
                return this.config.authOptions.postLogoutRedirectUri();
            } else if (!StringUtils.isEmpty(this.config.authOptions.postLogoutRedirectUri)) {
                return this.config.authOptions.postLogoutRedirectUri;
            }
        }
        // This should never throw unless window.location.href is returning empty.
        throw ClientConfigurationError.createPostLogoutRedirectUriEmptyError();
    }

    /**
     * Returns the signed in account
     * (the account object is created at the time of successful login)
     * or null when no state is found
     * @returns {@link Account} - the account object stored in MSAL
     */
    getAccount(): Account {
        if (this.account) {
            return this.account;
        }

        // Get id token and client info from cache
        const rawIdToken = this.cacheStorage.getItem(PersistentCacheKeys.ID_TOKEN);
        const rawClientInfo = this.cacheStorage.getItem(PersistentCacheKeys.CLIENT_INFO);

        if(!StringUtils.isEmpty(rawIdToken) && !StringUtils.isEmpty(rawClientInfo)) {
            const idToken = new IdToken(rawIdToken, this.cryptoUtils);
            const clientInfo = buildClientInfo(rawClientInfo, this.cryptoUtils);

            this.account = Account.createAccount(idToken, clientInfo, this.cryptoUtils);
            return this.account;
        }

        // if login is not yet done, return null
        return null;
    }

    // #endregion
}
