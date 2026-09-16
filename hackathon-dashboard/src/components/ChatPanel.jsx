import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot } from 'lucide-react';
import { WebPubSubClient } from '@azure/web-pubsub-client';
import { buildDriftContextForOpenAI } from '../utils/driftDetector';
import { queryDriftAnalysis } from '../utils/openAIIntegration';

const LOGIC_APP_URL = (window._env_ && window._env_.LOGIC_APP_URL) || '';
const TRIGGER_URL = (window._env_ && window._env_.TRIGGER_URL) || '';
const WEBPUBSUB_NEGOTIATE_URL = (window._env_ && window._env_.WEBPUBSUB_NEGOTIATE_URL) || '';
const WEBPUBSUB_HUB = (window._env_ && window._env_.WEBPUBSUB_HUB) || 'archlenscopilot_hub';
const AZURE_OAI_ENDPOINT = (window._env_ && window._env_.AZURE_OAI_ENDPOINT) || '';
const AZURE_OAI_KEY = (window._env_ && window._env_.AZURE_OAI_KEY) || '';
const AZURE_OAI_DEPLOYMENT = (window._env_ && window._env_.AZURE_OAI_DEPLOYMENT) || '';
const OPENAI_READY = Boolean(AZURE_OAI_ENDPOINT && AZURE_OAI_KEY && AZURE_OAI_DEPLOYMENT);

function extractSreTextResponse(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  if (typeof payload !== 'object') return '';

  const candidates = [
    payload.answer,
    payload.response,
    payload.message,
    payload.output,
    payload.result,
    payload.data?.answer,
    payload.data?.response,
    payload.data?.message,
    payload.data?.output,
    payload.data?.result,
    payload.text,
    payload.data?.text,
  ];

  const text = candidates.find((value) => typeof value === 'string' && value.trim());
  if (text) return text.trim();

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '';
  }
}

