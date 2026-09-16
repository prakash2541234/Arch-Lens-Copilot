import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import StatsCards from './components/StatsCards';
import ArchitectureDiagram, { fetchArchitectureFromFunctionByName } from './components/ArchitectureDiagram';
import WellArchitectedScore from './components/WellArchitectedScore';
import OverviewScoreCard from './components/OverviewScoreCard';
import TopFindings from './components/TopFindings';
import ResourceInventory from './components/ResourceInventory';
import CostOptimizationRecommendations from './components/CostOptimizationRecommendations';
import CostManagementBilling from './components/CostManagementBilling';
import CostAnalysisVisualization from './components/CostAnalysisVisualization';
import ChatPanel from './components/ChatPanel';
import PolicyPage from './components/PolicyPage';
import PolicyDefinitionPage from './components/PolicyDefinitionPage';
import PolicyAssignmentDetail from './components/PolicyAssignmentDetail';
import SnapshotCreator from './components/SnapshotCreator';
import CentralScopeSelector from './components/CentralScopeSelector';
import { generateMarkdownFromJson } from './utils/markdownGenerator';
import { sendWebPubSubEvent, testWebPubSubConnection } from './utils/webPubSub';
import { Download, FileText, Share2, CheckSquare, Sun, Moon } from 'lucide-react';
import { toPng, toSvg } from 'html-to-image';

const DEFAULT_REGION = 'East US';
const INITIAL_COPILOT_MESSAGE = {
  role: 'bot',
  text: 'Ask me anything about your architecture or drift. I will answer clearly with findings, impact, and next steps.',
  time: '10:34 AM',
  provider: 'Arch-Lens Copilot',
};

function createInitialExportModalState() {
  return {
    open: false,
    kind: null,
    format: null,
    loading: false,
    error: '',
    rawDataUrl: '',
    fileName: '',
    imageWidth: 0,
    imageHeight: 0,
    cropEnabled: false,
    crop: { x: 0, y: 0, width: 0, height: 0 },
    reportHtml: '',
    backlogHeaders: [],
    backlogRows: [],
    backlogCsv: '',
  };
}

function buildDiscoveryMarkdownFileName(scopeType, subscriptionIds = []) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scope = String(scopeType || 'subscription').replace(/[^a-z0-9-]/gi, '_').toLowerCase();
  const idPart = Array.isArray(subscriptionIds) && subscriptionIds.length
    ? subscriptionIds.join('_').replace(/[^a-z0-9-]/gi, '_')
    : 'unknown-subscription';
  return `discovery-${scope}-${idPart}-${timestamp}.md`;
}

// Logic App URL — read from runtime config.js (window._env_.LOGIC_APP_URL)
const LOGIC_APP_URL = (window._env_ && window._env_.LOGIC_APP_URL) || '';
const TRIGGER_URL = (window._env_ && window._env_.TRIGGER_URL) || '';
const WEBPUBSUB_NEGOTIATE_URL = (window._env_ && window._env_.WEBPUBSUB_NEGOTIATE_URL) || '';

function parseAutoDiscoverIntentFromUrl() {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search || '');
  const trigger = String(
    params.get('trigger')
    || params.get('mode')
    || params.get('action')
    || params.get('run')
    || ''
  ).trim();

  const subscriptionId = String(
    params.get('subscriptionId')
    || params.get('subscription_id')
    || params.get('subId')
    || ''
  ).trim();

  const triggerLower = trigger.toLowerCase();
  if (triggerLower === 'demo' || triggerLower === 'sample') {
    return { mode: 'demo' };
  }

  if (subscriptionId) {
    return { mode: 'subscription', subscriptionId };
  }

  return null;
}

function parseIfJsonString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeArchitecturePayload(payload) {
  const parsed = parseIfJsonString(payload);
  if (parsed && Array.isArray(parsed.relationships)) return parsed;
  if (Array.isArray(parsed) && parsed.every((r) => r && typeof r === 'object' && 'source' in r && 'target' in r)) {
    return { relationships: parsed };
  }
  return null;
}

function normalizeRelationPayload(payload) {
  const parsed = parseIfJsonString(payload);
  if (!parsed || typeof parsed !== 'object') return null;

  if (parsed.data?.subscriptions && typeof parsed.data.subscriptions === 'object') {
    return parsed;
  }

  if (parsed.subscriptions && typeof parsed.subscriptions === 'object') {
    return {
      ...parsed,
      data: {
        ...(parsed.data || {}),
        subscriptions: parsed.subscriptions,
      },
    };
  }

  return null;
}

function normalizeCostAnalysisPayload(payload) {
  const parsed = parseIfJsonString(payload);
  if (!parsed) return null;

  // Handle different response structures:
  // 1. Direct array of dimensions
  // 2. Object with .dimensions property
  // 3. Object with .cost_analysis.dimensions (nested)
  const rawDimensions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.dimensions)
      ? parsed.dimensions
      : Array.isArray(parsed?.cost_analysis?.dimensions)
        ? parsed.cost_analysis.dimensions
        : Array.isArray(parsed?.cost_analysis)
          ? parsed.cost_analysis
          : [];

  const dimensions = rawDimensions
    .map((entry) => {
      const key = String(entry?.dimensionKey || entry?.dimension || entry?.key || '').trim();
      const values = Array.isArray(entry?.data)
        ? entry.data
        : Array.isArray(entry?.values)
          ? entry.values
          : Array.isArray(entry?.breakdown)
            ? entry.breakdown
            : [];

      if (!key || !values.length) return null;

      const data = values
        .map((item) => ({
          name: String(item?.name || item?.label || item?.key || '').trim(),
          value: Number(item?.value ?? item?.amount ?? item?.cost ?? 0),
        }))
        .filter((item) => item.name && Number.isFinite(item.value) && item.value >= 0);

      if (!data.length) return null;
      return { key, data };
    })
    .filter(Boolean);

  if (!dimensions.length) return null;
  return { dimensions };
}

function normalizeCostOptimizationPayload(payload) {
  const parsed = parseIfJsonString(payload);
  
  // Handle different response structures:
  // 1. Direct array of recommendations
  // 2. Object with .recommendations property
  // 3. Object with .cost_optimization.recommendations (nested)
  // 4. Object with .items property
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.recommendations)
      ? parsed.recommendations
      : Array.isArray(parsed?.cost_optimization?.recommendations)
        ? parsed.cost_optimization.recommendations
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [];

  const normalized = rows
    .map((item) => ({
      title: String(item?.title || item?.name || '').trim(),
      detail: String(item?.detail || item?.description || '').trim(),
      impact: String(item?.impact || 'Medium').trim(),
      fromState: String(item?.fromState || item?.from || '').trim(),
      toState: String(item?.toState || item?.to || '').trim(),
      benefit: String(item?.benefit || '').trim(),
      estimatedSavingsMonthly: Number(item?.estimatedSavingsMonthly ?? item?.estimated_savings_monthly ?? item?.monthlySavings ?? item?.value ?? 0),
    }))
    .filter((item) => item.title);

  return normalized.length ? normalized : null;
}

function normalizeSecurityRisksPayload(payload) {
  const parsed = parseIfJsonString(payload);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.findings)
      ? parsed.findings
      : Array.isArray(parsed?.risks)
        ? parsed.risks
        : Array.isArray(parsed?.recommendations)
          ? parsed.recommendations
        : [];

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const normalizeSeverity = (value) => {
    const normalized = String(value || 'medium').toLowerCase();
    return ['critical', 'high', 'medium', 'low'].includes(normalized) ? normalized : 'medium';
  };

  const normalized = rows
    .map((item) => {
      const resource = String(item?.resource || item?.resourceName || item?.target || '').trim();
      const issue = String(item?.issue || item?.recommendation || item?.title || item?.finding || '').trim();
      const reason = String(item?.reason || item?.whyItMatters || item?.description || '').trim();
      const remediation = String(item?.remediation || '').trim();
      const text = String(item?.text || [issue, reason].filter(Boolean).join(' — ') || issue || reason || '').trim();
      const resourceType = String(item?.resourceType || item?.resource_type || item?.targetType || '').trim();
      const resourceGroup = String(item?.resourceGroup || item?.resource_group || item?.resourceGroupName || '').trim();
      const subscriptionId = String(item?.subscriptionId || item?.subscription_id || item?.subscription || '').trim();
      const category = String(item?.category || item?.advisorCategory || '').trim();
      const activeResourcesRaw = Number(
        item?.activeResources
        ?? item?.active_resources
        ?? item?.resourceCount
        ?? item?.resource_count
        ?? (resource ? 1 : 0)
      );
      const activeResources = Number.isFinite(activeResourcesRaw) && activeResourcesRaw > 0
        ? Math.round(activeResourcesRaw)
        : (resource ? 1 : 0);
      const totalResourcesRaw = Number(
        item?.totalResources
        ?? item?.total_resources
        ?? item?.totalResourceCount
        ?? item?.total_resource_count
        ?? 0
      );
      const totalResources = Number.isFinite(totalResourcesRaw) && totalResourcesRaw > 0
        ? Math.round(totalResourcesRaw)
        : 0;
      const impactedPillars = Array.isArray(item?.impactedPillars)
        ? item.impactedPillars.map((pillar) => String(pillar || '').trim()).filter(Boolean)
        : item?.pillar
          ? [String(item.pillar).trim()]
          : [];
      const resourceGroups = Array.isArray(item?.resourceGroups)
        ? item.resourceGroups.map((value) => String(value || '').trim()).filter(Boolean)
        : (resourceGroup ? [resourceGroup] : []);
      const subscriptionIds = Array.isArray(item?.subscriptionIds)
        ? item.subscriptionIds.map((value) => String(value || '').trim()).filter(Boolean)
        : (subscriptionId ? [subscriptionId] : []);

      return {
        text,
        recommendation: issue || text,
        severity: normalizeSeverity(item?.severity ?? item?.impact ?? item?.risk),
        resource,
        resourceName: resource,
        resourceId: String(item?.resourceId || item?.resource_id || '').trim(),
        resourceType,
        resourceGroup,
        resourceGroups,
        subscriptionId,
        subscriptionIds,
        category,
        activeResources,
        totalResources,
        impactedPillars,
        issue,
        reason,
        remediation,
      };
    })
    .filter((item) => item.text)
    .sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

  return normalized.length ? normalized : null;
}

function normalizeScoreSummaryPayload(payload) {
  const parsed = parseIfJsonString(payload);
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed?.scoreSummary && typeof parsed.scoreSummary === 'object'
    ? parsed.scoreSummary
    : parsed;

  const toNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  };

  const summary = {
    overall: toNumber(candidate.overall),
    security: toNumber(candidate.security),
    reliability: toNumber(candidate.reliability),
    performanceEfficiency: toNumber(candidate.performanceEfficiency ?? candidate.performance_efficiency ?? candidate.performance),
    costOptimization: toNumber(candidate.costOptimization ?? candidate.cost_optimization ?? candidate.cost),
    operationalExcellence: toNumber(candidate.operationalExcellence ?? candidate.operational_excellence ?? candidate.operational),
  };

  const hasAnyValue = Object.values(summary).some((value) => Number.isFinite(value));
  return hasAnyValue ? summary : null;
}

function normalizePolicyInfoPayload(payload) {
  const parsed = parseIfJsonString(payload);
  if (!parsed || typeof parsed !== 'object') return null;

  const groupedEntries = Object.entries(parsed).filter(([, value]) => (
    value
    && typeof value === 'object'
    && (Array.isArray(value.definitions) || Array.isArray(value.assignments))
  ));

  if (!Array.isArray(parsed?.definitions) && !Array.isArray(parsed?.assignments) && groupedEntries.length) {
    return parsed;
  }

  const definitions = Array.isArray(parsed?.definitions)
    ? parsed.definitions
    : Array.isArray(parsed?.policyDefinitions)
      ? parsed.policyDefinitions
      : [];

  const assignments = Array.isArray(parsed?.assignments)
    ? parsed.assignments
    : Array.isArray(parsed?.policyAssignments)
      ? parsed.policyAssignments
      : [];

  if (!definitions.length && !assignments.length) return null;

  return {
    ...parsed,
    definitions,
    assignments,
  };
}

