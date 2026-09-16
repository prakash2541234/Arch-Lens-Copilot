import React, { useState } from 'react';
import { sendWebPubSubEvent } from '../utils/webPubSub';

function safeJson(value) {
  return value === undefined ? null : value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function resourceName(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(value.name || value.id || value.resourceId || '').trim();
}

function formatCategoryName(category) {
  return String(category || '')
    .split('.')
    .map((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '))
    .join(' - ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatFieldName(field) {
  return String(field || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatValue(value, indent = '') {
  if (value === null || value === undefined || value === '') return [`${indent}Not available`];
  if (typeof value !== 'object') return [`${indent}${String(value)}`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}None`];
    return value.flatMap((item) => (
      item && typeof item === 'object'
        ? formatValue(item, `${indent}- `)
        : [`${indent}- ${String(item)}`]
    ));
  }

  const entries = Object.entries(value);
  if (!entries.length) return [`${indent}None`];
  return entries.flatMap(([key, childValue]) => {
    if (childValue && typeof childValue === 'object') {
      return [`${indent}${formatFieldName(key)}:`, ...formatValue(childValue, `${indent}  `)];
    }
    return [`${indent}${formatFieldName(key)}: ${formatValue(childValue)[0].trim()}`];
  });
}

function buildCostLookup(costAnalysis) {
  const lookup = new Map();
  asArray(costAnalysis?.dimensions).forEach((dimension) => {
    asArray(dimension?.data).forEach((row) => {
      const name = String(row?.name || '').trim().toLowerCase();
      if (name && !lookup.has(name)) lookup.set(name, row?.value ?? null);
    });
  });
  return lookup;
}

function buildOverviewPage(relData, costAnalysis) {
  const subscriptions = relData?.data?.subscriptions || {};
  const costLookup = buildCostLookup(costAnalysis);
  const resourceGroups = [];
  const allResources = new Map();
  const categories = new Map();

  Object.entries(subscriptions).forEach(([subscriptionId, subscription]) => {
    const resourceGroupsData = subscription?.resource_groups || {};
    Object.entries(resourceGroupsData).forEach(([name, group]) => {
      const groupResources = [];
      const groupCategories = group?.categories || {};

      const addResource = (value, category) => {
        const itemName = resourceName(value);
        if (!itemName) return;
        const resource = { name: itemName, category };
        const cost = costLookup.get(itemName.toLowerCase());
        if (cost !== undefined) resource.cost = cost;
        groupResources.push(resource);
        allResources.set(`${subscriptionId}:${name}:${category}:${itemName}`, resource);
        if (!categories.has(category)) categories.set(category, new Set());
        categories.get(category).add(itemName);
      };

      const collectCategoryItems = (value, categoryPath) => {
        if (Array.isArray(value)) {
          value.forEach((item) => addResource(item, categoryPath));
          return;
        }
        if (!value || typeof value !== 'object') return;
        Object.entries(value).forEach(([key, childValue]) => {
          const childPath = categoryPath ? `${categoryPath}.${key}` : key;
          if (Array.isArray(childValue)) {
            childValue.forEach((item) => addResource(item, childPath));
          } else {
            collectCategoryItems(childValue, childPath);
          }
        });
      };

      collectCategoryItems(groupCategories, '');

      resourceGroups.push({
        name,
        subscriptionId,
        resourceCount: groupResources.length,
        resources: groupResources,
      });
    });
  });

  const categoryLists = Object.fromEntries(
    Array.from(categories.entries())
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([category, items]) => [category, Array.from(items).sort()])
  );

  return {
    totalResources: Array.from(allResources.values()),
    resourceGroups,
    resourceTypes: categoryLists,
    totals: {
      totalResources: allResources.size,
      resourceGroups: resourceGroups.length,
    },
  };
}

function formatResource(resource) {
  const cost = resource.cost === undefined || resource.cost === null ? '' : ` | Cost: ${resource.cost}`;
  return `- ${resource.name}${cost}`;
}

export function buildSnapshotText(snapshot) {
  const overview = snapshot.pages.overview;
  const pageSections = [
    ['ARCHITECTURE', snapshot.pages.architecture],
    ['DRIFT ANALYSIS', snapshot.pages.drift],
    ['WELL-ARCHITECTED SCORE', snapshot.pages.wellArchitected],
    ['ADVISOR AND SECURITY FINDINGS', snapshot.pages.advisor],
    ['POLICY', snapshot.pages.policy],
    ['COST ANALYSIS', snapshot.pages.costAnalysis],
    ['COST OPTIMIZATION', snapshot.pages.costOptimization],
  ];
  const lines = [
    'AZURE ARCHITECTURE DASHBOARD SNAPSHOT',
    `Snapshot ID: ${snapshot.snapshotId}`,
    `Created At: ${snapshot.createdAt}`,
    '',
    '===== DETAILS IN OVERVIEW PAGE =====',
    `Total resources: ${overview.totals.totalResources}`,
    `Resource groups: ${overview.totals.resourceGroups}`,
    'Resource Types:',
    ...Object.entries(overview.resourceTypes || {}).flatMap(([category, resources]) => [
      `${formatCategoryName(category)}: ${resources.length}`,
      ...resources.map((item) => `  - ${item}`),
    ]),
    '',
    'Resources:',
    ...overview.totalResources.map(formatResource),
    '',
    'Resource Groups:',
    ...overview.resourceGroups.flatMap((group) => [
      `- ${group.name} (${group.resourceCount} resources, subscription ${group.subscriptionId})`,
      ...group.resources.map((resource) => `  ${formatResource(resource)}`),
    ]),
    '',
    '===== RESOURCE INVENTORY =====',
    `Total Inventory Items: ${overview.totalResources.length}`,
    ...overview.totalResources.map(formatResource),
    '',
    ...pageSections.flatMap(([title, value]) => [
      `===== ${title} =====`,
      ...formatValue(value),
      '',
    ]),
  ];
  return lines.join('\n');
}

export function buildSnapshot({
  normalized,
  scope,
  sourceStatus = {},
}) {
  const createdAt = new Date().toISOString();
  const pageData = {
    overview: buildOverviewPage(normalized?.overview?.relData, normalized?.costAnalysis),
    architecture: safeJson(normalized?.architecture),
    drift: safeJson(normalized?.drift),
    wellArchitected: safeJson(normalized?.wellArchitected),
    advisor: safeJson(normalized?.advisor),
    policy: safeJson(normalized?.policy),
    costAnalysis: safeJson(normalized?.costAnalysis),
    costOptimization: safeJson(normalized?.costOptimization),
  };
  const snapshot = {
    snapshotId: `snapshot-${createdAt.replace(/[:.]/g, '-')}`,
    createdAt,
    metadata: {
      formatVersion: 1,
      collectionComplete: true,
      distributionComplete: true,
    },
    scope: {
      subscriptionIds: Array.isArray(scope?.subscriptionIds) ? scope.subscriptionIds : [],
      subscriptionNames: Array.isArray(scope?.subscriptionNames) ? scope.subscriptionNames : [],
      subscriptionId: scope?.subscriptionId || '',
      scopeType: scope?.scopeType || 'subscription',
      region: scope?.region || '',
      scopeCriteria: scope?.scopeCriteria || {},
    },
    completeness: {
      sources: sourceStatus,
      failedSources: Object.entries(sourceStatus)
        .filter(([, status]) => status?.status === 'failed')
        .map(([name]) => name),
    },
    pages: pageData,
  };

  snapshot.text = buildSnapshotText(snapshot);
  return snapshot;
}

export default function SnapshotCreator({
  snapshotInput,
  endpoint,
  disabled = false,
  onComplete,
  onError,
}) {
  const [isCreating, setIsCreating] = useState(false);

  const createSnapshot = async () => {
    if (isCreating || disabled) return;

    setIsCreating(true);
    try {
      const snapshot = buildSnapshot(snapshotInput);
      const snapshotPayload = {
        request: 'snapshot',
        name: `${snapshot.snapshotId}.txt`,
        fileName: `${snapshot.snapshotId}.txt`,
        format: 'text',
        snapshotId: snapshot.snapshotId,
        scope: snapshot.scope,
        data: snapshot.text,
      };

      const hasWebPubSub = Boolean(typeof window !== 'undefined' && window._env_ && window._env_.WEBPUBSUB_NEGOTIATE_URL);
      let sentViaPubSub = false;

      if (hasWebPubSub) {
        try {
          await sendWebPubSubEvent(snapshotPayload);
          sentViaPubSub = true;
        } catch (pubSubError) {
          console.warn('Web PubSub snapshot event failed or disconnected, attempting fallback to direct HTTP endpoint:', pubSubError);
        }
      }

      if (!sentViaPubSub) {
        if (endpoint) {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshotPayload),
          });

          if (!response.ok) {
            throw new Error(`Snapshot service responded with HTTP ${response.status} ${response.statusText}`);
          }
        } else {
          throw new Error('Web PubSub delivery failed and no direct HTTP trigger endpoint is configured.');
        }
      }

      onComplete?.(snapshot);
    } catch (error) {
      onError?.(error?.message || 'Snapshot creation failed.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <button
      type="button"
      className="discover-btn"
      onClick={createSnapshot}
      disabled={disabled || isCreating}
      title="Create a complete text and JSON snapshot of the loaded dashboard data"
    >
      {isCreating ? 'Creating Snapshot...' : 'Create Snapshot'}
    </button>
  );
}
