import { WebPubSubClient } from '@azure/web-pubsub-client';

const WEBPUBSUB_NEGOTIATE_URL = (typeof window !== 'undefined' && window._env_ && window._env_.WEBPUBSUB_NEGOTIATE_URL) || '';
const WEBPUBSUB_HUB = (typeof window !== 'undefined' && window._env_ && window._env_.WEBPUBSUB_HUB) || 'archlenscopilot_hub';

let cachedClient = null;
let isClientConnected = false;
let clientConnectingPromise = null;

export function getStableBrowserUserId() {
  const storageKey = 'archlens-webpubsub-user-id';
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing && existing.trim()) {
      return existing.trim();
    }
    const generated = `user-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    window.localStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return `user-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }
}

export async function getWebPubSubClient() {
  if (cachedClient && isClientConnected) {
    return cachedClient;
  }

  if (clientConnectingPromise) {
    return clientConnectingPromise;
  }

  const negotiateUrl = WEBPUBSUB_NEGOTIATE_URL;
  if (!negotiateUrl) {
    throw new Error('Azure Web PubSub negotiate URL is not configured in window._env_.');
  }

  clientConnectingPromise = (async () => {
    try {
      if (cachedClient) {
        try {
          cachedClient.stop();
        } catch (stopErr) {
          console.warn('WebPubSub client cleanup notice:', stopErr);
        }
        cachedClient = null;
        isClientConnected = false;
      }

      const userId = getStableBrowserUserId();
      const hub = WEBPUBSUB_HUB;
      const negotiateTarget = new URL(negotiateUrl);
      negotiateTarget.searchParams.set('userId', userId);
      negotiateTarget.searchParams.set('hub', hub);

      const response = await fetch(negotiateTarget.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, hub }),
      });

      if (!response.ok) {
        throw new Error(`Web PubSub negotiate HTTP error ${response.status}: ${response.statusText || 'Endpoint returned failure'}`);
      }

      const negotiatePayload = await response.json();
      const serverUrl = negotiatePayload?.url || negotiatePayload?.clientAccessUrl || negotiatePayload?.WebSocketUrl || negotiatePayload?.webSocketUrl;

      if (!serverUrl || typeof serverUrl !== 'string' || !serverUrl.startsWith('ws')) {
        throw new Error('Web PubSub negotiate did not return a valid WebSocket URL.');
      }

      const client = new WebPubSubClient(serverUrl, { autoReconnect: true });

      client.on('connected', () => {
        isClientConnected = true;
      });

      client.on('disconnected', (e) => {
        isClientConnected = false;
        console.warn('Web PubSub disconnected event:', e);
      });

      client.on('stopped', () => {
        isClientConnected = false;
        cachedClient = null;
      });

      await client.start();
      isClientConnected = true;
      cachedClient = client;
      return client;
    } catch (error) {
      cachedClient = null;
      isClientConnected = false;
      throw error;
    } finally {
      clientConnectingPromise = null;
    }
  })();

  return clientConnectingPromise;
}

/**
 * Send an event payload via Azure Web PubSub
 */
export async function sendWebPubSubEvent(payload, eventName = 'message', options = {}) {
  try {
    const client = await getWebPubSubClient();
    await client.sendEvent(eventName, payload, 'json', options);
    return { success: true, via: 'webpubsub' };
  } catch (error) {
    const detail = error?.message || String(error);
    console.error('Web PubSub sendEvent failure detail:', error);
    throw new Error(`${detail}`);
  }
}

/**
 * Test or check the status of the Web PubSub connection
 */
export async function testWebPubSubConnection() {
  try {
    const client = await getWebPubSubClient();
    if (client && isClientConnected) {
      return { connected: true, message: 'Connected successfully to Azure Web PubSub.' };
    }
    return { connected: false, message: 'Could not establish connection to Azure Web PubSub.' };
  } catch (error) {
    return {
      connected: false,
      message: error?.message || 'Connection to Azure Web PubSub failed.',
    };
  }
}