function findByPredicate(value, predicate, maxDepth = 8, depth = 0, seen = new Set()) {
  const parsed = parseIfJsonString(value);
  if (predicate(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object' || depth >= maxDepth) return null;
  if (seen.has(parsed)) return null;

  seen.add(parsed);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  for (const child of entries) {
    const found = findByPredicate(child, predicate, maxDepth, depth + 1, seen);
    if (found) return found;
  }

  return null;
}

function extractDiscoveryPayload(result) {
  const parsed = parseIfJsonString(result);

  // Preferred response contract (new):
  // {
  //   architecture: ...,
  //   relation_mapping: ...,
  //   cost_analysis: ...,
  //   sec_info: ...,
  //   advisor: ...
  //   policy_info: ...
  // }
  const architectureSection = parsed?.architecture ?? parsed?.Architecture;
  const relationSection = parsed?.relation_mapping ?? parsed?.relation_maping ?? parsed?.Relation_Mapping;
  const costSection = parsed?.cost_analysis ?? parsed?.Cost_Analysis;
  const securitySection = parsed?.sec_info ?? parsed?.secInfo ?? parsed?.Sec_Info;
  const advisorSection = parsed?.advisor ?? parsed?.Advisor;
  const advisorRecommendations = Array.isArray(parsed?.recommendations)
    ? parsed.recommendations
    : Array.isArray(advisorSection?.recommendations)
      ? advisorSection.recommendations
      : null;
  const advisorScoreSummary = parsed?.scoreSummary
    || parsed?.score_summary
    || advisorSection?.scoreSummary
    || advisorSection?.score_summary;
  const policySection = parsed?.policy_info ?? parsed?.policyInfo ?? parsed?.Policy_Info;

  const architectureMatch = architectureSection ?? findByPredicate(parsed, (candidate) => Boolean(normalizeArchitecturePayload(candidate)));
  const relationMatch = relationSection ?? findByPredicate(parsed, (candidate) => Boolean(normalizeRelationPayload(candidate)));
  
  // Try to find cost_analysis object first (which may contain both dimensions and recommendations)
  const costAnalysisObject = findByPredicate(costSection ?? parsed, (candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    // Check if it has dimensions and/or cost_optimization structure
    const hasDimensions = Array.isArray(candidate?.dimensions);
    const hasCostOpt = candidate?.cost_optimization && typeof candidate.cost_optimization === 'object';
    return hasDimensions || hasCostOpt;
  });
  
  // Extract cost analysis from the cost_analysis object or from other sources
  let costAnalysisMatch;
  if (costAnalysisObject?.dimensions) {
    costAnalysisMatch = costAnalysisObject;
  } else {
    costAnalysisMatch = findByPredicate(costSection ?? parsed, (candidate) => Boolean(normalizeCostAnalysisPayload(candidate)));
  }
  
  // Extract cost optimization from the cost_analysis object or from other sources
  let costOptimizationMatch;
  if (costAnalysisObject?.cost_optimization) {
    costOptimizationMatch = costAnalysisObject.cost_optimization;
  } else {
    costOptimizationMatch = findByPredicate(costSection ?? parsed, (candidate) => Boolean(normalizeCostOptimizationPayload(candidate)));
  }
  
  const securityRisksMatch = advisorRecommendations
    ?? advisorSection
    ?? securitySection
    ?? findByPredicate(parsed, (candidate) => Boolean(normalizeSecurityRisksPayload(candidate)));
  const scoreSummaryMatch = advisorScoreSummary
    ?? advisorSection
    ?? securitySection
    ?? findByPredicate(parsed, (candidate) => Boolean(normalizeScoreSummaryPayload(candidate)));

  const policyInfoMatch = policySection
    ?? findByPredicate(parsed, (candidate) => Boolean(normalizePolicyInfoPayload(candidate)));

  return {
    architecturePayload: normalizeArchitecturePayload(architectureMatch),
    relationPayload: normalizeRelationPayload(relationMatch),
    costAnalysisPayload: normalizeCostAnalysisPayload(costAnalysisMatch),
    costOptimizationPayload: normalizeCostOptimizationPayload(costOptimizationMatch),
    securityRisksPayload: normalizeSecurityRisksPayload(securityRisksMatch),
    scoreSummaryPayload: normalizeScoreSummaryPayload(scoreSummaryMatch),
    policyInfoPayload: normalizePolicyInfoPayload(policyInfoMatch),
  };
}

function deriveNotifications(relData, archData) {
  if (!relData && !archData) {
    return [];
  }

  const notifications = [];
  const subs = relData?.data?.subscriptions || {};
  const totalSubscriptions = Object.keys(subs).length;
  const totalRelationships = archData?.relationships?.length || 0;

  notifications.push({
    type: 'info',
    time: 'Now',
    title: 'Discovery Snapshot Ready',
    body: `Loaded ${totalSubscriptions} subscription(s) and ${totalRelationships} relationship(s).`,
  });

  Object.entries(subs).forEach(([subId, sub]) => {
    const rgs = sub.resource_groups || {};

    Object.entries(rgs).forEach(([rgName, rg]) => {
      const cats = rg.categories || {};

      const storages = cats.storage?.storage_accounts || [];
      storages.forEach((storage) => {
        notifications.push({
          type: 'critical',
          time: 'Now',
          title: 'Public Storage Risk Detected',
          body: `Storage account ${storage} in ${rgName} should be reviewed for public blob access.`,
        });
      });

      const vms = cats.compute?.virtual_machines || [];
      const nsgs = cats.networking?.network_security_groups || [];
      if (vms.length > 0 && nsgs.length === 0) {
        notifications.push({
          type: 'high',
          time: 'Now',
          title: 'NSG Missing on VM Workload',
          body: `${rgName} has ${vms.length} VM(s) without a Network Security Group.`,
        });
      }

      const funcs = cats.app_services?.function_apps || [];
      const insights = cats.monitoring?.application_insights || [];
      if (funcs.length > 0 && insights.length === 0) {
        notifications.push({
          type: 'medium',
          time: 'Now',
          title: 'Monitoring Gap Detected',
          body: `${funcs.length} function app(s) in ${rgName} have no Application Insights.`,
        });
      }

      const keyvaults = cats.security?.keyvaults || [];
      if (funcs.length > 0 && keyvaults.length === 0) {
        notifications.push({
          type: 'high',
          time: 'Now',
          title: 'Key Vault Not Configured',
          body: `No Key Vault found in ${rgName} for app workload secret management.`,
        });
      }
    });

    notifications.push({
      type: 'info',
      time: 'Now',
      title: 'Subscription Scan Completed',
      body: `Subscription ${subId} processed with ${Object.keys(rgs).length} resource group(s).`,
    });
  });

  return notifications.slice(0, 20);
}

function deriveRemediationBacklog(relData) {
  const rows = [];
  const subs = relData?.data?.subscriptions || {};

  Object.entries(subs).forEach(([subscription, sub]) => {
    const rgs = sub.resource_groups || {};

    Object.entries(rgs).forEach(([rgName, rg]) => {
      const cats = rg.categories || {};
      const keyvaults = cats.security?.keyvaults || [];

      const storages = cats.storage?.storage_accounts || [];
      storages.forEach((resource) => {
        rows.push({
          subscription,
          resourceGroup: rgName,
          resource,
          severity: 'Critical',
          finding: 'Storage account may allow public blob access',
          recommendation: 'Disable public blob access and enforce private endpoints.',
          ownerHint: 'Storage Team',
        });
      });

      const vms = cats.compute?.virtual_machines || [];
      const nsgs = cats.networking?.network_security_groups || [];
      if (vms.length > 0 && nsgs.length === 0) {
        vms.forEach((resource) => {
          rows.push({
            subscription,
            resourceGroup: rgName,
            resource,
            severity: 'High',
            finding: 'VM has no Network Security Group',
            recommendation: 'Attach NSG with least-privilege inbound/outbound rules.',
            ownerHint: 'Network Team',
          });
        });
      }

      const funcs = cats.app_services?.function_apps || [];
      const insights = cats.monitoring?.application_insights || [];
      if (funcs.length > 0 && insights.length === 0) {
        funcs.forEach((resource) => {
          rows.push({
            subscription,
            resourceGroup: rgName,
            resource,
            severity: 'Medium',
            finding: 'Function app missing Application Insights',
            recommendation: 'Enable Application Insights and configure alert rules.',
            ownerHint: 'App Team',
          });
        });
      }

      if (funcs.length > 0 && keyvaults.length === 0) {
        rows.push({
          subscription,
          resourceGroup: rgName,
          resource: rgName,
          severity: 'High',
          finding: 'No Key Vault configured for app workload',
          recommendation: 'Provision Key Vault and move secrets from app settings.',
          ownerHint: 'Security Team',
        });
      }
    });
  });

  const dedup = new Set();
  return rows.filter((row) => {
    const key = `${row.subscription}|${row.resourceGroup}|${row.resource}|${row.finding}`;
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });
}

function getSubscriptionDisplayName(subscriptionId, metadata = {}) {
  return metadata.subscriptionName
    || metadata.displayName
    || metadata.name
    || String(subscriptionId || '').trim();
}

function normalizeSubscriptionIdentity(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  const armMatch = lower.match(/\/subscriptions\/([^/\s]+)/i);
  if (armMatch?.[1]) return armMatch[1];

  const prefixedMatch = lower.match(/(?:^|[^a-z0-9])subscription[_:\-/\s]*([a-z0-9-]+)/i);
  if (prefixedMatch?.[1]) return prefixedMatch[1];

  return lower;
}

function resolveSubscriptionKey(subscriptions, candidateId) {
  const normalizedCandidate = normalizeSubscriptionIdentity(candidateId);
  if (!normalizedCandidate) return '';

  const direct = Object.keys(subscriptions || {}).find(
    (key) => normalizeSubscriptionIdentity(key) === normalizedCandidate
  );

  return direct || '';
}

function filterRelDataBySubscriptions(relData, subscriptionIds) {
  if (!relData || !subscriptionIds?.length) return relData;

  const subscriptions = relData?.data?.subscriptions || {};
  const filteredSubscriptions = {};

  (subscriptionIds || []).forEach((id) => {
    const matchedKey = resolveSubscriptionKey(subscriptions, id);
    if (!matchedKey) return;
    filteredSubscriptions[matchedKey] = subscriptions[matchedKey];
  });

  return {
    ...relData,
    data: {
      ...relData.data,
      subscriptions: filteredSubscriptions,
    },
  };
}

function filterCostAnalysisByCentralScope(costAnalysis, centralScope, scopedRelData) {
  if (!centralScope?.enabled || !costAnalysis?.dimensions) return costAnalysis;

  const selectedIds = new Set((centralScope.subscriptionIds || []).map((id) => String(id).toLowerCase()));
  const resourceGroups = (centralScope.resourceGroups || [centralScope.resourceGroup])
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean);
  const resourceNames = new Set();
  Object.values(scopedRelData?.data?.subscriptions || {}).forEach((subscription) => {
    Object.values(subscription?.resource_groups || {}).forEach((group) => {
      Object.values(group?.categories || {}).forEach((category) => {
        Object.values(category || {}).forEach((items) => {
          if (Array.isArray(items)) items.forEach((item) => resourceNames.add(String(item?.name || item || '').toLowerCase()));
        });
      });
    });
  });

  return {
    ...costAnalysis,
    dimensions: costAnalysis.dimensions.map((dimension) => {
      const key = String(dimension?.key || dimension?.dimensionKey || '').toLowerCase();
      const rows = Array.isArray(dimension?.data) ? dimension.data : [];
      if (centralScope.level === 'resource-group' && /resource.?group/.test(key)) {
        return { ...dimension, data: rows.filter((row) => resourceGroups.includes(String(row?.name || '').trim().toLowerCase())) };
      }
      if (centralScope.level === 'resource-group' && /resource$|resource_name|resourceid/.test(key)) {
        return { ...dimension, data: rows.filter((row) => resourceNames.has(String(row?.name || '').trim().toLowerCase())) };
      }
      if (centralScope.level === 'subscription' && /subscription/.test(key)) {
        return { ...dimension, data: rows.filter((row) => selectedIds.has(String(row?.name || '').trim().toLowerCase())) };
      }
      return dimension;
    }),
  };
}

function buildSelectedSubscriptionSummary(relData, subscriptionIds, nameMap = {}) {
  const subscriptions = relData?.data?.subscriptions || {};

  return (subscriptionIds || [])
    .map((id) => {
      const matchedKey = resolveSubscriptionKey(subscriptions, id);
      const normalizedId = normalizeSubscriptionIdentity(id);
      const resolvedSubscriptionId = matchedKey || id;

      const mappedName =
        nameMap[resolvedSubscriptionId]
        || nameMap[normalizedId]
        || nameMap[id];

      const metadata = subscriptions[matchedKey]?.metadata;

      return {
        id: resolvedSubscriptionId,
      // prefer explicit name from scope API, then metadata from discover, then short ID fallback
        name: mappedName
          || getSubscriptionDisplayName(resolvedSubscriptionId, metadata)
          || resolvedSubscriptionId,
      };
    })
    .filter((item) => item.id);
}

function resolveSubscriptionDisplayName(relData, subscriptionId, nameMap = {}) {
  const subscriptions = relData?.data?.subscriptions || {};
  const id = String(subscriptionId || '').trim();
  if (!id) return '';

  const matchedKey = resolveSubscriptionKey(subscriptions, id);
  const normalizedId = normalizeSubscriptionIdentity(id);
  const resolvedSubscriptionId = matchedKey || id;

  const mappedName =
    nameMap[resolvedSubscriptionId]
    || nameMap[normalizedId]
    || nameMap[id];

  if (mappedName !== undefined && mappedName !== null && String(mappedName).length > 0) {
    return String(mappedName);
  }

  const metadata = subscriptions[matchedKey]?.metadata;
  return getSubscriptionDisplayName(resolvedSubscriptionId, metadata);
}

// Collect every resource identifier that belongs to a resource group's category tree
function collectResourceGroupTokens(resourceGroup) {
  const tokens = new Set();
  const categories = resourceGroup?.categories || {};
  Object.values(categories).forEach((subCategories) => {
    if (!subCategories || typeof subCategories !== 'object') return;
    Object.values(subCategories).forEach((items) => {
      if (Array.isArray(items)) {
        items.forEach((item) => {
          if (typeof item === 'string') tokens.add(item);
          else if (item && typeof item === 'object' && item.name) tokens.add(item.name);
          else if (item && typeof item === 'object' && item.id) tokens.add(item.id);
        });
      }
    });
  });
  return tokens;
}

// Traverse relationships to include descendants reachable from a set of seed node ids
function expandRelationshipClosure(relationships, seedIds) {
  const included = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    relationships.forEach(({ source, target }) => {
      if (included.has(source) && !included.has(target)) {
        included.add(target);
        changed = true;
      }
    });
  }
  return included;
}