function getStableBrowserUserId() {
  if (typeof window === 'undefined') return 'browser-user';

  const storageKey = 'archlens-sre-user-id';
  const current = window.localStorage.getItem(storageKey);
  if (current && current.trim()) return current.trim();

  const generated = `sre-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  window.localStorage.setItem(storageKey, generated);
  return generated;
}

function parseSreServerMessage(rawMessage) {
  if (!rawMessage) return null;

  let payload = rawMessage;
  if (typeof rawMessage === 'string') {
    try {
      payload = JSON.parse(rawMessage);
    } catch {
      return {
        status: 'message',
        text: rawMessage.trim(),
        payload: rawMessage.trim(),
      };
    }
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const messageBody = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const statusValue = messageBody.status || messageBody.state || messageBody.type || messageBody.phase || payload.status || payload.state || payload.type || payload.phase;
  const statusText = typeof statusValue === 'string' ? statusValue.toLowerCase() : '';
  const text = extractSreTextResponse(messageBody) || extractSreTextResponse(payload) || '';

  return {
    status: statusText || 'message',
    text,
    payload: messageBody,
    requestId: messageBody.requestId || payload.requestId || payload.id || messageBody.id,
  };
}

function safeSerialize(value, maxChars = 50000) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      return '';
    }

    if (serialized.length <= maxChars) {
      return serialized;
    }

    return `${serialized.slice(0, maxChars)} ...[truncated]`;
  } catch {
    return '';
  }
}

function normalizeSubscriptionIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.startsWith('subscription_')) {
    return lower.slice('subscription_'.length);
  }
  return lower;
}

function extractResourceName(item) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  return String(item.name || item.id || item.resourceId || item.resource || '').trim();
}

function collectResourceNamesFromResourceGroup(resourceGroup) {
  const names = new Set();
  const categories = resourceGroup?.categories;
  if (!categories || typeof categories !== 'object') return names;

  Object.values(categories).forEach((subCategories) => {
    if (!subCategories || typeof subCategories !== 'object') return;
    Object.values(subCategories).forEach((items) => {
      if (!Array.isArray(items)) return;
      items.forEach((item) => {
        const name = extractResourceName(item);
        if (name) names.add(name);
      });
    });
  });

  return names;
}

function toRoundedAmount(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100) / 100;
}

function normalizeDimensionKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function buildCostFingerprint(costAnalysis) {
  const dimensions = Array.isArray(costAnalysis?.dimensions) ? costAnalysis.dimensions : [];
  if (!dimensions.length) return 'none';

  return dimensions
    .map((dimension) => {
      const key = String(dimension?.key || '').trim().toLowerCase();
      const rows = Array.isArray(dimension?.data) ? dimension.data : [];
      const names = rows
        .slice(0, 5)
        .map((row) => String(row?.name || '').trim().toLowerCase())
        .filter(Boolean)
        .join(',');
      const total = rows.reduce((sum, row) => sum + Number(row?.value || 0), 0);
      return `${key}:${rows.length}:${Math.round(total * 100)}:${names}`;
    })
    .sort()
    .join('|');
}

function normalizeScopeType(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function buildScopedCacheKey({ subscriptionKey, scopeType, scopeName, selectedResourceGroup }) {
  const subKey = String(subscriptionKey || '').trim() || '__no_subscription__';
  const normalizedScopeType = normalizeScopeType(scopeType || 'subscription') || 'subscription';
  const normalizedScopeName = String(scopeName || '').trim().toLowerCase() || '__no_scope__';
  const normalizedResourceGroup = String(selectedResourceGroup || '').trim().toLowerCase() || '__no_rg__';
  return `${subKey}::${normalizedScopeType}::${normalizedScopeName}::${normalizedResourceGroup}`;
}

function parseResourceGroupNameFromQuestion(question) {
  const text = String(question || '').trim();
  if (!text) return '';

  const quotedDouble = text.match(/"([^"]+)"/);
  if (quotedDouble?.[1]) return quotedDouble[1].trim();

  const quotedSingle = text.match(/'([^']+)'/);
  if (quotedSingle?.[1]) return quotedSingle[1].trim();

  const rgInline = text.match(/\b(rg[-_a-z0-9]+)\b/i);
  if (rgInline?.[1]) return rgInline[1].trim();

  return '';
}

function resolveResourceGroupMatches(scopedFacts, requestedName) {
  const details = Array.isArray(scopedFacts?.resourceGroupsDetailed)
    ? scopedFacts.resourceGroupsDetailed
    : [];

  if (!details.length) return [];

  const scopeRg = String(scopedFacts?.scope?.selectedResourceGroup || '').trim();
  const candidate = String(requestedName || '').trim() || scopeRg;
  if (!candidate) return [];

  const normalizedCandidate = candidate.toLowerCase();
  return details.filter((item) => String(item?.name || '').trim().toLowerCase() === normalizedCandidate);
}

function buildDeterministicResourceGroupAnswer(question, scopedFacts) {
  const text = String(question || '').trim();
  if (!text || !scopedFacts || typeof scopedFacts !== 'object') return null;

  const countIntent = /\b(how many|count|number of|total)\b/i.test(text) && /\bresource(s)?\b/i.test(text);
  const listIntent = /(\b(list|show|what are|which)\b.*\bresource(s)?\b.*\b(under|in|inside|for)\b)|(^\s*resources\s+under\s+)/i.test(text);
  if (!countIntent && !listIntent) return null;

  const requestedName = parseResourceGroupNameFromQuestion(text);
  const scopeRg = String(scopedFacts?.scope?.selectedResourceGroup || '').trim();
  if (!requestedName && !scopeRg) {
    return null;
  }
  const matches = resolveResourceGroupMatches(scopedFacts, requestedName);

  if (!matches.length) {
    return 'I could not find that resource group in the current scope data. Please verify the resource-group name or select that resource group in scope and ask again.';
  }

  if (matches.length > 1) {
    const options = matches
      .map((item) => `${item.name} (subscription ${item.subscriptionId})`)
      .join(', ');
    return `I found multiple resource groups with that name across selected subscriptions: ${options}. Please specify the subscription as well.`;
  }

  const match = matches[0];
  const resources = Array.isArray(match?.resources) ? match.resources : [];
  const count = Number(match?.resourceCount || resources.length || 0);

  if (countIntent && !listIntent) {
    return `${match.name} has ${count} resource${count === 1 ? '' : 's'} in the current scope.`;
  }

  if (!resources.length) {
    return `${match.name} has 0 resources in the current scope.`;
  }

  const renderedResources = resources.map((name) => `- ${name}`).join('\n');
  return `Resources under ${match.name} (${count} total):\n${renderedResources}`;
}

function isWeakOpenAIAnswer(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return true;

  const weakPatterns = [
    'i could not find that resource group',
    'cost data is not available in the current scope context',
    'there is no resource-level cost dimension in the current payload',
    'cannot provide exact',
    'can\'t reliably',
    'cannot reliably',
    'do not have enough data',
    'not available in the current scope',
  ];

  return weakPatterns.some((pattern) => normalized.includes(pattern));
}

function findRequestedResourceName(question, scopedFacts) {
  const text = String(question || '').trim();
  if (!text) return '';

  const quotedDouble = text.match(/"([^"]+)"/);
  if (quotedDouble?.[1]) return quotedDouble[1].trim();

  const quotedSingle = text.match(/'([^']+)'/);
  if (quotedSingle?.[1]) return quotedSingle[1].trim();

  const resourceNames = Array.isArray(scopedFacts?.resources) ? scopedFacts.resources : [];
  const loweredQuestion = text.toLowerCase();
  const matched = resourceNames.find((name) => {
    const candidate = String(name || '').trim().toLowerCase();
    return candidate && loweredQuestion.includes(candidate);
  });

  return matched ? String(matched) : '';
}

function resolveResourceCostMatch(scopedFacts, requestedResourceName) {
  const allCosts = Array.isArray(scopedFacts?.cost?.resourceAllCosts)
    ? scopedFacts.cost.resourceAllCosts
    : [];
  if (!allCosts.length) return null;

  const requested = String(requestedResourceName || '').trim().toLowerCase();
  if (!requested) return null;

  return allCosts.find((item) => String(item?.name || '').trim().toLowerCase() === requested) || null;
}

function buildDeterministicCostAnswer(question, scopedFacts) {
  const text = String(question || '').trim();
  if (!text || !scopedFacts || typeof scopedFacts !== 'object') return null;

  const costIntent = /\b(cost|spend|price|pricing|bill|billing|utiliz|consum|expense|charges?)\b/i.test(text);
  if (!costIntent) return null;

  const hasCostData = Boolean(scopedFacts?.cost?.hasCostData);
  if (!hasCostData) {
    return 'Cost data is not available in the current scope context yet, so I cannot provide exact per-resource spend right now.';
  }

  const resourceAllCosts = Array.isArray(scopedFacts?.cost?.resourceAllCosts)
    ? scopedFacts.cost.resourceAllCosts
    : [];
  const resourceGroupAllCosts = Array.isArray(scopedFacts?.cost?.resourceGroupAllCosts)
    ? scopedFacts.cost.resourceGroupAllCosts
    : [];
  const subscriptionAllCosts = Array.isArray(scopedFacts?.cost?.subscriptionAllCosts)
    ? scopedFacts.cost.subscriptionAllCosts
    : [];

  const requestedResourceGroup = parseResourceGroupNameFromQuestion(text);
  const askResourceGroupCost = /\b(resource\s*group|rg[-_])/i.test(text) && /\b(cost|spend|price|bill|charge)/i.test(text);

  if (askResourceGroupCost) {
    if (!resourceGroupAllCosts.length) {
      return 'Resource-group cost rows are not available in the current payload.';
    }

    if (requestedResourceGroup) {
      const rgMatch = resourceGroupAllCosts.find((row) => String(row?.name || '').trim().toLowerCase() === requestedResourceGroup.toLowerCase());
      if (rgMatch) {
        return `Current scoped cost for resource group ${rgMatch.name} is ${rgMatch.value}.`;
      }
    }

    const rows = resourceGroupAllCosts
      .map((item) => `- ${item.name}: ${item.value}`)
      .join('\n');
    return `Cost by resource group in the current scope:\n${rows}`;
  }

  const askAllResources = /\b(all|every|each)\b.*\bresource(s)?\b/i.test(text)
    || /\bresource(s)?\b.*\b(all|every|each)\b/i.test(text)
    || /\b(show|list|give)\b.*\bcost\b.*\bresource(s)?\b/i.test(text);

  const askTopResource = /\b(which|what)\b.*\bresource\b.*\b(more|most|highest|top|max)\b.*\bcost\b/i.test(text)
    || /\bhighest\b.*\bcost\b.*\bresource\b/i.test(text)
    || /\btop\b.*\bcost\b.*\bresource\b/i.test(text);

  const askSubscriptionCost = /\b(subscription)\b/i.test(text) && /\b(cost|spend|price|bill|charge)/i.test(text);
  if (askSubscriptionCost) {
    if (!subscriptionAllCosts.length) {
      return 'Subscription-level cost rows are not available in the current payload.';
    }
    if (subscriptionAllCosts.length === 1) {
      return `Current scoped cost for subscription ${subscriptionAllCosts[0].name} is ${subscriptionAllCosts[0].value}.`;
    }
    const rows = subscriptionAllCosts.map((item) => `- ${item.name}: ${item.value}`).join('\n');
    return `Cost by subscription in the current scope:\n${rows}`;
  }

  const resourceCostIntent = askAllResources || askTopResource || /\bresource\b/i.test(text);
  const hasResourceLevelCosts = resourceAllCosts.length > 0;

  if (resourceCostIntent && !hasResourceLevelCosts) {
    return 'Resource-level cost rows are not available in the current payload, so I can only provide exact costs by available dimensions (for example resource group or subscription).';
  }

  if (askTopResource && hasResourceLevelCosts) {
    const top = resourceAllCosts[0];
    return `The highest cost resource in the current scope is ${top.name} at ${top.value}.`;
  }

  const requestedResourceName = findRequestedResourceName(text, scopedFacts);
  const specificMatch = resolveResourceCostMatch(scopedFacts, requestedResourceName);
  if (specificMatch) {
    return `Current scoped cost for ${specificMatch.name} is ${specificMatch.value}.`;
  }

  if (askAllResources) {
    if (!resourceAllCosts.length) {
      return 'I cannot determine per-resource cost for this scope because no resource list is available in the current payload.';
    }

    const rows = resourceAllCosts
      .map((item) => `- ${item.name}: ${item.value}`)
      .join('\n');
    return `Cost by resource in the current scope:\n${rows}`;
  }

  if (/\bresource\b/i.test(text) && requestedResourceName) {
    if (!hasResourceLevelCosts) {
      return `I found resource ${requestedResourceName}, but there is no matching resource-level cost row in the current payload.`;
    }
    return `I found resource ${requestedResourceName}, but there is no matching resource-level cost row for it in the current cost payload.`;
  }

  return null;
}

function buildScopedFacts({ subscriptionKey, scopeName, scopeType, knowledgeSources }) {
  const scopedRelData = knowledgeSources?.scopedRelData || knowledgeSources?.relData || null;
  const subscriptions = scopedRelData?.data?.subscriptions || {};
  const selectedSubscriptionIds = Array.isArray(knowledgeSources?.selectedSubscriptionIds)
    ? knowledgeSources.selectedSubscriptionIds
    : [];
  const currentArchitectureScope = knowledgeSources?.currentArchitectureScope || {};
  const selectedScopeType = normalizeScopeType(currentArchitectureScope?.scopeType || scopeType || 'subscription');
  const selectedResourceGroup = String(currentArchitectureScope?.selectedResourceGroup || '').trim();

  const selectedSubscriptionSet = new Set(
    selectedSubscriptionIds
      .map((id) => normalizeSubscriptionIdentity(id))
      .filter(Boolean)
  );

  const matchedSubscriptionKeys = Object.keys(subscriptions).filter((key) => {
    if (!selectedSubscriptionSet.size) return true;
    const normalizedKey = normalizeSubscriptionIdentity(key);
    const metadataId = normalizeSubscriptionIdentity(subscriptions[key]?.id);
    return selectedSubscriptionSet.has(normalizedKey) || (metadataId && selectedSubscriptionSet.has(metadataId));
  });

  const resourceGroups = [];
  const allResourceNames = new Set();
  const resourceGroupsDetailed = [];

  matchedSubscriptionKeys.forEach((subKey) => {
    const subscription = subscriptions[subKey] || {};
    const rgMap = subscription?.resource_groups || subscription?.resourceGroups || {};
    Object.entries(rgMap).forEach(([rgName, rgValue]) => {
      if (selectedScopeType === 'resource_group' && selectedResourceGroup && rgName !== selectedResourceGroup) {
        return;
      }

      resourceGroups.push({
        subscriptionId: subKey,
        name: rgName,
        metadata: subscription?.metadata || {},
      });

      const resourceNames = collectResourceNamesFromResourceGroup(rgValue);
      resourceNames.forEach((name) => allResourceNames.add(name));

      const normalizedResourceList = Array.from(resourceNames).sort((a, b) => a.localeCompare(b));
      resourceGroupsDetailed.push({
        subscriptionId: subKey,
        name: rgName,
        resourceCount: normalizedResourceList.length,
        resources: normalizedResourceList,
      });
    });
  });

  const resourceCountsByGroup = {};
  const resourcesByGroup = {};
  resourceGroupsDetailed.forEach((item) => {
    resourceCountsByGroup[item.name] = Number(item.resourceCount || 0);
    resourcesByGroup[item.name] = Array.isArray(item.resources) ? item.resources : [];
  });

  const costAnalysis = knowledgeSources?.apiCostAnalysis;
  const dimensions = Array.isArray(costAnalysis?.dimensions) ? costAnalysis.dimensions : [];

  const normalizedDimensions = dimensions
    .map((dimension) => {
      const key = String(dimension?.key || dimension?.dimensionKey || '').trim();
      const normalizedKey = normalizeDimensionKey(key);
      const rows = Array.isArray(dimension?.data) ? dimension.data : [];
      const normalizedRows = rows
        .map((row) => ({
          name: String(row?.name || '').trim(),
          value: toRoundedAmount(row?.value),
        }))
        .filter((row) => row.name);
      const sortedRows = [...normalizedRows].sort((a, b) => b.value - a.value);
      const total = toRoundedAmount(normalizedRows.reduce((sum, row) => sum + row.value, 0));
      return {
        key,
        normalizedKey,
        itemCount: normalizedRows.length,
        total,
        allItems: sortedRows,
        topItems: sortedRows.slice(0, 15),
      };
    })
    .filter((dimension) => dimension.key);

  const resourceGroupCostDimension = normalizedDimensions.find((dimension) => /resource_group|resourcegroup/.test(dimension.normalizedKey));
  const subscriptionCostDimension = normalizedDimensions.find((dimension) => /subscription/.test(dimension.normalizedKey));
  const resourceCostDimension = normalizedDimensions.find((dimension) => {
    if (/resource_group|resourcegroup/.test(dimension.normalizedKey)) return false;
    return /(^|_)resource(_|$)|resource_name|resourceid/.test(dimension.normalizedKey);
  });

  return {
    scope: {
      type: scopeType,
      name: scopeName,
      subscriptionKey,
      selectedScopeType,
      selectedResourceGroup: selectedResourceGroup || null,
    },
    exactMetrics: {
      subscriptionCount: matchedSubscriptionKeys.length,
      resourceGroupCount: resourceGroups.length,
      resourceCount: allResourceNames.size,
    },
    subscriptions: matchedSubscriptionKeys,
    resourceGroups: resourceGroups.map((item) => item.name),
    resources: Array.from(allResourceNames),
    resourceCountsByGroup,
    resourcesByGroup,
    resourceGroupsDetailed,
    cost: {
      hasCostData: normalizedDimensions.length > 0,
      dimensions: normalizedDimensions.map(({ key, itemCount, total }) => ({ key, itemCount, total })),
      resourceGroupTopCosts: resourceGroupCostDimension?.topItems || [],
      resourceTopCosts: resourceCostDimension?.topItems || [],
      resourceGroupAllCosts: resourceGroupCostDimension?.allItems || [],
      resourceAllCosts: resourceCostDimension?.allItems || [],
      subscriptionAllCosts: subscriptionCostDimension?.allItems || [],
    },
  };
}

function buildKnowledgeBundle({ subscriptionKey, scopeName, scopeType, knowledgeSources }) {
  const scopedFacts = buildScopedFacts({ subscriptionKey, scopeName, scopeType, knowledgeSources });
  const costFingerprint = buildCostFingerprint(knowledgeSources?.apiCostAnalysis);
  const documents = Object.entries(knowledgeSources || {})
    .filter(([, value]) => value !== null && value !== undefined && typeof value === 'object')
    .map(([name, value]) => {
      const text = safeSerialize(value);

      return {
        name,
        text,
        size: text.length,
      };
    })
    .filter((doc) => doc.text.length > 2);

  documents.unshift({
    name: 'scopeFacts',
    text: safeSerialize(scopedFacts, 200000),
    size: safeSerialize(scopedFacts, 200000).length,
  });

  return {
    subscriptionKey,
    scopeName,
    scopeType,
    costFingerprint,
    scopedFacts,
    builtAt: new Date().toISOString(),
    documents,
  };
}

function tokenizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 2);
}

function selectRelevantContext(bundle, question, maxDocs = 4, maxDocChars = 3500) {
  if (!bundle || !Array.isArray(bundle.documents) || bundle.documents.length === 0) {
    return {
      builtAt: null,
      sourceCount: 0,
      selectedSources: [],
      contextText: '',
    };
  }

  const tokens = tokenizeQuestion(question);
  const scored = bundle.documents.map((doc) => {
    const textLower = doc.text.toLowerCase();
    const score = tokens.reduce((sum, token) => (
      textLower.includes(token) ? sum + 1 : sum
    ), 0);

    return {
      ...doc,
      score,
    };
  });

  const scopeFactsDoc = scored.find((doc) => doc.name === 'scopeFacts') || null;

  const selected = scored
    .filter((doc) => doc.name !== 'scopeFacts')
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.size - a.size;
    })
    .slice(0, Math.max(0, maxDocs - (scopeFactsDoc ? 1 : 0)));

  const finalSelected = scopeFactsDoc ? [scopeFactsDoc, ...selected] : selected;

  return {
    builtAt: bundle.builtAt,
    sourceCount: bundle.documents.length,
    selectedSources: finalSelected.map((doc) => doc.name),
    contextText: finalSelected
      .map((doc) => `Source: ${doc.name}\n${doc.text.slice(0, maxDocChars)}`)
      .join('\n\n'),
  };
}

export default function ChatPanel({
  relData,
  scopedArchData,
  scopeName = 'Architecture',
  scopeType = 'subscription',
  subscriptionKey = '',
  knowledgeSources = {},
  knowledgeCache = {},
  setKnowledgeCache = null,
  driftPayload = null,
  sharedMessages = null,
  setSharedMessages = null,
  showHistoryButton = false,
  hasSelectedSubscription = true,
  snapshotTriggered = false,
}) {
  const [localMessages, setLocalMessages] = useState([
    {
      role: 'bot',
      text: 'Ask me anything about your architecture or drift. I will answer clearly with findings, impact, and next steps.',
      time: '10:34 AM',
      provider: 'Arch-Lens Copilot',
    }
  ]);
  const messages = Array.isArray(sharedMessages) ? sharedMessages : localMessages;
  const setMessages = typeof setSharedMessages === 'function' ? setSharedMessages : setLocalMessages;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [highlightedMessageIndex, setHighlightedMessageIndex] = useState(-1);
  const [historySearch, setHistorySearch] = useState('');
  const [selectedMode, setSelectedMode] = useState('open-ai');
  const chatBodyRef = useRef(null);
  const messageRefs = useRef({});
  const historyDrawerRef = useRef(null);
  const sreClientRef = useRef(null);
  const sreConnectionReadyRef = useRef(false);
  const sreActiveRequestIdRef = useRef('');
  const [sreConnectionLabel, setSreConnectionLabel] = useState('Check SRE connection');
  const [sreConnectionBusy, setSreConnectionBusy] = useState(false);
  const [sreConnectionError, setSreConnectionError] = useState('');
  const [sreAutoConnectAttempted, setSreAutoConnectAttempted] = useState(false);

  const stopSreClient = () => {
    if (!sreClientRef.current) return;

    try {
      sreClientRef.current.stop();
    } catch (error) {
      console.warn('SRE WebPubSub stop warning:', error);
    }

    sreClientRef.current = null;
    sreConnectionReadyRef.current = false;
  };

  const clearSreRequestState = () => {
    sreActiveRequestIdRef.current = '';
    setLoading(false);
  };

  const ensureSreClient = async () => {
    if (sreClientRef.current && sreConnectionReadyRef.current) {
      return sreClientRef.current;
    }

    const negotiateUrl = WEBPUBSUB_NEGOTIATE_URL;
    if (!negotiateUrl) {
      throw new Error('SRE Web PubSub negotiate URL is not configured.');
    }

    if (sreClientRef.current) {
      try {
        sreClientRef.current.stop();
      } catch (error) {
        console.warn('SRE reconnect cleanup warning:', error);
      }
      sreClientRef.current = null;
    }

    const userId = getStableBrowserUserId();
    const hub = WEBPUBSUB_HUB;
    const negotiateTarget = new URL(negotiateUrl);
    negotiateTarget.searchParams.set('userId', userId);
    negotiateTarget.searchParams.set('hub', hub);

    const response = await fetch(negotiateTarget.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, hub }),
    });

    if (!response.ok) {
      throw new Error(`SRE negotiate failed with status ${response.status}.`);
    }

    const negotiatePayload = await response.json();
    const serverUrl = negotiatePayload?.url || negotiatePayload?.clientAccessUrl || negotiatePayload?.WebSocketUrl || negotiatePayload?.webSocketUrl;

    if (!serverUrl || typeof serverUrl !== 'string' || !serverUrl.startsWith('ws')) {
      throw new Error('SRE negotiate response did not include a usable WebSocket URL.');
    }

    const client = new WebPubSubClient(serverUrl, { autoReconnect: true });
    sreClientRef.current = client;
    sreConnectionReadyRef.current = false;

    client.on('connected', () => {
      sreConnectionReadyRef.current = true;
      setSreConnectionLabel('Connected');
      setSreConnectionError('');
    });

    client.on('disconnected', () => {
      sreConnectionReadyRef.current = false;
      if (sreActiveRequestIdRef.current) {
        const activeRequestId = sreActiveRequestIdRef.current;
        sreActiveRequestIdRef.current = '';
        setLoading(false);
        setSreConnectionError(`SRE connection error: Web PubSub disconnected while waiting for request ${activeRequestId}.`);
        setSreConnectionLabel('Connection failed');
      } else {
        setSreConnectionLabel('Connection failed');
      }
    });

    client.on('server-message', (event) => {
      const rawData = event?.message?.data ?? event?.data ?? event?.message ?? event;
      const parsed = parseSreServerMessage(rawData);
      if (!parsed) return;

      const payloadObject = rawData && typeof rawData === 'object' ? rawData : (parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {});
      const messageType = payloadObject.type || payloadObject.messageType || payloadObject.message?.type || payloadObject.data?.type || '';
      const requestId = payloadObject.requestId || payloadObject.request_id || payloadObject.id || payloadObject.messageId || payloadObject.data?.requestId || payloadObject.data?.request_id || parsed.requestId || '';
      const activeRequestId = sreActiveRequestIdRef.current;
      const status = parsed.status || '';

      const hasSreType = String(messageType || '').toLowerCase() === 'sre';
      const hasSreRequest = String(payloadObject.request || payloadObject.data?.request || '').toLowerCase() === 'sre';

      if (!hasSreType && !hasSreRequest && !status) {
        return;
      }

      if (activeRequestId && requestId && String(requestId) !== String(activeRequestId)) {
        return;
      }

      const dedupeKey = `${String(requestId || activeRequestId || 'unknown')}:${status}`;
      if (status.includes('queued') || status.includes('processing') || status.includes('started')) {
        setLoading(true);
        return;
      }

      if (status.includes('completed')) {
        const finalText = parsed.text || extractSreTextResponse(parsed.payload) || extractSreTextResponse(payloadObject);
        const previousKey = `sre-status-${dedupeKey}`;
        if (window.__sreResponseDedupes && window.__sreResponseDedupes[previousKey]) {
          setLoading(false);
          sreActiveRequestIdRef.current = '';
          return;
        }
        if (!window.__sreResponseDedupes) window.__sreResponseDedupes = {};
        window.__sreResponseDedupes[previousKey] = true;
        setLoading(false);
        sreActiveRequestIdRef.current = '';
        if (finalText && finalText.trim()) {
          setMessages(prev => [...prev, {
            role: 'bot',
            text: finalText || 'SRE responded successfully, but no message body was returned.',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            provider: 'SRE',
          }]);
        }
        return;
      }

      if (status.includes('error') || status.includes('failed')) {
        const finalText = parsed.text || 'SRE request failed.';
        const previousKey = `sre-status-${dedupeKey}`;
        if (window.__sreResponseDedupes && window.__sreResponseDedupes[previousKey]) {
          setLoading(false);
          sreActiveRequestIdRef.current = '';
          return;
        }
        if (!window.__sreResponseDedupes) window.__sreResponseDedupes = {};
        window.__sreResponseDedupes[previousKey] = true;
        setLoading(false);
        sreActiveRequestIdRef.current = '';
        setMessages(prev => [...prev, {
          role: 'bot',
          text: finalText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          provider: 'SRE',
        }]);
        setSreConnectionError(finalText);
      }
    });

    await client.start();
    sreConnectionReadyRef.current = true;
    setSreConnectionLabel('Connected');
    setSreConnectionError('');
    return client;
  };

  const checkSreConnection = async () => {
    setSreConnectionBusy(true);
    setSreConnectionLabel('Checking...');
    setSreConnectionError('');

    try {
      const client = await ensureSreClient();
      if (client && sreConnectionReadyRef.current) {
        setSreConnectionLabel('Connected');
        return;
      }
      throw new Error('SRE Web PubSub connection did not reach Connected state.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown SRE connection error.';
      setSreConnectionLabel('Connection failed');
      setSreConnectionError(`SRE connection error: ${detail}`);
      console.error('SRE connection check failed:', error);
    } finally {
      setSreConnectionBusy(false);
    }
  };

  useEffect(() => {
    if (selectedMode !== 'sre' || !hasSelectedSubscription || sreAutoConnectAttempted) {
      return undefined;
    }

    let isMounted = true;

    const autoConnect = async () => {
      setSreAutoConnectAttempted(true);
      setSreConnectionBusy(true);
      setSreConnectionLabel('Checking...');
      setSreConnectionError('');

      try {
        const client = await ensureSreClient();
        if (!isMounted) return;
        if (client && sreConnectionReadyRef.current) {
          setSreConnectionLabel('Connected');
          return;
        }
        throw new Error('SRE Web PubSub connection did not reach Connected state.');
      } catch (error) {
        if (!isMounted) return;
        const detail = error instanceof Error ? error.message : 'Unknown SRE connection error.';
        setSreConnectionLabel('Connection failed');
        setSreConnectionError(`SRE connection error: ${detail}`);
        console.error('SRE auto connection failed:', error);
      } finally {
        if (isMounted) setSreConnectionBusy(false);
      }
    };

    autoConnect();

    return () => {
      isMounted = false;
    };
  }, [selectedMode, hasSelectedSubscription, sreAutoConnectAttempted]);

  useEffect(() => {
    return () => {
      stopSreClient();
    };
  }, []);

  // Use drift points synchronized from ArchitectureDiagram
  const driftInfo = React.useMemo(() => {
    if (driftPayload && Array.isArray(driftPayload.points) && driftPayload.points.length > 0) {
      const bulletsFromPayload = driftPayload.points.join('\n');
      return {
        hasDrift: Boolean(driftPayload.hasDrift),
        bullets: bulletsFromPayload,
      };
    }

    if (!scopedArchData || !relData) {
      return {
        hasDrift: false,
        bullets: '• No architecture data available',
      };
    }

    return {
      hasDrift: false,
      bullets: '• Drift data is not ready',
    };
  }, [driftPayload, scopedArchData, relData]);

  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTo({
        top: chatBodyRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages]);

  useEffect(() => {
    if (!showHistory) return undefined;

    const handlePointerDown = (event) => {
      const drawerNode = historyDrawerRef.current;
      if (!drawerNode) return;
      if (!drawerNode.contains(event.target)) {
        setShowHistory(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [showHistory]);

  const send = async (text) => {
    if (loading) return;
    const userMsg = String(text ?? input).trim();
    if (!userMsg) return;

    if (!hasSelectedSubscription) {
      const blockedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setMessages(prev => [...prev, {
        role: 'bot',
        text: 'Please select at least one subscription to continue. Once selected, I can help with architecture, security, cost, and drift details.',
        time: blockedTime,
        provider: 'Arch-Lens Copilot',
      }]);
      setInput('');
      return;
    }

    setInput('');
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    setMessages(prev => [...prev, { role: 'user', text: userMsg, time: timestamp }]);

    setLoading(true);

    try {
      if (selectedMode === 'sre') {
        const client = await ensureSreClient();

        const sreRules = 'Only use the file named sample.txt from the knowledge source; do not use any other file or any web URL in the knowledge source; search sample.txt thoroughly since close to 95% of answers exist there; if the answer is not found in sample.txt, reply with exactly this line and nothing else: "here the answer is not there my backend"';
        const requestId = `sre-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        sreActiveRequestIdRef.current = requestId;
        setLoading(true);
        const srePayload = {
          request: 'sre',
          requestId,
          question: `Question: ${userMsg}, Rules: ${sreRules}, Source File: sample.txt`,
        };

        try {
          await client.sendEvent('message', srePayload, 'json');
          return;
        } catch (error) {
          sreActiveRequestIdRef.current = '';
          setLoading(false);
          const detail = error instanceof Error ? error.message : 'Unknown SRE request error.';
          setSreConnectionError(`SRE request error: ${detail}`);
          setMessages(prev => [...prev, {
            role: 'bot',
            text: `SRE request failed: ${detail}`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            provider: 'SRE',
          }]);
          return;
        }
      }

      // Build drift context for OpenAI
      const driftContext = buildDriftContextForOpenAI(
        scopeName,
        scopeType,
        driftInfo.bullets,
        scopedArchData
      );

      const activeSubscriptionKey = String(subscriptionKey || '').trim() || '__no_subscription__';
      const selectedResourceGroup = String(knowledgeSources?.currentArchitectureScope?.selectedResourceGroup || '').trim();
      const scopeCacheKey = buildScopedCacheKey({
        subscriptionKey: activeSubscriptionKey,
        scopeType,
        scopeName,
        selectedResourceGroup,
      });

      const latestCostFingerprint = buildCostFingerprint(knowledgeSources?.apiCostAnalysis);

      let activeBundle = knowledgeCache?.[scopeCacheKey];

      if (!activeBundle || activeBundle.costFingerprint !== latestCostFingerprint) {
        activeBundle = buildKnowledgeBundle({
          subscriptionKey: activeSubscriptionKey,
          scopeName,
          scopeType,
          knowledgeSources,
        });

        if (typeof setKnowledgeCache === 'function') {
          setKnowledgeCache((prev) => ({
            ...(prev || {}),
            [scopeCacheKey]: activeBundle,
          }));
        }
      }

      const scopedFacts = activeBundle?.scopedFacts || null;
      const deterministicRgAnswer = buildDeterministicResourceGroupAnswer(userMsg, scopedFacts);
      const deterministicCostAnswer = buildDeterministicCostAnswer(userMsg, scopedFacts);
      const deterministicAnswer = deterministicRgAnswer || deterministicCostAnswer;

      const retrievedContext = selectRelevantContext(activeBundle, userMsg);

      // Query Azure OpenAI with scoped drift context
      const reply = await queryDriftAnalysis(driftContext, userMsg, retrievedContext);
      const replyText = typeof reply === 'string' ? reply : String(reply?.text || '').trim();
      const fromOpenAI = typeof reply === 'object' && reply?.source === 'openai';

      let finalText = replyText;
      let provider = fromOpenAI ? 'Azure OpenAI' : 'Arch-Lens Copilot';

      if ((!fromOpenAI || isWeakOpenAIAnswer(replyText)) && deterministicAnswer) {
        finalText = deterministicAnswer;
        provider = 'Arch-Lens Copilot';
      }

      if (!finalText) {
        finalText = deterministicAnswer || 'I can help with architecture drift, cost analysis, and security analysis. What would you like to check?';
        provider = deterministicAnswer ? 'Arch-Lens Copilot' : provider;
      }

      setMessages(prev => [...prev, {
        role: 'bot',
        text: finalText,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        provider,
      }]);
    } catch (e) {
      console.error('Chat error:', e);
      const fallback = [
        '• Unable to process your query right now',
        '• Showing scoped drift analysis from current data',
        ...driftInfo.bullets.split('\n').filter(Boolean),
      ].join('\n');
      setMessages(prev => [...prev, {
        role: 'bot',
        text: fallback,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        provider: 'Arch-Lens Copilot',
      }]);
    } finally {
      if (selectedMode !== 'sre') {
        setLoading(false);
      }
    }
  };

  const handleComposerKeyDown = (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    event.preventDefault();
    send();
  };

  const historyQuestions = React.useMemo(() => (
    messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role === 'user' && String(msg.text || '').trim())
      .map(({ msg, index }) => ({
        label: String(msg.text || '').trim(),
        index,
        time: msg.time || '',
      }))
  ), [messages]);

  const filteredHistoryQuestions = React.useMemo(() => {
    const term = String(historySearch || '').trim().toLowerCase();
    if (!term) return historyQuestions;
    return historyQuestions.filter((item) => item.label.toLowerCase().includes(term));
  }, [historyQuestions, historySearch]);

  const jumpToHistoryMessage = (userMessageIndex) => {
    const targetIndex = userMessageIndex;
    const responseIndex = messages.findIndex((msg, idx) => idx > userMessageIndex && msg.role === 'bot');
    const finalIndex = responseIndex >= 0 ? responseIndex : targetIndex;
    const targetNode = messageRefs.current[finalIndex];
    if (!targetNode) return;

    targetNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageIndex(finalIndex);
    setShowHistory(false);
    window.setTimeout(() => setHighlightedMessageIndex(-1), 1400);
  };

  return (
    <div className="bottom-panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel-header">
        <h3>Chat with Arch-Lens Copilot</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {showHistoryButton && (
            <button
              type="button"
              className="chat-send-btn"
              onClick={() => setShowHistory((prev) => !prev)}
              title="View conversation history"
              style={{ minWidth: 64 }}
            >
              History
            </button>
          )}
          <Bot size={14} color="#4f8ef7" />
        </div>
      </div>

      {showHistoryButton && showHistory && (
        <>
          <div className="notif-drawer-backdrop" />
          <div className="chat-history-drawer" ref={historyDrawerRef}>
            <div className="notif-drawer-header">
              <div>
                <h3>History</h3>
                <p>
                  {historyQuestions.length} question{historyQuestions.length === 1 ? '' : 's'} · available until page refresh
                </p>
              </div>
              <button
                type="button"
                className="notif-drawer-close"
                onClick={() => setShowHistory(false)}
                aria-label="Close history"
              >
                ×
              </button>
            </div>
            <div className="notif-drawer-content">
              <div className="chat-history-search-wrap">
                <input
                  type="text"
                  className="chat-history-search"
                  placeholder="Search question history..."
                  value={historySearch}
                  onChange={(event) => setHistorySearch(event.target.value)}
                />
              </div>
              <div className="chat-history-list">
                {filteredHistoryQuestions.length === 0 ? (
                  <div className="chat-history-empty">No matching questions found.</div>
                ) : filteredHistoryQuestions.map((item, idx) => (
                  <button
                    key={`${item.index}-${idx}`}
                    type="button"
                    className="chat-history-item"
                    onClick={() => jumpToHistoryMessage(item.index)}
                    title={item.label}
                  >
                    <div className="chat-history-item-time">{item.time || '—'}</div>
                    <div className="chat-history-item-text">{item.label}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="chat-body" ref={chatBodyRef}>
        {messages.map((m, i) => (
          <div
            className="chat-msg"
            key={i}
            ref={(node) => {
              if (node) messageRefs.current[i] = node;
            }}
            style={highlightedMessageIndex === i ? { outline: '1px solid rgba(79, 142, 247, 0.8)', borderRadius: 8 } : undefined}
          >
            {m.role === 'user' ? (
              <div className="chat-bubble-user">{m.text}</div>
            ) : (
              <div>
                <div className="chat-bubble-bot" style={{ whiteSpace: 'pre-line' }}>{m.text}</div>
                {m.provider && (
                  <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 4, marginLeft: 4 }}>
                    by {m.provider}
                  </div>
                )}
              </div>
            )}
            {m.time && <div className="chat-time">{m.time}</div>}
          </div>
        ))}
        {loading && (
          <div className="chat-loading-row">
            <span className="spinner spinner-sm spinner-orbit" />
            <div className="chat-bubble-bot" style={{ color: '#9ca3af' }}>Analyzing your architecture...</div>
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          placeholder="Type your question (security, cost, drift, impact, remediation)..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleComposerKeyDown}
          rows={1}
        />
        <select
          className="chat-mode-select"
          value={selectedMode}
          onChange={(e) => setSelectedMode(e.target.value)}
        >
          <option value="open-ai">Open AI</option>
          <option value="sre">SRE</option>
        </select>
        {selectedMode === 'sre' && (() => {
          const isConnected = Boolean(sreConnectionReadyRef.current);
          const isSnapshotDone = Boolean(snapshotTriggered);
          const bothDone = isConnected && isSnapshotDone;
          const oneDone = isConnected || isSnapshotDone;

          let dotColor = 'rgba(148, 163, 184, 0.55)'; // default gray/not ready
          let dotShadow = 'none';
          let title = 'SRE: Web PubSub disconnected & Snapshot not created';

          if (bothDone) {
            dotColor = 'rgba(34, 197, 94, 0.85)'; // Green
            dotShadow = '0 0 8px rgba(34, 197, 94, 0.55)';
            title = 'SRE ready: Web PubSub connected & Snapshot created';
          } else if (oneDone) {
            dotColor = 'rgba(234, 179, 8, 0.9)'; // Yellow
            dotShadow = '0 0 8px rgba(234, 179, 8, 0.55)';
            title = isConnected
              ? 'SRE partial: Web PubSub connected, Snapshot not created yet'
              : 'SRE partial: Snapshot created, Web PubSub not connected';
          }

          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 4 }}>
              <span
                title={title}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: `2px solid ${dotColor}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: dotColor,
                    boxShadow: dotShadow,
                  }}
                />
              </span>
            </div>
          );
        })()}
        {selectedMode === 'open-ai' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 4 }}>
            <span
              title={OPENAI_READY ? 'OpenAI backend configured and ready' : 'OpenAI backend configuration missing'}
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `2px solid ${OPENAI_READY ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.8)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: OPENAI_READY ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.8)',
                  boxShadow: OPENAI_READY ? '0 0 8px rgba(34, 197, 94, 0.55)' : '0 0 8px rgba(239, 68, 68, 0.45)',
                }}
              />
            </span>
          </div>
        )}
        <button className="chat-send-btn" onClick={() => send()}>
          <Send size={13} />
        </button>
      </div>
      {selectedMode === 'sre' && sreConnectionError && (
        <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 6, paddingLeft: 4 }}>
          {sreConnectionError}
        </div>
      )}
    </div>
  );
}
