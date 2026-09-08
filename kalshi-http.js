// Dedicated undici Clients for Kalshi REST.
//
// undici Client defaults to connections=1, pipelining=1. One shared Client
// therefore serializes quote POST behind background GETs (unhedged /markets
// refresh every 4s, skip-tape, fill tracker, warm). Combo Lock auctions
// close in that window → 409 rfq_closed even when our price is best.
// Quote mutations (POST/PUT/DELETE) get their own warm pool.
'use strict';
const { Client } = require('undici');

const KALSHI_ORIGIN = 'https://external-api.kalshi.com';
const REST_CONNECTIONS = 4;
// POST + confirm + spare so a warm GET cannot take the last quote socket.
const QUOTE_CONNECTIONS = 3;
// Many LBs idle-kill around 30s. A 45s warm left a dead quote socket —
// next POST paid TLS+retry (~800ms) and lost the auction.
const QUOTE_WARM_MS = 15_000;
const CONNECT_TIMEOUT_MS = 2_500;
const HEADERS_TIMEOUT_MS = 8_000;
const BODY_TIMEOUT_MS = 8_000;

function kalshiClientOptions(overrides = {}) {
  return {
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    pipelining: 1,
    connections: 1,
    connectTimeout: CONNECT_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    ...overrides,
  };
}

function createKalshiClient(overrides, ClientImpl = Client) {
  return new ClientImpl(KALSHI_ORIGIN, kalshiClientOptions(overrides));
}

function createKalshiRestPair(ClientImpl = Client) {
  return {
    rest: createKalshiClient({ connections: REST_CONNECTIONS }, ClientImpl),
    quote: createKalshiClient({ connections: QUOTE_CONNECTIONS }, ClientImpl),
  };
}

function isQuoteMutationPath(signPath) {
  return /\/quotes(?:\/|$)/.test(String(signPath || ''));
}

module.exports = {
  KALSHI_ORIGIN,
  REST_CONNECTIONS,
  QUOTE_CONNECTIONS,
  QUOTE_WARM_MS,
  CONNECT_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  BODY_TIMEOUT_MS,
  kalshiClientOptions,
  createKalshiClient,
  createKalshiRestPair,
  isQuoteMutationPath,
};