function filterArchDataByScope(archData, currentScope, relData) {
  if (!archData?.relationships) return archData;
  if (!currentScope || (!currentScope.selectedSubscriptionId && !currentScope.selectedResourceGroup)) {
    return archData;
  }

  const subscriptions = relData?.data?.subscriptions || {};
  const relationships = archData.relationships;

  // Resolve the actual subscription key in relData (handles id variations)
  const subKey = Object.keys(subscriptions).find(
    (key) =>
      key === currentScope.selectedSubscriptionId ||
      subscriptions[key]?.id === currentScope.selectedSubscriptionId ||
      `subscription_${key}` === currentScope.selectedSubscriptionId
  );

  // If we cannot resolve the subscription, return unfiltered data
  if (!subKey) return archData;

  const subscription = subscriptions[subKey] || {};
  const resourceGroups = subscription.resource_groups || {};

  // Possible identifiers that represent the subscription node in relationships
  const subscriptionNodeIds = [subKey, `subscription_${subKey}`, currentScope.selectedSubscriptionId];

  // ---- Resource Group scope ----
  if (currentScope.selectedResourceGroup || currentScope.selectedResourceGroups?.length) {
    const rgNames = currentScope.selectedResourceGroups?.length
      ? currentScope.selectedResourceGroups
      : [currentScope.selectedResourceGroup];
    const seeds = new Set();
    rgNames.forEach((rgName) => {
      const rg = resourceGroups[rgName] || {};
      seeds.add(rgName);
      collectResourceGroupTokens(rg).forEach((token) => seeds.add(token));
    });

    // Expand to include all descendants of the resource group and its resources
    const included = expandRelationshipClosure(relationships, seeds);

    const filtered = relationships.filter(
      ({ source, target }) => included.has(source) && included.has(target)
    );

    return { ...archData, relationships: filtered };
  }

  // ---- Subscription scope ----
  // Seed with the subscription node ids plus all its resource group names
  const seeds = new Set([...subscriptionNodeIds, ...Object.keys(resourceGroups)]);
  Object.values(resourceGroups).forEach((rg) => {
    collectResourceGroupTokens(rg).forEach((token) => seeds.add(token));
  });

  const included = expandRelationshipClosure(relationships, seeds);

  const filtered = relationships.filter(
    ({ source, target }) => included.has(source) || included.has(target)
  );

  return { ...archData, relationships: filtered };
}

export default function App() {
  const initialSubscriptionId = '';
  const initialRegion = DEFAULT_REGION;

  const [activeNav, setActiveNav] = useState('overview');
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  const [scopeType, setScopeType] = useState('subscription');
  const [subscriptionId, setSubscriptionId] = useState(initialSubscriptionId);
  const [subscriptionInput, setSubscriptionInput] = useState(initialSubscriptionId);
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState(
    initialSubscriptionId ? [initialSubscriptionId] : []
  );
  const [resourceGroupInput, setResourceGroupInput] = useState('');
  const [region, setRegion] = useState(initialRegion);
  const [scopeRegion, setScopeRegion] = useState(initialRegion);
  const [scopeCriteria, setScopeCriteria] = useState({
    resourceGroupSubscriptionId: initialSubscriptionId,
    environment: 'prod',
    globalBusiness: 'ict',
    globalSubfunction: 'GDPA',
    applicationName: 'MGMT/AZURE',
  });
  const [reportScope, setReportScope] = useState('Subscription');
  const [reportSubscriptionIds, setReportSubscriptionIds] = useState([]);
  const [reportResourceGroup, setReportResourceGroup] = useState('');
  const [reportResource, setReportResource] = useState('');
  const [subscriptionNameMap, setSubscriptionNameMap] = useState({});
  const [loading, setLoading] = useState(false);
  const [archData, setArchData] = useState(null);
  const [relData, setRelData] = useState(null);
  const [apiCostAnalysis, setApiCostAnalysis] = useState(null);
  const [apiCostOptimization, setApiCostOptimization] = useState(null);
  const [apiSecurityRisks, setApiSecurityRisks] = useState(null);
  const [apiScoreSummary, setApiScoreSummary] = useState(null);
  const [apiPolicyDemoData, setApiPolicyDemoData] = useState(null);
  const [rawDiscoveryResponse, setRawDiscoveryResponse] = useState(null);
  const [toast, setToast] = useState(null);
  const [eventNotifications, setEventNotifications] = useState([]);
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState([]);
  const [discoverStatus, setDiscoverStatus] = useState('idle'); // idle | loading | success | error
  const [discoverMessage, setDiscoverMessage] = useState('');
  const [architecturePersistentState, setArchitecturePersistentState] = useState(() => ({
    activeTab: 'current',
    architectureScopeType: 'subscription',
    scopeSubscriptionId: '',
    scopeResourceGroupName: '',
    recommendedImageSrc: '',
    recommendedSvgMarkup: '',
    isSvgRecommended: true,
    uploadedFileName: '',
    imageZoom: 1,
    imageOffset: { x: 0, y: 0 },
  }));
  // Shared uploaded application architecture — synced across Overview, Architecture and Drift pages.
  const [applicationArchitecture, setApplicationArchitecture] = useState({
    imageSrc: '',
    svgMarkup: '',
    isSvg: false,
    fileName: '',
  });
  const [currentArchitectureScope, setCurrentArchitectureScope] = useState({
    scopeType: 'subscription',
    scopeName: '',
    selectedSubscriptionId: '',
    selectedResourceGroup: '',
    scopedArchData: null,
    drift: {
      state: 'no-current',
      hasDrift: false,
      points: ['• Drift data is not ready'],
    },
  });
  const [centralScope, setCentralScope] = useState({
    enabled: false,
    level: 'subscription',
    subscriptionIds: [],
    resourceGroup: '',
    resourceGroupSubscriptionId: '',
  });
  const [webPubSubStatus, setWebPubSubStatus] = useState({ state: 'idle', message: '' }); // idle | testing | connected | error
  const [pageScopeOverrides, setPageScopeOverrides] = useState({
    drift: null,
    wellArchitected: null,
    costAnalysis: null,
  });
  const [snapshotTriggered, setSnapshotTriggered] = useState(false);
  const [copilotMessages, setCopilotMessages] = useState([
    INITIAL_COPILOT_MESSAGE,
  ]);
  const [subscriptionKnowledgeCache, setSubscriptionKnowledgeCache] = useState({});
  const [notificationFilter, setNotificationFilter] = useState('all');
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [selectedPolicyAssignment, setSelectedPolicyAssignment] = useState(null);
  const [policyDetailSourceNav, setPolicyDetailSourceNav] = useState('policy');
  const [exportModal, setExportModal] = useState(() => createInitialExportModalState());
  const [isSendingBacklogMail, setIsSendingBacklogMail] = useState(false);
  const [isConcernModalOpen, setIsConcernModalOpen] = useState(false);
  const [isSendingConcern, setIsSendingConcern] = useState(false);
  const [concernForm, setConcernForm] = useState({ idType: 'TID', id: '', name: '', email: '', concern: '' });
  const [cropDragState, setCropDragState] = useState(null);
  const autoDiscoverTriggeredRef = useRef(false);
  const discoveryInFlightRef = useRef(false);
  const exportPreviewImageRef = useRef(null);
  const scopedRelData = useMemo(
    () => filterRelDataBySubscriptions(relData, selectedSubscriptionIds),
    [relData, selectedSubscriptionIds]
  );
  const centralSelectedSubscriptionSummary = useMemo(
    () => buildSelectedSubscriptionSummary(relData, centralScope.subscriptionIds, subscriptionNameMap),
    [relData, centralScope.subscriptionIds, subscriptionNameMap]
  );
  const centralArchitectureScope = useMemo(() => ({
    selectedSubscriptionId: centralScope.subscriptionIds.length === 1
      ? centralScope.subscriptionIds[0]
      : '',
    selectedResourceGroup: centralScope.level === 'resource-group' ? centralScope.resourceGroup : '',
    selectedResourceGroups: centralScope.level === 'resource-group' ? centralScope.resourceGroups : [],
  }), [centralScope]);
  const activeDriftScope = pageScopeOverrides.drift || centralArchitectureScope;
  const activeWellScope = pageScopeOverrides.wellArchitected || {
    subscriptionId: centralScope.subscriptionIds[0] || '',
    resourceGroup: centralScope.level === 'resource-group' ? centralScope.resourceGroup : '',
  };
  const activeCostScope = pageScopeOverrides.costAnalysis || {
    scope: centralScope.level === 'resource-group' ? 'Resource Group' : 'Subscription',
    subscriptions: centralScope.subscriptionIds,
    resourceGroup: centralScope.level === 'resource-group' ? centralScope.resourceGroup : '',
    resourceGroups: centralScope.level === 'resource-group' ? centralScope.resourceGroups : [],
  };
  const centralFilteredArchData = useMemo(
    () => centralScope.enabled && activeDriftScope.selectedSubscriptionId
      ? filterArchDataByScope(archData, activeDriftScope, relData)
      : archData,
    [archData, activeDriftScope, centralScope.enabled, relData]
  );
  const centralScopedCostAnalysis = useMemo(
    () => filterCostAnalysisByCentralScope(apiCostAnalysis, {
      ...centralScope,
      level: activeCostScope.scope === 'Resource Group' ? 'resource-group' : 'subscription',
      subscriptionIds: activeCostScope.subscriptions,
      resourceGroup: activeCostScope.resourceGroup,
      resourceGroups: activeCostScope.resourceGroups,
    }, scopedRelData),
    [apiCostAnalysis, activeCostScope, centralScope, scopedRelData]
  );
  const selectedSubscriptionSummary = useMemo(
    () => buildSelectedSubscriptionSummary(relData, selectedSubscriptionIds, subscriptionNameMap),
    [relData, selectedSubscriptionIds, subscriptionNameMap]
  );
  const filteredArchDataByScope = useMemo(
    () => filterArchDataByScope(archData, currentArchitectureScope, relData),
    [archData, currentArchitectureScope, relData]
  );
  const chatScopedArchData = currentArchitectureScope.scopedArchData || filteredArchDataByScope || archData || null;
  // Chat always operates at subscription level — architecture scope selection (resource group etc)
  // is intentionally not inherited here. User can mention a specific scope in the message.
  const chatScopeName =
    selectedSubscriptionSummary.length === 1
      ? selectedSubscriptionSummary[0].name
      : selectedSubscriptionSummary.length > 1
        ? `${selectedSubscriptionSummary.length} subscriptions`
        : 'All Subscriptions';
  const chatScopeType = 'subscription';
  const chatSubscriptionKey = selectedSubscriptionIds.length
    ? [...selectedSubscriptionIds].sort().join('|')
    : '';
  const chatKnowledgeSources = useMemo(() => ({
    archData,
    relData,
    // Always pass full relData (not scopedRelData) as primary context so chat sees all subscriptions
    scopedRelData: relData,
    filteredArchDataByScope,
    // Provide architecture scope as reference only — chat scope itself is always subscription-level
    currentArchitectureScope: {
      ...currentArchitectureScope,
      scopeType: 'subscription',
      scopeName: chatScopeName,
      selectedResourceGroup: '',
    },
    apiCostAnalysis,
    apiCostOptimization,
    apiSecurityRisks,
    apiScoreSummary,
    selectedSubscriptionIds,
    selectedSubscriptionSummary,
    applicationArchitecture,
  }), [
    archData,
    relData,
    filteredArchDataByScope,
    currentArchitectureScope,
    chatScopeName,
    apiCostAnalysis,
    apiCostOptimization,
    apiSecurityRisks,
    apiScoreSummary,
    selectedSubscriptionIds,
    selectedSubscriptionSummary,
    applicationArchitecture,
  ]);
  const previousChatSubscriptionKeyRef = useRef('');
  const derivedNotifications = deriveNotifications(relData, archData);
  const baseNotifications = [...eventNotifications, ...derivedNotifications].slice(0, 80);
  const notifications = (() => {
    const signatureCounts = {};
    return baseNotifications
      .map((n) => {
        const signature = `${n.type}|${n.title}|${n.body}`;
        signatureCounts[signature] = (signatureCounts[signature] || 0) + 1;
        return {
          ...n,
          notificationId: `${signature}|${signatureCounts[signature]}`,
        };
      })
      .filter((n) => !dismissedNotificationIds.includes(n.notificationId));
  })();
  const notificationCounts = {
    all: notifications.length,
    critical: notifications.filter((n) => n.type === 'critical').length,
    high: notifications.filter((n) => n.type === 'high').length,
    medium: notifications.filter((n) => n.type === 'medium').length,
    info: notifications.filter((n) => n.type === 'info').length,
  };
  const filteredNotifications = notificationFilter === 'all'
    ? notifications
    : notifications.filter((n) => n.type === notificationFilter);

  const toggleNotificationsDrawer = () => {
    setIsNotificationsOpen((prev) => !prev);
  };

  useEffect(() => {
    const currentSubscriptionKey = [...selectedSubscriptionIds].sort().join('|');

    if (!previousChatSubscriptionKeyRef.current) {
      previousChatSubscriptionKeyRef.current = currentSubscriptionKey;
      return;
    }

    if (previousChatSubscriptionKeyRef.current !== currentSubscriptionKey) {
      previousChatSubscriptionKeyRef.current = currentSubscriptionKey;
      setCopilotMessages([INITIAL_COPILOT_MESSAGE]);
      setSubscriptionKnowledgeCache({});
    }
  }, [selectedSubscriptionIds]);

  const renderNotificationsContent = () => (
    <>
      <div className="notif-filters">
        {[
          { key: 'all', label: 'All' },
          { key: 'critical', label: 'Critical' },
          { key: 'high', label: 'High' },
          { key: 'medium', label: 'Medium' },
          { key: 'info', label: 'Info' },
        ].map((filter) => (
          <button
            key={filter.key}
            type="button"
            className={`notif-filter-btn ${notificationFilter === filter.key ? 'active' : ''}`}
            onClick={() => setNotificationFilter(filter.key)}
          >
            <span>{filter.label}</span>
            <span className="notif-filter-count">{notificationCounts[filter.key]}</span>
          </button>
        ))}
      </div>

      <div className="notifications-wrap">
        <div className="notifications-panel">
          {filteredNotifications.map((n) => (
            <div className={`notif-item notif-${n.type}`} key={n.notificationId}>
            <div className="notif-dot" />
            <div className="notif-content">
              <div className="notif-title">{n.title}</div>
              <div className="notif-body">{n.body}</div>
            </div>
            <div className="notif-time">{n.time}</div>
            <button
              type="button"
              className="notif-item-close"
              onClick={() => setDismissedNotificationIds((prev) => (
                prev.includes(n.notificationId) ? prev : [...prev, n.notificationId]
              ))}
              aria-label="Remove notification"
            >
              ×
            </button>
          </div>
          ))}

          {filteredNotifications.length === 0 && (
            <div className="notif-empty">No notifications for this filter.</div>
          )}
        </div>

        {notifications.length > 0 && (
          <div className="notif-actions-fixed">
            <button
              type="button"
              className="notif-clear-btn"
              onClick={() => {
                setEventNotifications([]);
                setDismissedNotificationIds((prev) => [
                  ...new Set([...prev, ...notifications.map((n) => n.notificationId)]),
                ]);
              }}
            >
              Clear all
            </button>
          </div>
        )}
      </div>
    </>
  );

  const pushEventNotification = (type, title, body) => {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setEventNotifications((prev) => [{ type, time, title, body }, ...prev].slice(0, 60));
  };

  const showToast = (type, title, body, ttlMs = 5000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToast({ id, type, title, body });
    window.setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current));
    }, ttlMs);
  };

  const downloadDataUrl = (dataUrl, fileName) => {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getExportTarget = () => {
    const pageBody = document.querySelector('.page-body');
    return pageBody || document.querySelector('.main-content');
  };

  const getFileTimestamp = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  };

  const closeExportModal = () => {
    setExportModal(createInitialExportModalState());
  };

  const clampCrop = (cropRect, width, height) => {
    const safeWidth = Math.max(1, Math.floor(width || 1));
    const safeHeight = Math.max(1, Math.floor(height || 1));
    const x = Math.min(Math.max(0, Math.floor(Number(cropRect?.x) || 0)), safeWidth - 1);
    const y = Math.min(Math.max(0, Math.floor(Number(cropRect?.y) || 0)), safeHeight - 1);
    const maxW = Math.max(1, safeWidth - x);
    const maxH = Math.max(1, safeHeight - y);
    const rectWidth = Math.min(Math.max(1, Math.floor(Number(cropRect?.width) || safeWidth)), maxW);
    const rectHeight = Math.min(Math.max(1, Math.floor(Number(cropRect?.height) || safeHeight)), maxH);
    return { x, y, width: rectWidth, height: rectHeight };
  };

  const resizeCropFromCorner = useCallback((startCrop, corner, deltaX, deltaY, imageWidth, imageHeight) => {
    const startLeft = startCrop.x;
    const startTop = startCrop.y;
    const startRight = startCrop.x + startCrop.width;
    const startBottom = startCrop.y + startCrop.height;

    let left = startLeft;
    let top = startTop;
    let right = startRight;
    let bottom = startBottom;

    if (corner === 'nw') {
      left = Math.min(Math.max(0, startLeft + deltaX), startRight - 1);
      top = Math.min(Math.max(0, startTop + deltaY), startBottom - 1);
    } else if (corner === 'ne') {
      right = Math.max(startLeft + 1, Math.min(imageWidth, startRight + deltaX));
      top = Math.min(Math.max(0, startTop + deltaY), startBottom - 1);
    } else if (corner === 'sw') {
      left = Math.min(Math.max(0, startLeft + deltaX), startRight - 1);
      bottom = Math.max(startTop + 1, Math.min(imageHeight, startBottom + deltaY));
    } else if (corner === 'se') {
      right = Math.max(startLeft + 1, Math.min(imageWidth, startRight + deltaX));
      bottom = Math.max(startTop + 1, Math.min(imageHeight, startBottom + deltaY));
    }

    return clampCrop(
      {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
      imageWidth,
      imageHeight,
    );
  }, []);

  const loadImageElement = (dataUrl) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not render export preview image.'));
    image.src = dataUrl;
  });

  const cropPngDataUrl = async (dataUrl, cropRect, isDarkBackground) => {
    const image = await loadImageElement(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = cropRect.width;
    canvas.height = cropRect.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to initialize canvas for cropping.');
    context.fillStyle = isDarkBackground ? '#0f172a' : '#f0f2f5';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      image,
      cropRect.x,
      cropRect.y,
      cropRect.width,
      cropRect.height,
      0,
      0,
      cropRect.width,
      cropRect.height,
    );
    return canvas.toDataURL('image/png');
  };

  const cropSvgDataUrl = (sourceDataUrl, cropRect, fullWidth, fullHeight) => {
    const escapedSource = sourceDataUrl.replace(/&/g, '&amp;');
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${cropRect.width}" height="${cropRect.height}" viewBox="0 0 ${cropRect.width} ${cropRect.height}">
  <image href="${escapedSource}" x="-${cropRect.x}" y="-${cropRect.y}" width="${fullWidth}" height="${fullHeight}" preserveAspectRatio="none" />
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  const buildReportHtml = () => {
    const subs = relData?.data?.subscriptions || {};
    const subscriptionCount = Object.keys(subs).length;
    const rgCount = Object.values(subs).reduce((sum, sub) => sum + Object.keys(sub.resource_groups || {}).length, 0);
    const relationshipCount = archData?.relationships?.length || 0;
    const generatedAt = new Date().toLocaleString();

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Arch-Lens Report</title>
    <style>
      body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
      h1 { margin-bottom: 4px; }
      .muted { color: #6b7280; margin-bottom: 20px; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 12px; margin-bottom: 18px; }
      .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
      .label { font-size: 12px; color: #6b7280; }
      .value { font-size: 22px; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; margin-top: 14px; }
      th, td { border: 1px solid #e5e7eb; text-align: left; padding: 8px; font-size: 13px; }
      th { background: #f9fafb; }
    </style>
  </head>
  <body>
    <h1>Arch-Lens Copilot Report</h1>
    <div class="muted">Generated at: ${generatedAt}</div>

    <div class="grid">
      <div class="card"><div class="label">Subscription Scope</div><div class="value">${subscriptionId || '-'}</div></div>
      <div class="card"><div class="label">Region</div><div class="value">${region || '-'}</div></div>
      <div class="card"><div class="label">Relationships</div><div class="value">${relationshipCount}</div></div>
      <div class="card"><div class="label">Subscriptions</div><div class="value">${subscriptionCount}</div></div>
      <div class="card"><div class="label">Resource Groups</div><div class="value">${rgCount}</div></div>
      <div class="card"><div class="label">Active View</div><div class="value">${activeNav}</div></div>
    </div>

    <h2>Summary</h2>
    <table>
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Subscription ID</td><td>${subscriptionId || '-'}</td></tr>
        <tr><td>Region</td><td>${region || '-'}</td></tr>
        <tr><td>Total Relationships</td><td>${relationshipCount}</td></tr>
        <tr><td>Total Subscriptions</td><td>${subscriptionCount}</td></tr>
        <tr><td>Total Resource Groups</td><td>${rgCount}</td></tr>
      </tbody>
    </table>
  </body>
</html>`;
  };

  const openImageExportPreview = async (format) => {
    try {
      const target = getExportTarget();
      if (!target) throw new Error('No exportable content found on screen.');

      const fileName = `architecture-dashboard_${getFileTimestamp()}.${format}`;
      setExportModal({
        ...createInitialExportModalState(),
        open: true,
        kind: 'image',
        format,
        fileName,
        loading: true,
      });

      const dataUrl = format === 'svg'
        ? await toSvg(target, {
          cacheBust: true,
          backgroundColor: isDarkMode ? '#0f172a' : '#f0f2f5',
        })
        : await toPng(target, {
          cacheBust: true,
          pixelRatio: 2,
          backgroundColor: isDarkMode ? '#0f172a' : '#f0f2f5',
        });

      const image = await loadImageElement(dataUrl);
      setExportModal((prev) => ({
        ...prev,
        loading: false,
        rawDataUrl: dataUrl,
        imageWidth: image.naturalWidth,
        imageHeight: image.naturalHeight,
        crop: {
          x: 0,
          y: 0,
          width: image.naturalWidth,
          height: image.naturalHeight,
        },
      }));
    } catch (e) {
      showToast('high', 'Export Failed', `${String(format || '').toUpperCase()} preview failed: ${e.message}`, 5000);
      pushEventNotification('high', 'Export Failed', `${String(format || '').toUpperCase()} preview failed: ${e.message}`);
      setExportModal(createInitialExportModalState());
    }
  };

  const openReportPreview = () => {
    const reportHtml = buildReportHtml();
    setExportModal({
      ...createInitialExportModalState(),
      open: true,
      kind: 'report',
      format: 'html',
      fileName: `architecture-report_${getFileTimestamp()}.html`,
      reportHtml,
    });
  };

  const buildRemediationBacklogCsvPayload = (backlog) => {
    const headers = [
      'Id',
      'Severity',
      'Subscription',
      'Resource Group',
      'Resource',
      'Finding',
      'Recommendation',
      'Owner Hint',
      'Status',
      'Created At',
    ];

    const escapeCsv = (value) => {
      const text = String(value ?? '');
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const createdAt = new Date().toISOString();
    const rows = backlog.map((item, index) => [
      `RB-${String(index + 1).padStart(4, '0')}`,
      item.severity,
      item.subscription,
      item.resourceGroup,
      item.resource,
      item.finding,
      item.recommendation,
      item.ownerHint,
      'Open',
      createdAt,
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map(escapeCsv).join(','))
      .join('\n');

    return { headers, rows, csv };
  };

  const handleExportSvg = async () => {
    await openImageExportPreview('svg');
  };

  const handleExportPng = async () => {
    await openImageExportPreview('png');
  };

  const handleCropCornerPointerDown = (corner, event) => {
    if (!exportModal.cropEnabled || exportModal.kind !== 'image') return;
    event.preventDefault();
    event.stopPropagation();
    setCropDragState({
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startCrop: { ...exportModal.crop },
    });
  };

  useEffect(() => {
    if (!cropDragState) return undefined;

    const onPointerMove = (event) => {
      const imageEl = exportPreviewImageRef.current;
      if (!imageEl) return;

      const rect = imageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      setExportModal((prev) => {
        if (!prev.cropEnabled || prev.kind !== 'image') return prev;

        const scaleX = prev.imageWidth / rect.width;
        const scaleY = prev.imageHeight / rect.height;
        const deltaX = Math.round((event.clientX - cropDragState.startX) * scaleX);
        const deltaY = Math.round((event.clientY - cropDragState.startY) * scaleY);

        return {
          ...prev,
          crop: resizeCropFromCorner(
            cropDragState.startCrop,
            cropDragState.corner,
            deltaX,
            deltaY,
            prev.imageWidth,
            prev.imageHeight,
          ),
        };
      });
    };

    const onPointerUp = () => {
      setCropDragState(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [cropDragState, resizeCropFromCorner]);

  const handleGenerateFromPreview = async () => {
    if (exportModal.kind === 'report') {
      try {
        const blob = new Blob([exportModal.reportHtml], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = exportModal.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        closeExportModal();
      } catch (e) {
        showToast('high', 'Report Export Failed', `Report export failed: ${e.message}`, 5000);
        pushEventNotification('high', 'Report Export Failed', `Report export failed: ${e.message}`);
      }
      return;
    }

    if (exportModal.kind === 'backlog') {
      try {
        const blob = new Blob([exportModal.backlogCsv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = exportModal.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        closeExportModal();
      } catch (e) {
        showToast('high', 'Backlog Export Failed', `Backlog export failed: ${e.message}`, 5000);
        pushEventNotification('high', 'Backlog Export Failed', `Backlog export failed: ${e.message}`);
      }
      return;
    }

    if (exportModal.kind !== 'image') return;

    try {
      setExportModal((prev) => ({ ...prev, loading: true, error: '' }));
      const fullCrop = clampCrop(
        { x: 0, y: 0, width: exportModal.imageWidth, height: exportModal.imageHeight },
        exportModal.imageWidth,
        exportModal.imageHeight,
      );
      const selectedCrop = clampCrop(exportModal.crop, exportModal.imageWidth, exportModal.imageHeight);
      const isFullCrop = selectedCrop.x === fullCrop.x
        && selectedCrop.y === fullCrop.y
        && selectedCrop.width === fullCrop.width
        && selectedCrop.height === fullCrop.height;

      let dataUrl = exportModal.rawDataUrl;
      if (exportModal.cropEnabled && !isFullCrop) {
        dataUrl = exportModal.format === 'png'
          ? await cropPngDataUrl(exportModal.rawDataUrl, selectedCrop, isDarkMode)
          : cropSvgDataUrl(exportModal.rawDataUrl, selectedCrop, exportModal.imageWidth, exportModal.imageHeight);
      }

      downloadDataUrl(dataUrl, exportModal.fileName);
      closeExportModal();
    } catch (e) {
      setExportModal((prev) => ({ ...prev, loading: false, error: e.message || 'Export failed.' }));
      showToast('high', 'Export Failed', `Export failed: ${e.message}`, 5000);
      pushEventNotification('high', 'Export Failed', `Export failed: ${e.message}`);
    }
  };

  const handleGenerateReport = () => {
    openReportPreview();
  };

  const handleCreateRemediationBacklog = () => {
    const backlog = deriveRemediationBacklog(relData);

    if (backlog.length === 0) {
      const message = 'No remediation backlog items found. Run Discover to generate findings first.';
      showToast('info', 'No Backlog Items', message, 5000);
      pushEventNotification('info', 'No Backlog Items', message);
      return;
    }

    const payload = buildRemediationBacklogCsvPayload(backlog);
    setExportModal({
      ...createInitialExportModalState(),
      open: true,
      kind: 'backlog',
      format: 'csv',
      fileName: `remediation-backlog_${getFileTimestamp()}.csv`,
      backlogHeaders: payload.headers,
      backlogRows: payload.rows,
      backlogCsv: payload.csv,
    });
  };

  const handleSendRemediationBacklogMail = async () => {
    if (isSendingBacklogMail) return;

    const headers = Array.isArray(exportModal?.backlogHeaders) ? exportModal.backlogHeaders : [];
    const rows = Array.isArray(exportModal?.backlogRows) ? exportModal.backlogRows : [];

    if (!headers.length || !rows.length) {
      const message = 'No backlog information available to send. Please create the remediation backlog first.';
      showToast('info', 'Mail Not Sent', message, 5000);
      pushEventNotification('info', 'Mail Not Sent', message);
      return;
    }

    const severityColor = (sev) => {
      const s = String(sev || '').toLowerCase();
      if (s === 'critical') return '#c0392b';
      if (s === 'high') return '#e67e22';
      if (s === 'medium') return '#f1c40f';
      return '#27ae60';
    };

    const thStyle = 'padding:8px 12px;text-align:left;background:#1e293b;color:#f1f5f9;font-size:12px;white-space:nowrap;border:1px solid #334155;';
    const tdStyle = 'padding:7px 12px;font-size:12px;color:#1e293b;border:1px solid #cbd5e1;vertical-align:top;';

    const headerRow = headers
      .map((h) => `<th style="${thStyle}">${String(h ?? '')}</th>`)
      .join('');

    // Index of the Severity column so we can colour the badge
    const severityColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'severity');

    const bodyRows = rows
      .map((row) => {
        const cells = row.map((val, colIdx) => {
          const text = String(val ?? '');
          if (colIdx === severityColIndex) {
            const bg = severityColor(text);
            const badge = `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${text}</span>`;
            return `<td style="${tdStyle}">${badge}</td>`;
          }
          return `<td style="${tdStyle}">${text}</td>`;
        });
        return `<tr>${cells.join('')}</tr>`;
      })
      .join('');

    const htmlTable = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:100%;">
  <h2 style="margin:0 0 4px;font-size:18px;color:#1e293b;">Remediation Backlog</h2>
  <p style="margin:0 0 16px;font-size:13px;color:#64748b;">Generated on ${new Date().toLocaleString()} — ${rows.length} item${rows.length === 1 ? '' : 's'}</p>
  <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;width:100%;min-width:900px;">
      <thead><tr>${headerRow}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>
</div>`;

    try {
      if (!WEBPUBSUB_NEGOTIATE_URL && !TRIGGER_URL) {
        throw new Error('Neither Web PubSub nor Trigger URL is configured in runtime config.');
      }

      setIsSendingBacklogMail(true);
      const mailPayload = {
        request: 'mail',
        data: htmlTable,
      };

      let sentViaPubSub = false;
      if (WEBPUBSUB_NEGOTIATE_URL) {
        try {
          await sendWebPubSubEvent(mailPayload);
          sentViaPubSub = true;
        } catch (pubSubErr) {
          console.warn('Web PubSub mail trigger failed, falling back to direct HTTP trigger:', pubSubErr);
        }
      }

      if (!sentViaPubSub) {
        if (TRIGGER_URL) {
          const response = await fetch(TRIGGER_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(mailPayload),
          });

          if (!response.ok) {
            throw new Error(`Mail trigger responded with HTTP ${response.status} ${response.statusText}`);
          }
        } else {
          throw new Error('Web PubSub mail trigger failed and no TRIGGER_URL is configured.');
        }
      }

      const message = `Remediation backlog mail sent successfully (${rows.length} item${rows.length === 1 ? '' : 's'}).`;
      showToast('info', 'Mail Triggered', message, 4500);
      pushEventNotification('info', 'Mail Triggered', message);
    } catch (error) {
      const message = `Failed to trigger mail: ${error?.message || 'Unknown error'}`;
      showToast('high', 'Mail Trigger Failed', message, 5000);
      pushEventNotification('high', 'Mail Trigger Failed', message);
    } finally {
      setIsSendingBacklogMail(false);
    }
  };

  const handleSendConcern = async (event) => {
    event.preventDefault();
    if (isSendingConcern) return;

    const id = String(concernForm.id || '').trim();
    const name = String(concernForm.name || '').trim();
    const email = String(concernForm.email || '').trim();
    const concern = String(concernForm.concern || '').trim();
    if (!id || !name || !email || !concern) {
      showToast('high', 'Concern Not Sent', 'Please complete TID/SID, name, email, and concern.', 5000);
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      showToast('high', 'Concern Not Sent', 'Please enter a valid email address.', 5000);
      return;
    }

    try {
      if (!WEBPUBSUB_NEGOTIATE_URL && !TRIGGER_URL) {
        throw new Error('Neither Web PubSub nor Trigger URL is configured in runtime config.');
      }
      setIsSendingConcern(true);
      const data = `${concernForm.idType}: ${id}, Name: ${name}, Mail: ${email}, Concern: ${concern}`;
      const mailPayload = { request: 'mail', data };

      let sentViaPubSub = false;
      if (WEBPUBSUB_NEGOTIATE_URL) {
        try {
          await sendWebPubSubEvent(mailPayload);
          sentViaPubSub = true;
        } catch (pubSubErr) {
          console.warn('Web PubSub concern trigger failed, falling back to direct HTTP trigger:', pubSubErr);
        }
      }

      if (!sentViaPubSub) {
        if (TRIGGER_URL) {
          const response = await fetch(TRIGGER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mailPayload),
          });
          if (!response.ok) throw new Error(`Mail trigger responded with HTTP ${response.status} ${response.statusText}`);
        } else {
          throw new Error('Web PubSub concern trigger failed and no TRIGGER_URL is configured.');
        }
      }

      setIsConcernModalOpen(false);
      setConcernForm({ idType: 'TID', id: '', name: '', email: '', concern: '' });
      showToast('info', 'Concern Sent', 'Your concern was sent successfully.', 4500);
    } catch (error) {
      showToast('high', 'Concern Not Sent', error?.message || 'Unable to send concern.', 5000);
    } finally {
      setIsSendingConcern(false);
    }
  };

  // Extract subscription names from discover result so banner shows real names
  useEffect(() => {
    const subscriptions = relData?.data?.subscriptions || {};
    if (!Object.keys(subscriptions).length) return;
    const extracted = {};
    Object.entries(subscriptions).forEach(([id, sub]) => {
      const name = getSubscriptionDisplayName(id, sub?.metadata);
      if (name) {
        extracted[id] = name;
        extracted[normalizeSubscriptionIdentity(id)] = name;
      }
    });
    if (Object.keys(extracted).length) {
      setSubscriptionNameMap((prev) => ({ ...prev, ...extracted }));
    }
  }, [relData]);

  useEffect(() => {
    document.body.classList.toggle('dark-theme', isDarkMode);
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  useEffect(() => {
    const pageBody = document.querySelector('.page-body');
    if (pageBody) pageBody.scrollTop = 0;
    const mainContent = document.querySelector('.main-content');
    if (mainContent) mainContent.scrollTop = 0;
  }, [activeNav]);

  useEffect(() => {
    const availableSubscriptions = Object.keys(relData?.data?.subscriptions || {});
    if (!availableSubscriptions.length) return;

    setSelectedSubscriptionIds((prev) => (prev.length ? prev : [availableSubscriptions[0]]));
    setScopeCriteria((prev) => ({
      ...prev,
      resourceGroupSubscriptionId: prev.resourceGroupSubscriptionId || availableSubscriptions[0],
    }));
    setSubscriptionInput((prev) => prev || availableSubscriptions[0]);
  }, [relData]);

  const handleDiscover = async (overrides = {}) => {
    // Blocks a second concurrent call (double-click, race, retry) from firing another Logic App run.
    if (discoveryInFlightRef.current) return false;

    const effectiveScopeType = overrides.scopeType ?? scopeType;
    const effectiveScopeCriteria = overrides.scopeCriteria ?? scopeCriteria;
    const effectiveScopeRegion = overrides.scopeRegion ?? scopeRegion;
    const effectiveRegion = ['environment', 'global-business', 'global-subfunction', 'application-name'].includes(effectiveScopeType)
      ? effectiveScopeRegion
      : (overrides.region ?? region);
    const requestedSubscriptionIds = (overrides.selectedSubscriptionIds ?? selectedSubscriptionIds)
      .map((id) => id.trim())
      .filter(Boolean);
    const fallbackSubscriptionId = String(overrides.subscriptionId ?? subscriptionInput).trim();
    const requestedSubscriptionId = requestedSubscriptionIds[0] || fallbackSubscriptionId;
    const effectiveSubscriptionIds = requestedSubscriptionIds.length
      ? requestedSubscriptionIds
      : (requestedSubscriptionId ? [requestedSubscriptionId] : []);
    const requestedSubscriptionName = String(
      overrides.subscriptionName
      || resolveSubscriptionDisplayName(relData, requestedSubscriptionId, subscriptionNameMap)
      || ''
    ).trim();
    const requestedResourceGroup = String(overrides.resourceGroup ?? resourceGroupInput).trim();

    if (!requestedSubscriptionId) {
      setDiscoverStatus('error');
      setDiscoverMessage('Please select at least one Subscription ID.');
      showToast('high', 'Discovery Input Required', 'Please select at least one Subscription ID.', 5000);
      pushEventNotification('high', 'Discovery Input Required', 'Please select at least one Subscription ID.');
      return false;
    }

    if (effectiveScopeType === 'resource-group' && !requestedResourceGroup) {
      setDiscoverStatus('error');
      setDiscoverMessage('Please enter a Resource Group name.');
      showToast('high', 'Discovery Input Required', 'Please enter a Resource Group name.', 5000);
      pushEventNotification('high', 'Discovery Input Required', 'Please enter a Resource Group name.');
      return false;
    }

    discoveryInFlightRef.current = true;
    setLoading(true);
    setArchData(null);
    setRelData(null);
    setDiscoverStatus('loading');
    setDiscoverMessage('Loading');

    const storeDiscoveryMarkdown = async ({
      payload,
      nextScopeType,
      nextSubscriptionIds,
      nextSubscriptionId,
      nextSubscriptionName,
      nextRegion,
    }) => {
      return;
      const markdown = generateMarkdownFromJson(payload, {
        title: 'Discovery Payload',
        maskSecrets: false,
      });

      if (!WEBPUBSUB_NEGOTIATE_URL && !TRIGGER_URL) {
        return;
      }

      const fileName = buildDiscoveryMarkdownFileName(
        nextScopeType,
        nextSubscriptionIds?.length ? nextSubscriptionIds : [nextSubscriptionId]
      );

      const storePayload = {
        request: 'store',
        type: 'store',
        format: 'markdown',
        fileName,
        scope_type: nextScopeType,
        subscription_id: nextSubscriptionId,
        subscription_ids: nextSubscriptionIds,
        subscription_name: nextSubscriptionName || nextSubscriptionId,
        region: nextRegion,
        data: markdown,
        raw_payload: payload,
      };

      if (WEBPUBSUB_NEGOTIATE_URL) {
        await sendWebPubSubEvent(storePayload);
      } else {
        const storeResponse = await fetch(TRIGGER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(storePayload),
        });

        if (!storeResponse.ok) {
          throw new Error(`Store trigger responded with HTTP ${storeResponse.status} ${storeResponse.statusText}`);
        }
      }
    };

    try {
      if (!LOGIC_APP_URL) {
        throw new Error('Logic App URL is not configured. Set REACT_APP_LOGIC_APP_URL in environment variables.');
      }

      const subscriptionIdPayload = effectiveSubscriptionIds.join(',');

      const res = await fetch(LOGIC_APP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription_id: subscriptionIdPayload,
          subscription_name: requestedSubscriptionName || requestedSubscriptionId,
        }),
      });

      if (!res.ok) {
        throw new Error(`Logic App responded with HTTP ${res.status} ${res.statusText}`);
      }

      const result = await res.json();
      setRawDiscoveryResponse(result);

      const responseSubscriptionId = String(result?.subscription_id || '').trim();
      const responseSubscriptionName = result?.subscription_name;
      if (responseSubscriptionId && responseSubscriptionName !== undefined && responseSubscriptionName !== null) {
        const resolvedResponseName = String(responseSubscriptionName);
        setSubscriptionNameMap((prev) => ({
          ...prev,
          [responseSubscriptionId]: resolvedResponseName,
          [normalizeSubscriptionIdentity(responseSubscriptionId)]: resolvedResponseName,
        }));
      }

      const responseStatus = String(result?.status || result?.result || '').toLowerCase();
      const logicAppFailed =
        result?.success === false
        || responseStatus === 'failed'
        || responseStatus === 'error';
      if (logicAppFailed) {
        throw new Error(
          result?.message
          || result?.error
          || result?.errorMessage
          || 'Logic App returned a failure response.'
        );
      }

      const {
        architecturePayload,
        relationPayload,
        costAnalysisPayload,
        costOptimizationPayload,
        securityRisksPayload,
        scoreSummaryPayload,
        policyInfoPayload,
      } = extractDiscoveryPayload(result);

      const hasCoreData = Boolean(architecturePayload || relationPayload);
      const hasInsightData = Boolean(
        scoreSummaryPayload
        || securityRisksPayload
        || costAnalysisPayload
        || costOptimizationPayload
        || policyInfoPayload
      );

      if (!hasCoreData && !hasInsightData) {
        throw new Error('Logic App response is missing expected dashboard payload (architecture/relation or score/risk data).');
      }

      try {
        await storeDiscoveryMarkdown({
          payload: result,
          nextScopeType: effectiveScopeType,
          nextSubscriptionIds: effectiveSubscriptionIds,
          nextSubscriptionId: requestedSubscriptionId,
          nextSubscriptionName: requestedSubscriptionName,
          nextRegion: effectiveRegion,
        });
      } catch (storeError) {
        const storeMessage = `Markdown store skipped: ${storeError?.message || 'Unknown error'}`;
        pushEventNotification('medium', 'Markdown Store Warning', storeMessage);
      }

      setArchData(architecturePayload || null);
      setRelData(relationPayload || { data: { subscriptions: {} } });
      setApiCostAnalysis(costAnalysisPayload);
      setApiCostOptimization(costOptimizationPayload);
      setApiSecurityRisks(securityRisksPayload);
      setApiScoreSummary(scoreSummaryPayload);
      setApiPolicyDemoData(policyInfoPayload || null);
      setScopeType(effectiveScopeType);
      setSubscriptionId(requestedSubscriptionId);
      setSubscriptionInput(requestedSubscriptionId);
      const discoveredSubscriptionIds = requestedSubscriptionIds.length ? requestedSubscriptionIds : [requestedSubscriptionId];
      setSelectedSubscriptionIds(discoveredSubscriptionIds);
      // Sync cost analysis to the discovered subscriptions by default
      setReportSubscriptionIds(discoveredSubscriptionIds);
      setReportScope('Subscription');
      setReportResourceGroup('');
      setReportResource('');
      setRegion(effectiveRegion);
      setScopeRegion(effectiveScopeRegion);
      setScopeCriteria(effectiveScopeCriteria);
      setCurrentArchitectureScope((prev) => ({
        ...prev,
        scopeType: effectiveScopeType,
        scopeName: requestedSubscriptionIds.length > 1 ? `${requestedSubscriptionIds.length} subscriptions` : requestedSubscriptionId,
        selectedSubscriptionId: requestedSubscriptionId,
        selectedResourceGroup: effectiveScopeType === 'resource-group' ? requestedResourceGroup : '',
        scopedArchData: architecturePayload || null,
      }));

      // Auto-load baseline application architecture diagram using Function App URL by subscription name
      const targetArchName = String(
        (effectiveScopeType === 'resource-group' && requestedResourceGroup)
          ? requestedResourceGroup
          : (responseSubscriptionName || requestedSubscriptionName || requestedSubscriptionId || '')
      ).trim();
      const targetIsSubscriptionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetArchName);

      if (targetArchName && !targetIsSubscriptionId) {
        fetchArchitectureFromFunctionByName(targetArchName)
          .then((asset) => {
            if (asset) {
              setApplicationArchitecture(asset);
            }
          })
          .catch((archErr) => {
            console.warn(`No application architecture diagram found for "${targetArchName}":`, archErr?.message || archErr);
          });
      }

      setDiscoverStatus('success');
      setDiscoverMessage('Discovery completed.');
      return true;
    } catch (e) {
      const message = 'Failed, contact Developer';
      setDiscoverStatus('error');
      setDiscoverMessage(message);
      showToast('high', 'Discovery Failed', message, 5000);
      pushEventNotification('high', 'Discovery Failed', message);
      return false;
    } finally {
      setLoading(false);
      discoveryInFlightRef.current = false;
    }
  };

  const handleLoadDemoData = async () => {
    setLoading(true);
    setDiscoverStatus('loading');
    setDiscoverMessage('Loading local demo data...');

    try {
      const [architectureRes, relationRes, costRes, advisorRes, policyRes] = await Promise.all([
        fetch('./demo-data/demo-architecture.json'),
        fetch('./demo-data/demo-relation-mapping.json'),
        fetch('./demo-data/demo-cost.json').catch(() => null),
        fetch('./demo-data/demo-advisor.json').catch(() => null),
        fetch('./demo-data/demo-policy.json').catch(() => null),
      ]);

      if (!architectureRes.ok) {
        throw new Error(`Demo architecture fetch failed: HTTP ${architectureRes.status}`);
      }
      if (!relationRes.ok) {
        throw new Error(`Demo relation mapping fetch failed: HTTP ${relationRes.status}`);
      }

      const [architectureRaw, relationRaw] = await Promise.all([
        architectureRes.json(),
        relationRes.json(),
      ]);

      const costRaw = costRes?.ok ? await costRes.json().catch(() => null) : null;
      const advisorRaw = advisorRes?.ok ? await advisorRes.json().catch(() => null) : null;
      const policyRaw = policyRes?.ok ? await policyRes.json().catch(() => null) : null;

      setRawDiscoveryResponse({
        source: 'demo',
        architecture: architectureRaw,
        relationships: relationRaw,
        costAnalysis: costRaw,
        advisor: advisorRaw,
        policy: policyRaw,
      });

      const architecturePayload = normalizeArchitecturePayload(architectureRaw);
      const relationPayload = normalizeRelationPayload(relationRaw);
      const costAnalysisPayload = normalizeCostAnalysisPayload(costRaw);
      const securityRisksPayload = normalizeSecurityRisksPayload(advisorRaw?.recommendations || advisorRaw?.findings || advisorRaw);
      const scoreSummaryPayload = normalizeScoreSummaryPayload(advisorRaw?.scoreSummary || advisorRaw);

      if (!architecturePayload || !relationPayload) {
        throw new Error('Demo files are present but contain invalid payload format.');
      }

      const demoSubscriptionIds = Object.keys(relationPayload?.data?.subscriptions || {});

      setArchData(architecturePayload);
      setRelData(relationPayload);
      setApiCostAnalysis(costAnalysisPayload);
      setApiCostOptimization(null);
      setApiSecurityRisks(securityRisksPayload);
      setApiScoreSummary(scoreSummaryPayload);
      setApiPolicyDemoData(policyRaw && typeof policyRaw === 'object' ? policyRaw : null);
      setScopeType('subscription');
      setSelectedSubscriptionIds(demoSubscriptionIds);
      setReportSubscriptionIds(demoSubscriptionIds);
      setReportScope('Subscription');
      setReportResourceGroup('');
      setReportResource('');
      setSubscriptionInput(demoSubscriptionIds[0] || '');
      setSubscriptionId(demoSubscriptionIds[0] || '');
      setCurrentArchitectureScope((prev) => ({
        ...prev,
        scopeType: 'subscription',
        scopeName: demoSubscriptionIds.length > 1 ? `${demoSubscriptionIds.length} subscriptions` : (demoSubscriptionIds[0] || ''),
        selectedSubscriptionId: demoSubscriptionIds[0] || '',
        selectedResourceGroup: '',
        scopedArchData: architecturePayload,
      }));
      setDiscoverStatus('success');
      setDiscoverMessage(
        `Demo data loaded: ${demoSubscriptionIds.length} subscription${demoSubscriptionIds.length === 1 ? '' : 's'}.`
      );
      showToast('info', 'Demo Data Loaded', 'Local demo architecture has been loaded successfully.', 4000);
      pushEventNotification('info', 'Demo Data Loaded', 'Local demo architecture dataset is active.');
      return true;
    } catch (e) {
      const message = `Failed to load demo data: ${e?.message || 'Unknown error'}`;
      setDiscoverStatus('error');
      setDiscoverMessage(message);
      showToast('high', 'Demo Load Failed', message, 5000);
      pushEventNotification('high', 'Demo Load Failed', message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  // Auto trigger from URL params (run once per page load).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (autoDiscoverTriggeredRef.current) return;

    const autoIntent = parseAutoDiscoverIntentFromUrl();
    if (!autoIntent) return;

    autoDiscoverTriggeredRef.current = true;
    setActiveNav('overview');

    if (autoIntent.mode === 'demo') {
      setDiscoverStatus('loading');
      setDiscoverMessage('Auto trigger detected (demo). Loading demo data...');
      void handleLoadDemoData();
      return;
    }

    if (autoIntent.mode === 'subscription' && autoIntent.subscriptionId) {
      const normalizedSubscriptionId = autoIntent.subscriptionId;
      setScopeType('subscription');
      setSelectedSubscriptionIds([normalizedSubscriptionId]);
      setSubscriptionInput(normalizedSubscriptionId);
      setSubscriptionId(normalizedSubscriptionId);
      setReportSubscriptionIds([normalizedSubscriptionId]);
      setDiscoverStatus('loading');
      setDiscoverMessage(`Auto trigger detected for subscription ${normalizedSubscriptionId}. Starting discovery...`);

      void handleDiscover({
        scopeType: 'subscription',
        selectedSubscriptionIds: [normalizedSubscriptionId],
        subscriptionId: normalizedSubscriptionId,
        region: scopeRegion || region,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, scopeRegion]);

  // Auto-run Overview discovery when user opens Overview and scope is already selected.
  // This keeps Overview independent from Drift page actions.
  useEffect(() => {
    if (activeNav !== 'overview') return;
    if (loading) return;
    if (discoverStatus !== 'idle') return;
    if (archData || relData) return;

    const requestedSubscriptionIds = selectedSubscriptionIds
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    const fallbackSubscriptionId = String(subscriptionInput || '').trim();
    const requestedSubscriptionId = requestedSubscriptionIds[0] || fallbackSubscriptionId;

    if (!requestedSubscriptionId) return;

    void handleDiscover({
      scopeType: 'subscription',
      selectedSubscriptionIds: requestedSubscriptionIds.length
        ? requestedSubscriptionIds
        : [requestedSubscriptionId],
      subscriptionId: requestedSubscriptionId,
      region: scopeRegion || region,
    });
  }, [
    activeNav,
    loading,
    discoverStatus,
    archData,
    relData,
    selectedSubscriptionIds,
    subscriptionInput,
    scopeRegion,
    region,
  ]);

  const renderPage = () => {
    switch (activeNav) {
      case 'overview':
        return (
          <div className="page-body">
            <div className="overview-scope-banner">
              <div>
                <strong>Overview Results</strong>
                <div className="overview-scope-meta">
                  Showing results for {selectedSubscriptionSummary.length || 0} subscription{selectedSubscriptionSummary.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className="overview-scope-list">
                {selectedSubscriptionSummary.map((item) => (
                  <div key={item.id} className="overview-scope-pill">
                    <strong>{item.name}</strong>
                    <span>{item.id}</span>
                  </div>
                ))}
              </div>
            </div>
            <StatsCards data={scopedRelData} loading={loading} />
            <div className="middle-row">
              <ArchitectureDiagram
                archData={filteredArchDataByScope}
                relData={relData}
                apiCostAnalysis={apiCostAnalysis}
                selectedSubscriptionIds={selectedSubscriptionIds}
                selectedSubscriptionSummary={selectedSubscriptionSummary}
                discoveryStatus={discoverStatus}
                discoveryMessage={discoverMessage}
                persistentState={architecturePersistentState}
                onPersistentStateChange={setArchitecturePersistentState}
                onScopeChange={setCurrentArchitectureScope}
                applicationArchitecture={applicationArchitecture}
                onApplicationArchitectureChange={setApplicationArchitecture}
              />
              <OverviewScoreCard data={scopedRelData} apiScoreSummary={apiScoreSummary} />
            </div>
            <div className="bottom-row">
              <TopFindings data={scopedRelData} apiFindings={apiSecurityRisks} />
              <ResourceInventory data={scopedRelData} onViewAll={() => setActiveNav('reports')} />
              <ChatPanel
                relData={scopedRelData}
                scopedArchData={chatScopedArchData}
                scopeName={chatScopeName}
                scopeType={chatScopeType}
                subscriptionKey={chatSubscriptionKey}
                knowledgeSources={chatKnowledgeSources}
                knowledgeCache={subscriptionKnowledgeCache}
                setKnowledgeCache={setSubscriptionKnowledgeCache}
                driftPayload={currentArchitectureScope.drift}
                sharedMessages={copilotMessages}
                setSharedMessages={setCopilotMessages}
                showHistoryButton={false}
                hasSelectedSubscription={selectedSubscriptionIds.length > 0}
                snapshotTriggered={snapshotTriggered}
              />
            </div>
          </div>
        );

      case 'architecture':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Architecture Diagram</h2>
              <p>Visual map of your Azure resources and their relationships</p>
            </div>
            <div style={{ flex: 1, minHeight: 560, display: 'flex', flexDirection: 'column' }}>
              <ArchitectureDiagram
                archData={filteredArchDataByScope}
                relData={relData}
                apiCostAnalysis={apiCostAnalysis}
                selectedSubscriptionIds={selectedSubscriptionIds}
                selectedSubscriptionSummary={selectedSubscriptionSummary}
                discoveryStatus={discoverStatus}
                discoveryMessage={discoverMessage}
                driftViewVariant="lifecycle"
                persistentState={architecturePersistentState}
                onPersistentStateChange={setArchitecturePersistentState}
                onScopeChange={setCurrentArchitectureScope}
                applicationArchitecture={applicationArchitecture}
                onApplicationArchitectureChange={setApplicationArchitecture}
              />
            </div>
          </div>
        );

      case 'risks':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Reviews &amp; Risks</h2>
              <p>Security and compliance findings detected in your environment</p>
            </div>
            <div className="single-panel-view">
              <TopFindings data={relData} apiFindings={apiSecurityRisks} />
            </div>
          </div>
        );

      case 'overall-scopes':
        return (
          <div className="page-body">
            <div className="single-panel-view">
              <WellArchitectedScore
                data={scopedRelData}
                relData={relData}
                apiScoreSummary={apiScoreSummary}
                apiSecurityRisks={apiSecurityRisks}
                selectedSubscriptionSummary={selectedSubscriptionSummary}
                selectedSubscriptionIds={selectedSubscriptionIds}
                selectedSubscriptionId={centralScope.enabled ? activeWellScope.subscriptionId : subscriptionId}
                selectedResourceGroup={centralScope.enabled
                  ? activeWellScope.resourceGroup
                  : (scopeType === 'resource-group' ? resourceGroupInput : '')}
                selectedResourceGroupLabel={centralScope.enabled
                  ? (activeWellScope.resourceGroup || 'all')
                  : (scopeType === 'resource-group' ? resourceGroupInput : 'all')}
                onSubscriptionChange={(subId) => {
                  const nextSubscriptionId = String(subId || '').trim();
                  if (centralScope.enabled) {
                    setPageScopeOverrides((prev) => ({
                      ...prev,
                      wellArchitected: { subscriptionId: nextSubscriptionId, resourceGroup: '' },
                    }));
                  } else {
                    setSubscriptionId(nextSubscriptionId);
                    if (nextSubscriptionId) setSubscriptionInput(nextSubscriptionId);
                    setScopeType('subscription');
                    setResourceGroupInput('');
                  }
                }}
                onResourceGroupChange={(rgName) => {
                  const nextResourceGroup = String(rgName || '').trim();
                  if (centralScope.enabled) {
                    setPageScopeOverrides((prev) => ({
                      ...prev,
                      wellArchitected: { ...activeWellScope, resourceGroup: nextResourceGroup },
                    }));
                  } else {
                    setResourceGroupInput(nextResourceGroup);
                    setScopeType(nextResourceGroup ? 'resource-group' : 'subscription');
                  }
                }}
              />
            </div>
          </div>
        );

      case 'drift':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Drift Analysis</h2>
              <p>Compare current architecture against your application baseline to detect deviations</p>
            </div>
            <div style={{ flex: 1, minHeight: 560, display: 'flex', flexDirection: 'column' }}>
              <ArchitectureDiagram
                archData={centralScope.enabled ? centralFilteredArchData : filteredArchDataByScope}
                relData={relData}
                apiCostAnalysis={apiCostAnalysis}
                selectedSubscriptionIds={selectedSubscriptionIds}
                selectedSubscriptionSummary={centralScope.enabled ? centralSelectedSubscriptionSummary : selectedSubscriptionSummary}
                discoveryStatus={discoverStatus}
                discoveryMessage={discoverMessage}
                defaultTab="drift"
                persistentState={architecturePersistentState}
                onPersistentStateChange={setArchitecturePersistentState}
                onScopeChange={(scopeData) => {
                  if (centralScope.enabled) {
                    setPageScopeOverrides((prev) => ({ ...prev, drift: scopeData }));
                  } else {
                    setCurrentArchitectureScope(scopeData);
                  }
                }}
                applicationArchitecture={applicationArchitecture}
                onApplicationArchitectureChange={setApplicationArchitecture}
              />
            </div>
          </div>
        );

      case 'reports':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Cost Analysis</h2>
              <p>Cost trends, detailed breakdown and analysis with multiple dimensions</p>
            </div>
            <div className="reports-layout">
              <div className="reports-top-half">
                <CostManagementBilling
                    data={scopedRelData}
                  apiCostAnalysis={centralScope.enabled ? centralScopedCostAnalysis : apiCostAnalysis}
                    scope={centralScope.enabled ? activeCostScope.scope : reportScope}
                  setScope={(nextScope) => centralScope.enabled
                    ? setPageScopeOverrides((prev) => ({
                      ...prev,
                      costAnalysis: { ...(prev.costAnalysis || activeCostScope), scope: nextScope },
                    }))
                    : setReportScope(nextScope)}
                    selectedSubscription={centralScope.enabled ? activeCostScope.subscriptions : reportSubscriptionIds}
                  setSelectedSubscription={(next) => centralScope.enabled
                    ? setPageScopeOverrides((prev) => ({
                      ...prev,
                      costAnalysis: { ...(prev.costAnalysis || activeCostScope), subscriptions: next },
                    }))
                    : setReportSubscriptionIds(next)}
                    selectedResourceGroup={centralScope.enabled ? activeCostScope.resourceGroup : reportResourceGroup}
                  setSelectedResourceGroup={(next) => centralScope.enabled
                    ? setPageScopeOverrides((prev) => ({
                      ...prev,
                      costAnalysis: {
                        ...(prev.costAnalysis || activeCostScope),
                        resourceGroup: next,
                        resourceGroups: next ? [next] : [],
                      },
                    }))
                    : setReportResourceGroup(next)}
                  selectedResource={reportResource}
                  setSelectedResource={setReportResource}
                />
              </div>
              <div className="reports-analysis-section">
                <CostAnalysisVisualization
                    data={scopedRelData}
                    scope={centralScope.enabled ? activeCostScope.scope : reportScope}
                  selectedSubscription={centralScope.enabled ? activeCostScope.subscriptions : reportSubscriptionIds}
                  selectedResourceGroup={centralScope.enabled ? activeCostScope.resourceGroup : reportResourceGroup}
                  selectedResource={reportResource}
                    apiCostAnalysis={centralScope.enabled ? centralScopedCostAnalysis : apiCostAnalysis}
                />
              </div>
            </div>
          </div>
        );

      case 'cost-optimization':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Cost Optimization Recommendations</h2>
              <p>Actionable suggestions to reduce cloud spend while keeping architecture healthy</p>
            </div>
            <div className="single-panel-view">
              <CostOptimizationRecommendations
                data={scopedRelData}
                apiRecommendations={apiCostOptimization}
                costData={apiCostAnalysis}
              />
            </div>
          </div>
        );

      case 'chat':
        return (
          <div className="page-body">
            <div className="single-panel-view chat-full">
              <ChatPanel
                relData={relData}
                scopedArchData={chatScopedArchData}
                scopeName={chatScopeName}
                scopeType={chatScopeType}
                subscriptionKey={chatSubscriptionKey}
                knowledgeSources={chatKnowledgeSources}
                knowledgeCache={subscriptionKnowledgeCache}
                setKnowledgeCache={setSubscriptionKnowledgeCache}
                driftPayload={currentArchitectureScope.drift}
                sharedMessages={copilotMessages}
                setSharedMessages={setCopilotMessages}
                showHistoryButton
                hasSelectedSubscription={selectedSubscriptionIds.length > 0}
                snapshotTriggered={snapshotTriggered}
              />
            </div>
          </div>
        );

      case 'policy':
        return (
          <PolicyPage
            policySource={apiPolicyDemoData}
            selectedSubscriptionSummary={selectedSubscriptionSummary}
            selectedSubscriptionId={centralScope.enabled ? (centralScope.subscriptionIds.length === 1 ? centralScope.subscriptionIds[0] : '') : subscriptionId}
            onOpenDefinition={() => setActiveNav('policy-definition')}
            onOpenAssignment={(assignment) => {
              setSelectedPolicyAssignment(assignment);
              setPolicyDetailSourceNav('policy');
              setActiveNav('policy-assignment-detail');
            }}
          />
        );

      case 'policy-definition':
        return (
          <PolicyDefinitionPage
            policySource={apiPolicyDemoData}
            selectedSubscriptionSummary={selectedSubscriptionSummary}
            selectedSubscriptionId={subscriptionId}
            onOpenAssignmentPage={() => setActiveNav('policy')}
          />
        );

      case 'policy-assignment-detail':
        return (
          <PolicyAssignmentDetail
            assignment={selectedPolicyAssignment}
            onBack={() => setActiveNav(policyDetailSourceNav || 'policy')}
          />
        );

      case 'settings':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Settings</h2>
              <p>Configure subscription, region, and integration options</p>
            </div>
            <div className="settings-placeholder">
              <h3>Dashboard Settings</h3>
              <div className="settings-central-scope">
                <strong>Central Scope</strong>
                <span>
                  {centralScope.enabled
                    ? `${centralScope.level === 'resource-group' ? 'Resource group' : 'Subscription'} scope applied to analysis pages.`
                    : 'Choose a scope for Drift, Well-Architected, Policy, Cost Optimization, and Cost Analysis.'}
                </span>
                <CentralScopeSelector
                  relData={relData}
                  selectedSubscriptionIds={selectedSubscriptionIds}
                  value={centralScope}
                  onChange={(nextScope) => {
                    setCentralScope(nextScope);
                    setPageScopeOverrides({ drift: null, wellArchitected: null, costAnalysis: null });
                  }}
                />
              </div>
              <div className="settings-option">
                <div>
                  <strong>Theme</strong>
                  <span>{isDarkMode ? 'Dark mode' : 'Light mode'}</span>
                </div>
                <div className="theme-toggle settings-theme-toggle">
                  <Sun size={12} className={!isDarkMode ? 'active' : ''} />
                  <button
                    type="button"
                    className={`toggle-switch ${isDarkMode ? 'on' : 'off'}`}
                    onClick={() => setIsDarkMode((prev) => !prev)}
                    aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                    aria-pressed={isDarkMode}
                  />
                  <Moon size={12} className={isDarkMode ? 'active' : ''} />
                </div>
              </div>
              <div className="settings-option settings-snapshot-option">
                <div>
                  <strong>Create Snapshot</strong>
                  <span>Send the loaded dashboard report to the snapshot Logic App.</span>
                </div>
                <SnapshotCreator
                  endpoint={TRIGGER_URL}
                  disabled={loading || !rawDiscoveryResponse}
                  snapshotInput={{
                    normalized: {
                      overview: { relData },
                      architecture: archData,
                      drift: currentArchitectureScope?.drift,
                      wellArchitected: apiScoreSummary,
                      advisor: apiSecurityRisks,
                      policy: apiPolicyDemoData,
                      costAnalysis: apiCostAnalysis,
                      costOptimization: apiCostOptimization,
                    },
                    scope: {
                      subscriptionIds: selectedSubscriptionIds,
                      subscriptionNames: selectedSubscriptionIds.map((id) => subscriptionNameMap[id] || id),
                      subscriptionId,
                      scopeType,
                      region,
                      scopeCriteria,
                    },
                    sourceStatus: {
                      architecture: { status: archData ? 'complete' : 'missing' },
                      relationships: { status: relData ? 'complete' : 'missing' },
                      costAnalysis: { status: apiCostAnalysis ? 'complete' : 'missing' },
                      costOptimization: { status: apiCostOptimization ? 'complete' : 'missing' },
                      advisor: { status: apiSecurityRisks ? 'complete' : 'missing' },
                      wellArchitected: { status: apiScoreSummary ? 'complete' : 'missing' },
                      policy: { status: apiPolicyDemoData ? 'complete' : 'missing' },
                    },
                  }}
                  onComplete={(snapshot) => {
                    setSnapshotTriggered(true);
                    showToast('info', 'Snapshot Created', `${snapshot.snapshotId} was sent successfully.`, 5000);
                  }}
                  onError={(message) => showToast('high', 'Snapshot Failed', message, 5000)}
                />
              </div>
              <div className="settings-option settings-concern-option">
                <div>
                  <strong>Raise Concern</strong>
                  <span>Send a concern to the support team.</span>
                </div>
                <button type="button" className="discover-btn" onClick={() => setIsConcernModalOpen(true)}>
                  Raise Concern
                </button>
              </div>
              <div className="settings-option settings-webpubsub-option">
                <div>
                  <strong>Azure Web PubSub Connection</strong>
                  <span>
                    {webPubSubStatus.state === 'connected' && (
                      <span style={{ color: '#10b981', fontWeight: 600 }}>● Connected: </span>
                    )}
                    {webPubSubStatus.state === 'error' && (
                      <span style={{ color: '#ef4444', fontWeight: 600 }}>● Error: </span>
                    )}
                    {webPubSubStatus.state === 'testing' && (
                      <span style={{ color: '#3b82f6', fontWeight: 600 }}>● Checking connection... </span>
                    )}
                    {webPubSubStatus.message || 'Check connectivity to the configured Web PubSub WebSocket URL.'}
                  </span>
                </div>
                <button
                  type="button"
                  className="discover-btn"
                  disabled={webPubSubStatus.state === 'testing'}
                  onClick={async () => {
                    setWebPubSubStatus({ state: 'testing', message: 'Testing connection...' });
                    const res = await testWebPubSubConnection();
                    if (res.connected) {
                      setWebPubSubStatus({ state: 'connected', message: res.message });
                      showToast('info', 'Web PubSub Connected', res.message, 4500);
                    } else {
                      setWebPubSubStatus({ state: 'error', message: res.message });
                      showToast('high', 'Web PubSub Connection Failed', res.message, 5000);
                    }
                  }}
                >
                  {webPubSubStatus.state === 'testing' ? 'Checking...' : 'Check Connection'}
                </button>
              </div>
            </div>
            {isConcernModalOpen && (
              <div className="concern-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="concern-modal-title">
                <form className="concern-modal" onSubmit={handleSendConcern}>
                  <div className="concern-modal-header">
                    <h3 id="concern-modal-title">Raise Concern</h3>
                    <button type="button" className="scope-modal-close" onClick={() => setIsConcernModalOpen(false)} aria-label="Close concern form">×</button>
                  </div>
                  <div className="concern-form-grid">
                    <label className="concern-field">
                      <span>ID Type</span>
                      <select value={concernForm.idType} onChange={(event) => setConcernForm((prev) => ({ ...prev, idType: event.target.value }))}>
                        <option value="TID">TID</option>
                        <option value="SID">SID</option>
                      </select>
                    </label>
                    <label className="concern-field">
                      <span>{concernForm.idType}</span>
                      <input value={concernForm.id} onChange={(event) => setConcernForm((prev) => ({ ...prev, id: event.target.value }))} placeholder={`Enter ${concernForm.idType}`} autoComplete="off" />
                    </label>
                    <label className="concern-field">
                      <span>Name</span>
                      <input value={concernForm.name} onChange={(event) => setConcernForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Enter your name" autoComplete="name" />
                    </label>
                    <label className="concern-field">
                      <span>Email</span>
                      <input type="email" value={concernForm.email} onChange={(event) => setConcernForm((prev) => ({ ...prev, email: event.target.value }))} placeholder="name@example.com" autoComplete="email" />
                    </label>
                    <label className="concern-field concern-field-wide">
                      <span>Concern</span>
                      <textarea value={concernForm.concern} onChange={(event) => setConcernForm((prev) => ({ ...prev, concern: event.target.value }))} placeholder="Describe your concern" rows={5} />
                    </label>
                  </div>
                  <div className="concern-modal-actions">
                    <button type="button" className="scope-type-btn" onClick={() => setIsConcernModalOpen(false)}>Cancel</button>
                    <button type="submit" className="discover-btn" disabled={isSendingConcern}>{isSendingConcern ? 'Sending...' : 'Send'}</button>
                  </div>
                </form>
              </div>
            )}
          </div>
        );

      case 'notifications':
        return (
          <div className="page-body">
            <div className="nav-page-header">
              <h2>Notifications</h2>
              <p>Recent alerts and system events from your Azure environment</p>
            </div>
            {renderNotificationsContent()}
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        activeNav={activeNav}
        setActiveNav={setActiveNav}
        isDarkMode={isDarkMode}
        onToggleTheme={() => setIsDarkMode((prev) => !prev)}
      />

      <div className="main-content">
        <Header
          scopeType={scopeType}
          setScopeType={setScopeType}
          subscriptionId={subscriptionInput}
          setSubscriptionId={setSubscriptionInput}
          selectedSubscriptionIds={selectedSubscriptionIds}
          setSelectedSubscriptionIds={setSelectedSubscriptionIds}
          resourceGroup={resourceGroupInput}
          setResourceGroup={setResourceGroupInput}
          region={region}
          setRegion={setRegion}
          scopeRegion={scopeRegion}
          setScopeRegion={setScopeRegion}
          scopeCriteria={scopeCriteria}
          setScopeCriteria={setScopeCriteria}
          relData={relData}
          onDiscover={handleDiscover}
          onLoadDemoData={handleLoadDemoData}
          onSubscriptionNamesChange={(nameMap) => setSubscriptionNameMap((prev) => ({ ...prev, ...nameMap }))}
          loading={loading}
          onNotifications={toggleNotificationsDrawer}
        />

        {discoverStatus !== 'idle' && discoverStatus !== 'success' && discoverMessage && (
          <div className={`discover-status-banner discover-status-${discoverStatus}`}>
            <span className={discoverStatus === 'loading' ? 'spinner spinner-sm spinner-ring' : 'discover-status-dot'} />
            <span>{discoverMessage}</span>
          </div>
        )}

        {toast && (
          <div className={`toast-alert toast-${toast.type}`}>
            <div className="toast-title">{toast.title}</div>
            <div className="toast-body">{toast.body}</div>
          </div>
        )}

        {isNotificationsOpen && (
          <>
            <div
              className="notif-drawer-backdrop"
              onClick={toggleNotificationsDrawer}
              aria-hidden="true"
            />
            <aside className="notif-drawer" aria-label="Notifications drawer">
              <div className="notif-drawer-header">
                <div>
                  <h3>Notifications</h3>
                  <p>Recent alerts and system events</p>
                </div>
                <button
                  type="button"
                  className="notif-drawer-close"
                  onClick={toggleNotificationsDrawer}
                  aria-label="Close notifications"
                >
                  ×
                </button>
              </div>
              <div className="notif-drawer-content">
                {renderNotificationsContent()}
              </div>
            </aside>
          </>
        )}

        {renderPage()}

        <div className="bottom-toolbar">
          <button className="toolbar-btn" onClick={handleExportSvg}><Share2 size={13} /> Export as SVG</button>
          <button className="toolbar-btn" onClick={handleExportPng}><Download size={13} /> Export as PNG</button>
          <button className="toolbar-btn" onClick={handleGenerateReport}><FileText size={13} /> Generate Report</button>
          <button className="toolbar-btn primary" onClick={handleCreateRemediationBacklog}><CheckSquare size={13} /> Create Remediation Backlog</button>
        </div>

        {exportModal.open && (
          <div className="scope-modal-backdrop" role="dialog" aria-modal="true">
            <div className="scope-modal scope-modal-wide export-preview-modal">
              <div className="scope-modal-header">
                <h3>
                  {exportModal.kind === 'report'
                    ? 'Report Preview'
                    : exportModal.kind === 'backlog'
                      ? 'Remediation Backlog Preview'
                      : `Export Preview (${String(exportModal.format || '').toUpperCase()})`}
                </h3>
                <button
                  type="button"
                  className="scope-modal-close"
                  aria-label="Close export preview"
                  onClick={closeExportModal}
                >
                  ×
                </button>
              </div>

              <div className="export-preview-body">
                {exportModal.loading && (
                  <div className="export-preview-loading">
                    <span className="spinner spinner-md spinner-orbit" />
                    <span>Preparing preview...</span>
                  </div>
                )}

                {!exportModal.loading && exportModal.kind === 'image' && (
                  <>
                    <div className="export-preview-image-wrap">
                      <div className={`export-crop-canvas ${exportModal.cropEnabled ? 'crop-enabled' : ''}`}>
                        <img
                          ref={exportPreviewImageRef}
                          src={exportModal.rawDataUrl}
                          alt="Export preview"
                          className="export-preview-image"
                        />
                        {exportModal.cropEnabled && exportModal.imageWidth > 0 && exportModal.imageHeight > 0 && (
                          <div
                            className="export-crop-box"
                            style={{
                              left: `${(exportModal.crop.x / exportModal.imageWidth) * 100}%`,
                              top: `${(exportModal.crop.y / exportModal.imageHeight) * 100}%`,
                              width: `${(exportModal.crop.width / exportModal.imageWidth) * 100}%`,
                              height: `${(exportModal.crop.height / exportModal.imageHeight) * 100}%`,
                            }}
                          >
                            <button
                              type="button"
                              className="export-crop-handle handle-nw"
                              onPointerDown={(event) => handleCropCornerPointerDown('nw', event)}
                              aria-label="Resize crop from top-left corner"
                            />
                            <button
                              type="button"
                              className="export-crop-handle handle-ne"
                              onPointerDown={(event) => handleCropCornerPointerDown('ne', event)}
                              aria-label="Resize crop from top-right corner"
                            />
                            <button
                              type="button"
                              className="export-crop-handle handle-sw"
                              onPointerDown={(event) => handleCropCornerPointerDown('sw', event)}
                              aria-label="Resize crop from bottom-left corner"
                            />
                            <button
                              type="button"
                              className="export-crop-handle handle-se"
                              onPointerDown={(event) => handleCropCornerPointerDown('se', event)}
                              aria-label="Resize crop from bottom-right corner"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="export-preview-controls">
                      <div className="export-preview-meta">
                        Size: {exportModal.imageWidth} × {exportModal.imageHeight}px
                      </div>
                      <label className="export-crop-toggle">
                        <input
                          type="checkbox"
                          checked={exportModal.cropEnabled}
                          onChange={(event) => setExportModal((prev) => ({ ...prev, cropEnabled: event.target.checked }))}
                        />
                        Enable crop
                      </label>
                      <div className="export-crop-help">
                        Drag any corner handle on the preview image to resize the crop area.
                      </div>
                      <div className="export-crop-values" aria-live="polite">
                        X: {exportModal.crop.x}px · Y: {exportModal.crop.y}px · Width: {exportModal.crop.width}px · Height: {exportModal.crop.height}px
                      </div>
                      <button
                        type="button"
                        className="scope-save-btn"
                        disabled={!exportModal.cropEnabled}
                        onClick={() => setExportModal((prev) => ({
                          ...prev,
                          crop: {
                            x: 0,
                            y: 0,
                            width: prev.imageWidth,
                            height: prev.imageHeight,
                          },
                        }))}
                      >
                        Reset crop
                      </button>
                    </div>
                  </>
                )}

                {!exportModal.loading && exportModal.kind === 'report' && (
                  <div className="export-report-frame-wrap">
                    <iframe title="Report preview" className="export-report-frame" srcDoc={exportModal.reportHtml} />
                  </div>
                )}

                {!exportModal.loading && exportModal.kind === 'backlog' && (
                  <div className="export-backlog-wrap">
                    <div className="export-preview-meta">
                      Rows: {exportModal.backlogRows.length}
                    </div>
                    <div className="export-backlog-table-wrap">
                      <table className="export-backlog-table">
                        <thead>
                          <tr>
                            {exportModal.backlogHeaders.map((header) => (
                              <th key={header}>{header}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {exportModal.backlogRows.map((row, rowIndex) => (
                            <tr key={`${row[0]}-${rowIndex}`}>
                              {row.map((value, colIndex) => (
                                <td key={`${rowIndex}-${colIndex}`}>{String(value ?? '')}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {!!exportModal.error && (
                  <div className="scope-helper scope-helper-stage">{exportModal.error}</div>
                )}
              </div>

              <div className="scope-modal-actions scope-modal-actions-split">
                <button type="button" className="scope-save-btn" onClick={closeExportModal}>Cancel</button>
                {exportModal.kind === 'backlog' && (
                  <button
                    type="button"
                    className="scope-save-btn"
                    onClick={handleSendRemediationBacklogMail}
                    disabled={exportModal.loading || isSendingBacklogMail}
                  >
                    {isSendingBacklogMail ? 'Sending Mail...' : 'Send Mail'}
                  </button>
                )}
                <button
                  type="button"
                  className="scope-save-btn scope-discover-btn"
                  onClick={handleGenerateFromPreview}
                  disabled={exportModal.loading || isSendingBacklogMail}
                >
                  {exportModal.kind === 'report'
                    ? 'Generate Report'
                    : exportModal.kind === 'backlog'
                      ? 'Generate Backlog CSV'
                      : 'Generate Export'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
