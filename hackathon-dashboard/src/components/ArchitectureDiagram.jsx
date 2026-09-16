import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  useNodesState, useEdgesState
} from 'reactflow';
import { queryDriftComparison, queryResourceTokensFromImage } from '../utils/openAIIntegration';
import 'reactflow/dist/style.css';

const RUNTIME_ENV = (typeof window !== 'undefined' && window._env_) || {};
const APPLICATION_ARCHITECTURE_FUNCTION_URL = RUNTIME_ENV.APPLICATION_ARCHITECTURE_FUNCTION_URL || '';

const TYPE_COLORS = {
  'subscription': '#1e40af',
  'resource_group': '#0284c7',
  'microsoft.network/virtualnetworks': '#7c3aed',
  'microsoft.network/virtualnetworks/subnets': '#6d28d9',
  'microsoft.compute/virtualmachines': '#d97706',
  'microsoft.web/sites': '#059669',
  'microsoft.storage/storageaccounts': '#0891b2',
  'microsoft.keyvault/vaults': '#dc2626',
  'microsoft.insights/components': '#7c3aed',
  'microsoft.cognitiveservices/accounts': '#db2777',
  'contains': '#94a3b8',
  'default': '#64748b',
};

// Edge style constants to avoid recreating them on every render (prevents React Flow warning)
const EDGE_STYLE_CONTAINS = { stroke: '#cbd5e1', strokeWidth: 1.5 };
const EDGE_STYLE_ANIMATED = { stroke: '#4f8ef7', strokeWidth: 1.5 };
const EDGE_LABEL_STYLE = { fontSize: 9, fill: '#6b7280' };
const FLOW_FIT_VIEW_OPTIONS = { padding: 0.2 };
const FLOW_PRO_OPTIONS = { hideAttribution: true };
const APPLICATION_TOKEN_CACHE = new Map();
const AZURE_ICON_BASE = '/Azure_Public_Service_Icons/Icons';
const LOCAL_AZURE_ICON_MAP = Object.freeze({
  subscription: `${AZURE_ICON_BASE}/general/10002-icon-service-Subscriptions.svg`,
  resourceGroup: `${AZURE_ICON_BASE}/general/10007-icon-service-Resource-Groups.svg`,
  virtualMachine: `${AZURE_ICON_BASE}/compute/10021-icon-service-Virtual-Machine.svg`,
  vmScaleSet: `${AZURE_ICON_BASE}/compute/10034-icon-service-VM-Scale-Sets.svg`,
  functionApp: `${AZURE_ICON_BASE}/compute/10029-icon-service-Function-Apps.svg`,
  webApp: `${AZURE_ICON_BASE}/compute/10035-icon-service-App-Services.svg`,
  appServicePlan: `${AZURE_ICON_BASE}/app services/00046-icon-service-App-Service-Plans.svg`,
  logicApp: `${AZURE_ICON_BASE}/integration/02631-icon-service-Logic-Apps.svg`,
  virtualNetwork: `${AZURE_ICON_BASE}/networking/10061-icon-service-Virtual-Networks.svg`,
  subnet: `${AZURE_ICON_BASE}/networking/02742-icon-service-Subnet.svg`,
  networkSecurityGroup: `${AZURE_ICON_BASE}/networking/10067-icon-service-Network-Security-Groups.svg`,
  privateEndpoint: `${AZURE_ICON_BASE}/other/02579-icon-service-Private-Endpoints.svg`,
  publicIp: `${AZURE_ICON_BASE}/networking/10069-icon-service-Public-IP-Addresses.svg`,
  networkInterface: `${AZURE_ICON_BASE}/networking/10080-icon-service-Network-Interfaces.svg`,
  routeTable: `${AZURE_ICON_BASE}/networking/10082-icon-service-Route-Tables.svg`,
  managedIdentity: `${AZURE_ICON_BASE}/identity/10227-icon-service-Managed-Identities.svg`,
  storageAccount: `${AZURE_ICON_BASE}/storage/10086-icon-service-Storage-Accounts.svg`,
  keyVault: `${AZURE_ICON_BASE}/security/10245-icon-service-Key-Vaults.svg`,
  applicationInsights: `${AZURE_ICON_BASE}/monitor/00012-icon-service-Application-Insights.svg`,
  logAnalytics: `${AZURE_ICON_BASE}/monitor/00009-icon-service-Log-Analytics-Workspaces.svg`,
  cognitiveServices: `${AZURE_ICON_BASE}/app services/10044-icon-service-Cognitive-Search.svg`,
});

function buildApplicationTokenCacheKey({ isSvg, svgMarkup, imageDataUrl, scopeName }) {
  if (isSvg) {
    const svg = String(svgMarkup || '');
    return `svg::${svg.length}::${svg.slice(0, 120)}::${svg.slice(-120)}`;
  }

  const image = String(imageDataUrl || '');
  const scope = String(scopeName || '').trim().toLowerCase();
  return `image::${scope}::${image.length}::${image.slice(0, 120)}::${image.slice(-120)}`;
}

function getMiniMapNodeColor(node) {
  return node?.style?.background || '#94a3b8';
}

function getNodeColor(label) {
  const l = label.toLowerCase();
  if (l.startsWith('subscription')) return TYPE_COLORS['subscription'];
  if (l.includes('resourcegroup') || l.includes('rg-') || l.includes('_rg')) return TYPE_COLORS['resource_group'];
  if (l.includes('vnet') || l.includes('virtual_network')) return TYPE_COLORS['microsoft.network/virtualnetworks'];
  if (l.includes('subnet') || l.includes('snet')) return TYPE_COLORS['microsoft.network/virtualnetworks/subnets'];
  if (l.includes('keyvault') || l.includes('vault')) return TYPE_COLORS['microsoft.keyvault/vaults'];
  if (l.includes('storage')) return TYPE_COLORS['microsoft.storage/storageaccounts'];
  if (l.includes('insight') || l.includes('monitor')) return TYPE_COLORS['microsoft.insights/components'];
  if (l.includes('openai') || l.includes('cognitive')) return TYPE_COLORS['microsoft.cognitiveservices/accounts'];
  if (l.includes('vm') || l.includes('virtual_machine')) return TYPE_COLORS['microsoft.compute/virtualmachines'];
  if (l.includes('api') || l.includes('function') || l.includes('web') || l.includes('app')) return TYPE_COLORS['microsoft.web/sites'];
  return TYPE_COLORS['default'];
}

// Estimate an approximate monthly cost (USD) for a resource based on its type keywords.
// Deterministic per name so the chart stays stable across renders.
function estimateResourceMonthlyCost(label = '') {
  const l = String(label).toLowerCase();

  // Base monthly rate by resource type (USD)
  let base;
  if (l.includes('vm') || l.includes('virtual_machine') || l.includes('virtualmachine')) base = 210;
  else if (l.includes('aks') || l.includes('kubernetes')) base = 320;
  else if (l.includes('sql') || l.includes('database') || l.includes('cosmos')) base = 260;
  else if (l.includes('openai') || l.includes('cognitive')) base = 180;
  else if (l.includes('appsvc') || l.includes('app-service') || l.includes('web') || l.includes('function') || l.includes('api')) base = 120;
  else if (l.includes('storage') || l.includes('st')) base = 45;
  else if (l.includes('keyvault') || l.includes('vault')) base = 12;
  else if (l.includes('vnet') || l.includes('virtual_network') || l.includes('subnet') || l.includes('snet')) base = 25;
  else if (l.includes('insight') || l.includes('monitor') || l.includes('appinsights')) base = 35;
  else if (l.includes('rg-') || l.includes('resourcegroup')) base = 0; // containers, no direct cost
  else if (l.includes('subscription') || l.includes('sub-')) base = 0;
  else base = 60;

  // Deterministic variance (±30%) derived from the label characters
  let hash = 0;
  for (let i = 0; i < l.length; i += 1) {
    hash = (hash * 31 + l.charCodeAt(i)) % 100000;
  }
  const variance = 0.7 + (hash % 61) / 100; // 0.70 .. 1.30
  return Math.round(base * variance);
}

// Build cost segments for a list of resource labels, sorted high-to-low.
function buildCostSegments(labels = []) {
  const segments = labels
    .map((label) => ({
      label,
      color: getNodeColor(label),
      cost: estimateResourceMonthlyCost(label),
    }))
    .filter((s) => s.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  const total = segments.reduce((sum, s) => sum + s.cost, 0);
  return { segments, total };
}

function normalizeResourceCostKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildExactResourceCostRows(resources = [], costAnalysis = null) {
  const dimensions = Array.isArray(costAnalysis?.dimensions) ? costAnalysis.dimensions : [];
  const resourceDimension = dimensions.find((dimension) => {
    const key = String(dimension?.key || dimension?.dimensionKey || '').toLowerCase();
    if (!/resource/.test(key)) return false;
    return !/resource\s*group|resource_group|resourcegroup/.test(key);
  });
  const resourceGroupDimension = dimensions.find((dimension) => {
    const key = String(dimension?.key || dimension?.dimensionKey || '').toLowerCase();
    return /resource\s*group|resource_group|resourcegroup/.test(key);
  });

  const costRows = Array.isArray(resourceDimension?.data)
    ? resourceDimension.data
        .map((row) => ({
          name: String(row?.name || '').trim(),
          value: Number(row?.value ?? 0),
        }))
        .filter((row) => row.name && Number.isFinite(row.value) && row.value >= 0)
    : [];
  const resourceGroupRows = Array.isArray(resourceGroupDimension?.data)
    ? resourceGroupDimension.data
        .map((row) => ({
          name: String(row?.name || '').trim(),
          value: Number(row?.value ?? 0),
        }))
        .filter((row) => row.name && Number.isFinite(row.value) && row.value >= 0)
    : [];

  if (!Array.isArray(resources) || !resources.length) return [];

  const exactMap = new Map();
  const normalizedRows = costRows.map((row) => {
    const key = normalizeResourceCostKey(row.name);
    if (key && !exactMap.has(key)) {
      exactMap.set(key, row);
    }
    return { ...row, normalized: key };
  });
  const resourceGroupMap = new Map();
  resourceGroupRows.forEach((row) => {
    const key = normalizeResourceCostKey(row.name);
    if (key && !resourceGroupMap.has(key)) {
      resourceGroupMap.set(key, row);
    }
  });

  return resources.map((resourceLabel) => {
    const label = String(resourceLabel || '').trim();
    const normalizedLabel = normalizeResourceCostKey(label);
    const looksLikeResourceGroup = isResourceGroupNode(label);
    let matched = null;

    if (looksLikeResourceGroup && normalizedLabel) {
      matched = resourceGroupMap.get(normalizedLabel) || null;
    }

    if (!matched) {
      matched = normalizedLabel ? exactMap.get(normalizedLabel) : null;
    }

    if (!matched && !looksLikeResourceGroup && normalizedLabel.length >= 4) {
      matched = normalizedRows.find((row) => (
        row.normalized && (row.normalized.includes(normalizedLabel) || normalizedLabel.includes(row.normalized))
      )) || null;
    }

    // Exact fallback: if token is a resource-group label, use RG cost row directly
    if (!matched && normalizedLabel) {
      matched = resourceGroupMap.get(normalizedLabel) || null;
    }

    return {
      label,
      color: getNodeColor(label),
      cost: matched ? Math.round(matched.value * 100) / 100 : null,
      matchedName: matched?.name || '',
    };
  });
}

// Renders an SVG donut chart from cost segments.
function CostDonutChart({ segments, total, size = 150, stroke = 26 }) {
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const arcs = segments.map((seg) => {
    const fraction = total > 0 ? seg.cost / total : 0;
    const dash = fraction * circumference;
    const arc = (
      <circle
        key={seg.label}
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={seg.color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${cx} ${cy})`}
      >
        <title>{`${seg.label}: $${seg.cost}/mo`}</title>
      </circle>
    );
    offset += dash;
    return arc;
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke="#1e293b" strokeWidth={stroke} />
      {arcs}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="18" fontWeight="700" fill="#e2e8f0">
        ${total}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fill="#94a3b8">
        est. / month
      </text>
    </svg>
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getFileNameFromUrl(url, fallbackName = 'application-architecture') {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '';
    const lastSegment = pathname.split('/').filter(Boolean).pop();
    return lastSegment || fallbackName;
  } catch {
    return fallbackName;
  }
}

async function normalizeArchitectureAsset(assetUrl, fallbackName = 'application-architecture') {
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`Architecture asset fetch failed: ${response.status}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const fileName = getFileNameFromUrl(assetUrl, fallbackName);

  if (contentType.includes('image/svg+xml') || contentType.includes('text/xml') || /\.svg(\?|$)/i.test(fileName)) {
    const svgMarkup = await response.text();
    if (!/<svg[\s\S]*?>/i.test(svgMarkup)) {
      throw new Error('Fetched SVG is invalid');
    }
    return { imageSrc: '', svgMarkup, isSvg: true, fileName };
  }

  if (contentType.startsWith('image/')) {
    const blob = await response.blob();
    const imageSrc = await blobToDataUrl(blob);
    return { imageSrc, svgMarkup: '', isSvg: false, fileName };
  }

  const text = await response.text();
  if (/<svg[\s\S]*?>/i.test(text)) {
    return { imageSrc: '', svgMarkup: text, isSvg: true, fileName: fileName.endsWith('.svg') ? fileName : `${fileName}.svg` };
  }
  if (/^https?:\/\//i.test(text.trim())) {
    return normalizeArchitectureAsset(text.trim(), fallbackName);
  }

  throw new Error('Unsupported architecture asset format');
}

export async function fetchArchitectureFromFunctionByName(name) {
  if (!APPLICATION_ARCHITECTURE_FUNCTION_URL) {
    throw new Error('APPLICATION_ARCHITECTURE_FUNCTION_URL is not configured');
  }

  const normalizedName = String(name || '').trim();

  if (!normalizedName) {
    throw new Error('Scope name is required to load application architecture');
  }

  const response = await fetch(APPLICATION_ARCHITECTURE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: normalizedName,
      image_name: normalizedName,
    }),
  });

  if (!response.ok) {
    let details = '';
    try {
      const responseContentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (responseContentType.includes('application/json')) {
        const errorPayload = await response.json();
        details = String(errorPayload?.message || errorPayload?.error || '').trim();
      } else {
        details = (await response.text()).trim();
      }
    } catch (_) {
      details = '';
    }

    throw new Error(details || `Function App call failed: ${response.status}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('image/svg+xml') || contentType.startsWith('image/')) {
    const blob = await response.blob();
    if (contentType.includes('svg')) {
      const svgMarkup = await blob.text();
      if (!/<svg[\s\S]*?>/i.test(svgMarkup)) {
        throw new Error('Function App returned invalid SVG content');
      }
      return { imageSrc: '', svgMarkup, isSvg: true, fileName: `${name}.svg` };
    }
    const imageSrc = await blobToDataUrl(blob);
    const extension = contentType.includes('png') ? 'png' : 'jpg';
    return { imageSrc, svgMarkup: '', isSvg: false, fileName: `${name}.${extension}` };
  }

  if (!contentType.includes('application/json')) {
    const rawText = await response.text();
    if (/^https?:\/\//i.test(rawText.trim())) {
      return normalizeArchitectureAsset(rawText.trim(), name);
    }
    if (/<svg[\s\S]*?>/i.test(rawText)) {
      return { imageSrc: '', svgMarkup: rawText, isSvg: true, fileName: `${name}.svg` };
    }
    throw new Error('Function App returned unsupported response');
  }

  const payload = await response.json();
  const fileName = String(payload.fileName || payload.name || name || 'application-architecture');

  if (payload.svgMarkup && typeof payload.svgMarkup === 'string' && /<svg[\s\S]*?>/i.test(payload.svgMarkup)) {
    return { imageSrc: '', svgMarkup: payload.svgMarkup, isSvg: true, fileName: fileName.endsWith('.svg') ? fileName : `${fileName}.svg` };
  }

  const imageUrl = payload.imageUrl || payload.url || payload.sasUrl || payload.blobUrl;
  if (typeof imageUrl === 'string' && imageUrl.trim()) {
    return normalizeArchitectureAsset(imageUrl.trim(), fileName);
  }

  const base64 = payload.base64 || payload.imageBase64 || payload.contentBase64;
  const payloadContentType = String(payload.contentType || payload.mimeType || '').toLowerCase();
  if (typeof base64 === 'string' && base64.trim()) {
    if (payloadContentType.includes('svg')) {
      const decodedSvg = atob(base64.replace(/^data:[^,]+,/, ''));
      if (!/<svg[\s\S]*?>/i.test(decodedSvg)) {
        throw new Error('Function App returned invalid base64 SVG');
      }
      return { imageSrc: '', svgMarkup: decodedSvg, isSvg: true, fileName: fileName.endsWith('.svg') ? fileName : `${fileName}.svg` };
    }

    const normalizedType = payloadContentType.startsWith('image/') ? payloadContentType : 'image/png';
    const imageSrc = base64.startsWith('data:') ? base64 : `data:${normalizedType};base64,${base64}`;
    return { imageSrc, svgMarkup: '', isSvg: false, fileName };
  }

  throw new Error('Function App response does not include an architecture image');
}

function resolveSelectedScopeName(scope) {
  if (!scope || typeof scope !== 'object') return '';
  if (scope.scopeType === 'resource-group') {
    return String(scope.selectedResourceGroup || scope.scopeName || '').trim();
  }
  return String(scope.scopeName || '').trim();
}

function normalizeResourceNameKey(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addResourceTypeLookupEntry(map, name, resourceType) {
  const key = normalizeResourceNameKey(name);
  if (!key || !resourceType || map.has(key)) return;
  map.set(key, String(resourceType).toLowerCase());
}

function collectNamesFromCategoryValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') return item.name || item.id || '';
        return '';
      })
      .filter(Boolean);
  }
  if (value && typeof value === 'object') {
    return Object.values(value)
      .flatMap((nested) => collectNamesFromCategoryValue(nested));
  }
  return [];
}

function buildResourceTypeLookupFromRelData(relData) {
  const lookup = new Map();
  const subscriptions = relData?.data?.subscriptions || {};

  Object.values(subscriptions).forEach((subscription) => {
    const resourceGroups = subscription?.resource_groups || {};
    Object.entries(resourceGroups).forEach(([resourceGroupName, resourceGroup]) => {
      addResourceTypeLookupEntry(lookup, resourceGroupName, 'resourcegroup');
      const categories = resourceGroup?.categories || {};

      const appServices = categories.app_services || {};
      collectNamesFromCategoryValue(appServices.function_apps).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.web/sites:functionapp'));
      collectNamesFromCategoryValue(appServices.logic_apps).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.logic/workflows'));
      collectNamesFromCategoryValue(appServices.web_apps).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.web/sites'));
      collectNamesFromCategoryValue(appServices.app_service_plans).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.web/serverfarms'));

      const networking = categories.networking || {};
      const virtualNetworks = networking.virtual_networks || {};
      if (virtualNetworks && typeof virtualNetworks === 'object') {
        Object.entries(virtualNetworks).forEach(([vnetName, vnetData]) => {
          addResourceTypeLookupEntry(lookup, vnetName, 'microsoft.network/virtualnetworks');
          collectNamesFromCategoryValue(vnetData?.subnets).forEach((subnetName) => addResourceTypeLookupEntry(lookup, subnetName, 'microsoft.network/virtualnetworks/subnets'));
        });
      }
      collectNamesFromCategoryValue(networking.network_security_groups).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.network/networksecuritygroups'));
      collectNamesFromCategoryValue(networking.public_ip_addresses).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.network/publicipaddresses'));
      collectNamesFromCategoryValue(networking.network_interfaces).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.network/networkinterfaces'));

      const security = categories.security || {};
      collectNamesFromCategoryValue(security.keyvaults).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.keyvault/vaults'));

      const storage = categories.storage || {};
      collectNamesFromCategoryValue(storage.storage_accounts).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.storage/storageaccounts'));

      const compute = categories.compute || {};
      collectNamesFromCategoryValue(compute.virtual_machines).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.compute/virtualmachines'));
      collectNamesFromCategoryValue(compute.virtual_machine_scale_sets).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.compute/virtualmachinescalesets'));

      const monitoring = categories.monitoring || {};
      collectNamesFromCategoryValue(monitoring.application_insights).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.insights/components'));
      collectNamesFromCategoryValue(monitoring.log_analytics_workspaces).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.operationalinsights/workspaces'));

      const identity = categories.identity || {};
      collectNamesFromCategoryValue(identity.managed_identities).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.managedidentity/userassignedidentities'));

      const aiServices = categories.ai_services || {};
      collectNamesFromCategoryValue(aiServices.openai_resources).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.cognitiveservices/accounts'));
      collectNamesFromCategoryValue(aiServices.cognitive_services).forEach((name) => addResourceTypeLookupEntry(lookup, name, 'microsoft.cognitiveservices/accounts'));
    });
  });

  return lookup;
}

function buildResourceTypeLookupFromArchData(archData) {
  const lookup = new Map();
  const relationships = Array.isArray(archData?.relationships) ? archData.relationships : [];

  relationships.forEach((rel) => {
    addResourceTypeLookupEntry(lookup, rel?.source, rel?.source_type);
    addResourceTypeLookupEntry(lookup, rel?.target, rel?.target_type);
  });

  return lookup;
}

function inferResourceTypeFromName(name = '') {
  const lower = String(name || '').trim().toLowerCase();
  if (!lower) return '';

  if (lower.startsWith('sub-')) return 'subscription';
  if (lower.startsWith('rg-')) return 'resourcegroup';
  if (lower.startsWith('fun-') || lower.startsWith('fn-')) return 'microsoft.web/sites:functionapp';
  if (lower.startsWith('vnet-')) return 'microsoft.network/virtualnetworks';
  if (lower.startsWith('snet-') || lower.startsWith('subnet-')) return 'microsoft.network/virtualnetworks/subnets';
  if (lower.startsWith('asp-')) return 'microsoft.web/serverfarms';
  if (lower.startsWith('lapp')) return 'microsoft.logic/workflows';
  if (lower.startsWith('law')) return 'microsoft.operationalinsights/workspaces';
  if (lower.startsWith('mi-') || lower.startsWith('mi_')) return 'microsoft.managedidentity/userassignedidentities';
  if (lower.startsWith('nsg-')) return 'microsoft.network/networksecuritygroups';
  if (lower.startsWith('rt-')) return 'microsoft.network/routetables';
  if (lower.startsWith('pe-')) {
    if (lower.includes('.nic')) return 'microsoft.network/networkinterfaces';
    return 'microsoft.network/privateendpoints';
  }

  const armTypeMatch = lower.match(/providers\/([^/]+\/[a-z0-9./-]+)/i);
  if (armTypeMatch?.[1]) return armTypeMatch[1].toLowerCase();

  if (lower.includes('virtual machine') && lower.includes('scale')) return 'microsoft.compute/virtualmachinescalesets';
  if (lower.includes('virtual machine') || lower.includes('vm-')) return 'microsoft.compute/virtualmachines';
  if (lower.includes('function') || lower.includes('func-')) return 'microsoft.web/sites:functionapp';
  if (lower.includes('logic app') || lower.includes('logic-')) return 'microsoft.logic/workflows';
  if (lower.includes('app service plan')) return 'microsoft.web/serverfarms';
  if (lower.includes('web app') || lower.includes('web-') || lower.includes('webapp')) return 'microsoft.web/sites';
  if (lower.includes('private endpoint')) return 'microsoft.network/privateendpoints';
  if (lower.includes('route table')) return 'microsoft.network/routetables';
  if (lower.includes('network interface') || lower.includes('nic-')) return 'microsoft.network/networkinterfaces';
  if (lower.includes('network security group') || lower.includes('nsg')) return 'microsoft.network/networksecuritygroups';
  if (lower.includes('public ip') || lower.includes('pip-')) return 'microsoft.network/publicipaddresses';
  if (lower.includes('virtual network') || lower.includes('vnet')) return 'microsoft.network/virtualnetworks';
  if (lower.includes('subnet') || lower.includes('snet')) return 'microsoft.network/virtualnetworks/subnets';
  if (lower.includes('managed identity')) return 'microsoft.managedidentity/userassignedidentities';
  if (lower.includes('log analytics') || lower.includes('loganalytic')) return 'microsoft.operationalinsights/workspaces';
  if (lower.includes('application insight') || lower.includes('appi-')) return 'microsoft.insights/components';
  if (lower.includes('key vault') || lower.includes('keyvault') || lower.includes('kv-')) return 'microsoft.keyvault/vaults';
  if (lower.includes('storage') || /(^|[^a-z0-9])st[a-z0-9]{4,}($|[^a-z0-9])/.test(lower)) return 'microsoft.storage/storageaccounts';
  if (lower.includes('openai') || lower.includes('aoai') || lower.includes('cognitive')) return 'microsoft.cognitiveservices/accounts';
  if (lower.includes('resource group') || lower.includes('/resourcegroups/')) return 'resourcegroup';
  if (lower.includes('subscription') || lower.includes('/subscriptions/')) return 'subscription';

  return '';
}

function resolveIconPathByResourceType(resourceType = '') {
  const type = String(resourceType || '').toLowerCase();
  if (!type) return '';
  if (type === 'subscription') return LOCAL_AZURE_ICON_MAP.subscription;
  if (type === 'resourcegroup') return LOCAL_AZURE_ICON_MAP.resourceGroup;
  if (type === 'microsoft.web/sites:functionapp') return LOCAL_AZURE_ICON_MAP.functionApp;

  if (type.includes('microsoft.network/privateendpoints')) return LOCAL_AZURE_ICON_MAP.privateEndpoint;
  if (type.includes('microsoft.network/virtualnetworks/subnets')) return LOCAL_AZURE_ICON_MAP.subnet;
  if (type.includes('microsoft.network/virtualnetworks')) return LOCAL_AZURE_ICON_MAP.virtualNetwork;
  if (type.includes('microsoft.network/networksecuritygroups')) return LOCAL_AZURE_ICON_MAP.networkSecurityGroup;
  if (type.includes('microsoft.network/publicipaddresses')) return LOCAL_AZURE_ICON_MAP.publicIp;
  if (type.includes('microsoft.network/networkinterfaces')) return LOCAL_AZURE_ICON_MAP.networkInterface;
  if (type.includes('microsoft.network/routetables')) return LOCAL_AZURE_ICON_MAP.routeTable;

  if (type.includes('microsoft.managedidentity/userassignedidentities')) return LOCAL_AZURE_ICON_MAP.managedIdentity;
  if (type.includes('microsoft.logic/workflows')) return LOCAL_AZURE_ICON_MAP.logicApp;
  if (type.includes('microsoft.web/serverfarms')) return LOCAL_AZURE_ICON_MAP.appServicePlan;
  if (type.includes('microsoft.web/sites')) return LOCAL_AZURE_ICON_MAP.webApp;
  if (type.includes('microsoft.compute/virtualmachinescalesets')) return LOCAL_AZURE_ICON_MAP.vmScaleSet;
  if (type.includes('microsoft.compute/virtualmachines')) return LOCAL_AZURE_ICON_MAP.virtualMachine;
  if (type.includes('microsoft.keyvault/vaults')) return LOCAL_AZURE_ICON_MAP.keyVault;
  if (type.includes('microsoft.storage/storageaccounts')) return LOCAL_AZURE_ICON_MAP.storageAccount;
  if (type.includes('microsoft.insights/components')) return LOCAL_AZURE_ICON_MAP.applicationInsights;
  if (type.includes('microsoft.operationalinsights/workspaces')) return LOCAL_AZURE_ICON_MAP.logAnalytics;
  if (type.includes('microsoft.cognitiveservices/accounts')) return LOCAL_AZURE_ICON_MAP.cognitiveServices;

  return '';
}

function resolveIconPathForResourceName(name = '', relTypeLookup = new Map(), archTypeLookup = new Map()) {
  const key = normalizeResourceNameKey(name);
  const payloadType = (key && relTypeLookup.get(key)) || (key && archTypeLookup.get(key)) || '';
  const resolvedType = payloadType || inferResourceTypeFromName(name);
  return resolveIconPathByResourceType(resolvedType);
}

function getAzureIcon(label = '', resolveIconPath, size = 12) {
  const src = typeof resolveIconPath === 'function' ? resolveIconPath(label) : '';
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ display: 'block', objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isSubscriptionNode(label = '') {
  const l = normalizeKey(label);
  return l.startsWith('subscription') || l.includes('/subscriptions/');
}

function isResourceGroupNode(label = '') {
  const l = normalizeKey(label);
  return l.includes('resourcegroup') || l.includes('/resourcegroups/') || l.startsWith('rg-') || l.includes('_rg');
}

function stripSubscriptionFromDeletedLabel(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const withoutSubscriptionPath = raw
    .replace(/\/?subscriptions\/[^/\s)]+/ig, '')
    .replace(/\bsubscription\b\s*[:=-]?\s*[^,;|)]+/ig, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;|])/g, '$1')
    .replace(/([,;|])\s+/g, '$1 ')
    .trim();

  return withoutSubscriptionPath.replace(/^[-,:;|\s]+|[-,:;|\s]+$/g, '').trim();
}

function isCategoryAggregationNode(nodeId = '') {
  const normalized = normalizeKey(nodeId)
    .replace(/[']/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedSansCounts = normalized
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const compact = normalizedSansCounts.replace(/[^a-z0-9]/g, '');
  const raw = normalizeKey(nodeId).trim();

  if (!normalizedSansCounts) return false;
  if (isSubscriptionNode(nodeId) || isResourceGroupNode(nodeId)) return false;
  if (normalizedSansCounts.includes('::group::')) return true;

  const isAzureTypeBucket = /^microsoft\.[a-z0-9.-]+\/[a-z0-9./-]+$/i.test(raw)
    && !raw.includes('/providers/')
    && !raw.includes('/subscriptions/');
  if (isAzureTypeBucket) return true;

  const categoryTerms = new Set([
    'other resources',
    'app services',
    'key vaults',
    'storage accounts',
    'virtual machines',
    'virtual machine scale sets',
    'vms',
    'vm',
    'compute',
    'networking',
    'security',
    'monitoring',
    'integration',
    'ai services',
    'data services',
    'storage',
    'resources',
  ]);

  const categoryCompactTerms = new Set([
    'otherresources',
    'appservices',
    'keyvaults',
    'storageaccounts',
    'virtualmachines',
    'virtualmachinescalesets',
    'dataservices',
    'aiservices',
    'networking',
    'security',
    'monitoring',
    'integration',
    'compute',
    'storage',
    'resources',
    'vms',
    'vm',
  ]);

  if (categoryTerms.has(normalizedSansCounts) || categoryCompactTerms.has(compact)) return true;

  const alphaWordsOnly = /^[a-z\s]+$/.test(normalizedSansCounts);
  const genericBucketHints = /(resource|resources|service|services|vault|vaults|storage|account|accounts|machine|machines|compute|network|networking|security|monitoring|integration|other)/.test(normalizedSansCounts);

  if (alphaWordsOnly && genericBucketHints) return true;

  return false;
}

function collapseAggregationRelationships(relationships = []) {
  if (!Array.isArray(relationships) || !relationships.length) return [];

  let working = [...relationships];
  for (let pass = 0; pass < 8; pass += 1) {
    const allNodes = new Set();
    const incomingByNode = new Map();
    const outgoingByNode = new Map();

    working.forEach((edge) => {
      allNodes.add(edge.source);
      allNodes.add(edge.target);
      if (!incomingByNode.has(edge.target)) incomingByNode.set(edge.target, []);
      incomingByNode.get(edge.target).push(edge);
      if (!outgoingByNode.has(edge.source)) outgoingByNode.set(edge.source, []);
      outgoingByNode.get(edge.source).push(edge);
    });

    const groupNodeIds = new Set();
    working.forEach(({ source, target }) => {
      if (String(source || '').includes('::group::')) groupNodeIds.add(source);
      if (String(target || '').includes('::group::')) groupNodeIds.add(target);
    });

    allNodes.forEach((nodeId) => {
      if (groupNodeIds.has(nodeId)) return;
      if (!isCategoryAggregationNode(nodeId)) return;
      const incoming = incomingByNode.get(nodeId) || [];
      const outgoing = outgoingByNode.get(nodeId) || [];
      if (incoming.length && outgoing.length) groupNodeIds.add(nodeId);
    });

    if (!groupNodeIds.size) break;

    const bridged = [];
    groupNodeIds.forEach((groupId) => {
      const incoming = working.filter(({ target }) => target === groupId);
      const outgoing = working.filter(({ source }) => source === groupId);
      incoming.forEach((inEdge) => {
        outgoing.forEach((outEdge) => {
          bridged.push({
            source: inEdge.source,
            target: outEdge.target,
            relationship: outEdge.relationship || inEdge.relationship || 'contains',
          });
        });
      });
    });

    const filtered = working.filter(
      ({ source, target }) => !groupNodeIds.has(source) && !groupNodeIds.has(target)
    );

    const dedup = new Set();
    working = [...filtered, ...bridged].filter(({ source, target, relationship }) => {
      const edgeKey = `${source}|${target}|${relationship || 'contains'}`;
      if (dedup.has(edgeKey)) return false;
      dedup.add(edgeKey);
      return true;
    });
  }

  return working;
}

function buildGraph(archData, resolveIconPath, limit = 80) {
  if (!archData?.relationships) return { nodes: [], edges: [] };

  const rels = archData.relationships.slice(0, limit * 2);
  const nodeSet = new Set();
  const edges = [];

  rels.forEach(({ source, target, relationship }) => {
    nodeSet.add(source);
    nodeSet.add(target);
    edges.push({
      id: `${source}-${target}-${relationship}`,
      source,
      target,
      label: relationship,
      style: relationship === 'contains' ? EDGE_STYLE_CONTAINS : EDGE_STYLE_ANIMATED,
      labelStyle: EDGE_LABEL_STYLE,
      animated: relationship !== 'contains',
      type: 'smoothstep',
    });
  });

  const nodeArr = Array.from(nodeSet).slice(0, limit);
  const cols = 6;

  const nodes = nodeArr.map((id, i) => ({
    id,
    data: {
      label: (() => {
        const shortLabel = id.length > 20 ? `${id.slice(0, 20)}…` : id;
        const iconElement = getAzureIcon(id, resolveIconPath, 24);
        return (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            paddingLeft: 8,
            paddingRight: 20,
            position: 'relative',
          }}>
            {iconElement ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                flexShrink: 0,
                position: 'absolute',
                left: 8,
              }}>
                {iconElement}
              </div>
            ) : null}
            <span style={{ fontSize: 10, lineHeight: 1.2, textAlign: 'center', width: '100%', paddingLeft: iconElement ? 42 : 0 }}>{shortLabel}</span>
          </div>
        );
      })(),
      searchText: id,
    },
    position: { x: (i % cols) * 260, y: Math.floor(i / cols) * 110 },
    style: {
      background: getNodeColor(id),
      color: 'white',
      border: 'none',
      borderRadius: 50,
      padding: '0px',
      fontSize: 10,
      fontWeight: 500,
      minWidth: 180,
      width: 180,
      height: 40,
      display: 'flex',
      alignItems: 'center',
    },
  }));

  return { nodes, edges };
}

function extractSvgTextTokens(svgMarkup) {
  if (!svgMarkup) return [];

  const rawStrings = [];

  const pushString = (value) => {
    const text = String(value || '').trim();
    if (text) rawStrings.push(text);
  };

  try {
    const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    const parseError = doc.querySelector('parsererror');

    if (!parseError) {
      // 1. Standard <text> / <tspan> elements (textContent covers nested tspans)
      doc.querySelectorAll('text, tspan').forEach((node) => pushString(node.textContent));

      // 2. <title> and <desc> accessibility/metadata labels
      doc.querySelectorAll('title, desc').forEach((node) => pushString(node.textContent));

      // 3. <foreignObject> HTML content (draw.io, Lucidchart, Visio, Figma exports)
      doc.querySelectorAll('foreignObject').forEach((node) => pushString(node.textContent));

      // 4. Label-bearing attributes on any element
      const LABEL_ATTRS = ['aria-label', 'data-name', 'data-label', 'inkscape:label', 'title'];
      doc.querySelectorAll('*').forEach((node) => {
        LABEL_ATTRS.forEach((attr) => {
          const val = node.getAttribute && node.getAttribute(attr);
          if (val) pushString(val);
        });
      });
    }
  } catch {
    /* fall through to regex-based extraction below */
  }

  // 5. Regex fallback — catches cases where DOMParser fails on foreignObject namespaces
  //    or where the markup is malformed. Extract inner text of text/tspan/title/desc/div tags.
  try {
    const tagPattern = /<(?:text|tspan|title|desc|div|span|p)[^>]*>([\s\S]*?)<\/(?:text|tspan|title|desc|div|span|p)>/gi;
    let match;
    while ((match = tagPattern.exec(svgMarkup)) !== null) {
      // Strip any nested tags from the captured inner content
      const inner = match[1].replace(/<[^>]+>/g, ' ');
      pushString(inner);
    }
  } catch {
    /* ignore */
  }

  const STOP_WORDS = new Set([
    'text', 'not', 'svg', 'cannot', 'display', 'image', 'xml', 'html', 'div', 'span',
    'azure', 'microsoft', 'icon', 'icons', 'diagram', 'shape', 'node', 'label',
    'failure', 'error', 'success', 'warning', 'info', 'debug', 'exception', 'anomal',
    'anomalies', 'test', 'testing', 'sample', 'demo', 'example', 'data',
    'outlook', 'workspaces', 'workspace', 'logs', 'log', 'metric', 'metrics',
    'alert', 'alerts', 'notification', 'event', 'events', 'status', 'health',
    'dashboard', 'report', 'analysis', 'config', 'configuration', 'settings',
    'description', 'note', 'comment', 'doc', 'documentation', 'readme',
  ]);

  const cleaned = rawStrings
    .flatMap((text) => text.split(/[^a-zA-Z0-9_-]+/g))
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3 && token.length <= 64)
    .filter((token) => /[a-z]/.test(token))
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !/^mx[-_]/.test(token))
    .filter((token) => !/^ge[-_]/.test(token))
    .filter((token) => !/^o\d+[a-z0-9_-]*$/.test(token))
    .filter((token) => !/^[a-f0-9]{12,}$/.test(token))
    // Require structural markers (dash, underline, digit) or compound-like names
    // Single common words without structure are likely metadata, not resources
    .filter((token) => {
      const hasStructure = /[-_]/.test(token) || /\d/.test(token) || token.length > 16;
      const isSingleCommonWord = token.length <= 10 && !/[-_\d]/.test(token) && 
        /^(a|the|and|or|not|is|in|at|to|of|for|with|by|from|on|as|be|was|are|been|do|does|did|will|would|can|could|should|may|might|must|shall|get|set|has|have|had|make|take|use|give|see|know|think|come|go|let|put|say|tell|show|go|run|call|find|ask|add|keep|try|work|start|stop|end|begin|fail|pass|hold|move|follow|lead|read|write|close|open|turn|push|pull|rest|join|meet|change)$/i;
      return hasStructure || !isSingleCommonWord;
    });

  return Array.from(new Set(cleaned));
}

// Helper function to compute drift comparison via OpenAI
async function computeDriftComparisonPoints(scopeName, scopeType, currentTokens, applicationTokens) {
  if (!currentTokens.length || !applicationTokens.length) {
    return { hasDrift: false, points: ['• No drift detected - Scope is empty or no application architecture'] };
  }

  try {
    const result = await queryDriftComparison({
      scopeType,
      scopeName,
      currentTokens,
      applicationTokens,
    });

    if (!result) {
      return { hasDrift: false, points: ['• Unable to compute drift at this time'] };
    }

    const { currentOnly, applicationOnly, insights } = result;
    const points = [];

    if (currentOnly && currentOnly.length > 0) {
      points.push(`• Extra in Current: ${currentOnly.slice(0, 3).join(', ')}`);
    }
    if (applicationOnly && applicationOnly.length > 0) {
      points.push(`• Missing from Current: ${applicationOnly.slice(0, 3).join(', ')}`);
    }
    if (insights && insights.length > 0) {
      points.push(...insights.slice(0, 3).map(insight => `• ${insight}`));
    }

    const hasDrift = (currentOnly && currentOnly.length > 0) || (applicationOnly && applicationOnly.length > 0);
    return {
      hasDrift,
      points: points.length > 0 ? points : ['• No drift detected'],
    };
  } catch (error) {
    console.error('Error computing drift comparison:', error);
    return { hasDrift: false, points: ['• Error analyzing drift'] };
  }
}

export default function ArchitectureDiagram({
  archData,
  relData,
  apiCostAnalysis = null,
  discoveryStatus = 'idle',
  discoveryMessage = '',
  selectedSubscriptionIds = [],
  selectedSubscriptionSummary = [],
  onScopeChange = () => {},
  defaultTab = 'application',
  driftViewVariant = 'default',
  applicationArchitecture = null,
  onApplicationArchitectureChange = null,
}) {
  const [activeTab, setActiveTab] = useState(defaultTab);
  // Uploaded application architecture — controlled by parent when
  // onApplicationArchitectureChange is provided, so it syncs across pages.
  const [appArchLocal, setAppArchLocal] = useState(
    applicationArchitecture || { imageSrc: '', svgMarkup: '', isSvg: false, fileName: '' }
  );

  // Keep local mirror in sync when the shared (parent) value changes.
  useEffect(() => {
    if (applicationArchitecture) setAppArchLocal(applicationArchitecture);
  }, [applicationArchitecture]);

  const appArch = applicationArchitecture || appArchLocal;
  const recommendedImageSrc = appArch.imageSrc;
  const recommendedSvgMarkup = appArch.svgMarkup;
  const isSvgRecommended = appArch.isSvg;
  const uploadedFileName = appArch.fileName;

  const updateApplicationArchitecture = useCallback((next) => {
    setAppArchLocal(next);
    if (onApplicationArchitectureChange) onApplicationArchitectureChange(next);
  }, [onApplicationArchitectureChange]);

  const [uploadError, setUploadError] = useState('');
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const imageDragRef = useRef(null); // { startX, startY, originX, originY }
  const pinchRef = useRef(null);    // { startDist, startZoom }
  const previewWrapRef = useRef(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const reactFlowInstanceRef = useRef(null);
  const positionHistoryRef = useRef([]); // stack of node-position snapshots
  const [isScopeModalOpen, setIsScopeModalOpen] = useState(false);
  const [scopeModalStep, setScopeModalStep] = useState('choice'); // 'choice' | 'subscription' | 'resource-group'
  const [selectedScopeSubscription, setSelectedScopeSubscription] = useState('');
  const scopeModalRef = useRef(null);
  const [isArchitectureLoading, setIsArchitectureLoading] = useState(false);

  const relResourceTypeLookup = useMemo(() => buildResourceTypeLookupFromRelData(relData), [relData]);
  const archResourceTypeLookup = useMemo(() => buildResourceTypeLookupFromArchData(archData), [archData]);
  const resolveIconPath = useCallback(
    (name) => resolveIconPathForResourceName(name, relResourceTypeLookup, archResourceTypeLookup),
    [relResourceTypeLookup, archResourceTypeLookup]
  );

  const baseGraph = useMemo(() => buildGraph(archData, resolveIconPath), [archData, resolveIconPath]);

  // useNodesState / useEdgesState keep drag positions in React Flow's internal state
  const [nodes, setNodes, onNodesChange] = useNodesState(baseGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(baseGraph.edges);
  const [canUndo, setCanUndo] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [viewport, setViewport] = useState({
    width: typeof window !== 'undefined' ? window.innerWidth : 1440,
    height: typeof window !== 'undefined' ? window.innerHeight : 900,
  });
  const [pendingScope, setPendingScope] = useState(null); // Track scope to compute drift for
  const hasApplicationArchitecture = Boolean(recommendedImageSrc || recommendedSvgMarkup);
  const showLifecycleDriftSummary = driftViewVariant === 'lifecycle';

  const currentResourceTokens = useMemo(() => {
    const set = new Set();
    nodes.forEach((node) => {
      const text = String(node.data?.searchText || node.id || '').toLowerCase();
      text.split(/[^a-zA-Z0-9_-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .forEach((token) => set.add(token));
    });
    return set;
  }, [nodes]);

  const [applicationTokenState, setApplicationTokenState] = useState({
    status: 'idle',
    tokens: [],
    source: '',
  });

  useEffect(() => {
    let cancelled = false;

    if (!hasApplicationArchitecture) {
      setApplicationTokenState({ status: 'idle', tokens: [], source: '' });
      return () => { cancelled = true; };
    }

    const scopeName = selectedSubscriptionSummary?.[0]?.name || '';
    const cacheKey = buildApplicationTokenCacheKey({
      isSvg: isSvgRecommended,
      svgMarkup: recommendedSvgMarkup,
      imageDataUrl: recommendedImageSrc,
      scopeName,
    });

    const cached = APPLICATION_TOKEN_CACHE.get(cacheKey);
    if (cached && Array.isArray(cached.tokens)) {
      setApplicationTokenState({
        status: cached.tokens.length ? 'ready' : 'empty',
        tokens: cached.tokens,
        source: cached.source || (isSvgRecommended ? 'svg-cache' : 'image-ai-cache'),
      });
      return () => { cancelled = true; };
    }

    if (isSvgRecommended) {
      const tokens = extractSvgTextTokens(recommendedSvgMarkup);
      APPLICATION_TOKEN_CACHE.set(cacheKey, {
        tokens,
        source: 'svg',
      });
      setApplicationTokenState({
        status: tokens.length ? 'ready' : 'empty',
        tokens,
        source: 'svg',
      });
      return () => { cancelled = true; };
    }

    if (!recommendedImageSrc) {
      setApplicationTokenState({ status: 'empty', tokens: [], source: 'image' });
      return () => { cancelled = true; };
    }

    setApplicationTokenState({ status: 'loading', tokens: [], source: 'image' });

    queryResourceTokensFromImage({
      imageDataUrl: recommendedImageSrc,
      scopeName,
    })
      .then((tokens) => {
        if (cancelled) return;
        const normalized = Array.isArray(tokens)
          ? tokens
            .map((token) => String(token || '').trim().toLowerCase())
            .filter((token) => token.length >= 3)
          : [];
        APPLICATION_TOKEN_CACHE.set(cacheKey, {
          tokens: Array.from(new Set(normalized)),
          source: 'image-ai',
        });
        setApplicationTokenState({
          status: normalized.length ? 'ready' : 'empty',
          tokens: Array.from(new Set(normalized)),
          source: 'image-ai',
        });
      })
      .catch(() => {
        if (!cancelled) {
          setApplicationTokenState({ status: 'error', tokens: [], source: 'image-ai' });
        }
      });

    return () => { cancelled = true; };
  }, [hasApplicationArchitecture, isSvgRecommended, recommendedSvgMarkup, recommendedImageSrc, selectedSubscriptionSummary]);

  const applicationResourceTokens = applicationTokenState.tokens;

  const driftSummary = useMemo(() => {
    if (!archData) {
      return { state: 'no-current' };
    }
    if (!hasApplicationArchitecture) {
      return { state: 'no-application' };
    }
    if (applicationTokenState.status === 'loading') {
      return { state: 'extracting-application' };
    }
    if (!applicationResourceTokens.length) {
      return { state: isSvgRecommended ? 'no-svg-labels' : 'no-image-labels' };
    }

    const appSet = new Set(applicationResourceTokens);
    const onlyInCurrent = Array.from(currentResourceTokens).filter((token) => !appSet.has(token));
    const onlyInApplication = Array.from(appSet).filter((token) => !currentResourceTokens.has(token));
    const commonCount = Array.from(appSet).filter((token) => currentResourceTokens.has(token)).length;

    return {
      state: 'compared',
      onlyInCurrent,
      onlyInApplication,
      commonCount,
      appCount: appSet.size,
      currentCount: currentResourceTokens.size,
    };
  }, [archData, hasApplicationArchitecture, isSvgRecommended, applicationResourceTokens, currentResourceTokens, applicationTokenState.status]);

  const createdExactCostRows = useMemo(() => (
    driftSummary.state === 'compared'
      ? buildExactResourceCostRows(driftSummary.onlyInCurrent || [], apiCostAnalysis)
      : []
  ), [driftSummary.state, driftSummary.onlyInCurrent, apiCostAnalysis]);

  const deletedExactCostRows = useMemo(() => (
    driftSummary.state === 'compared'
      ? buildExactResourceCostRows(driftSummary.onlyInApplication || [], apiCostAnalysis)
      : []
  ), [driftSummary.state, driftSummary.onlyInApplication, apiCostAnalysis]);

  const deletedResourceDisplayRows = useMemo(() => {
    if (driftSummary.state !== 'compared') return [];

    return (driftSummary.onlyInApplication || [])
      .map((item) => {
        const label = stripSubscriptionFromDeletedLabel(item);
        return {
          key: String(item || ''),
          label,
        };
      })
      .filter((item) => item.label && !isSubscriptionNode(item.label));
  }, [driftSummary.state, driftSummary.onlyInApplication]);

  const minimapStyle = useMemo(() => {
    const isSmallScreen = viewport.width < 1366 || viewport.height < 820;
    if (isSmallScreen) {
      return { width: 130, height: 95 };
    }
    return { width: 200, height: 150 };
  }, [viewport]);

  useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Close scope modal when clicking outside
  useEffect(() => {
    if (!isScopeModalOpen) return;
    const handleClickOutside = (e) => {
      if (scopeModalRef.current && !scopeModalRef.current.contains(e.target)) {
        setIsScopeModalOpen(false);
        setTimeout(() => setScopeModalStep('choice'), 100);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isScopeModalOpen]);

  // Attach non-passive wheel listener — zoom centered on mouse cursor position
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Mouse position relative to container center
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setImageZoom((z) => {
        const newZ = +Math.min(Math.max(z * factor, 0.2), 10).toFixed(3);
        // Adjust offset so the point under cursor stays fixed
        setImageOffset((off) => ({
          x: mx - (mx - off.x) * (newZ / z),
          y: my - (my - off.y) * (newZ / z),
        }));
        return newZ;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [activeTab, recommendedImageSrc, recommendedSvgMarkup]);

  // Re-sync when archData changes (fresh Discover run)
  useEffect(() => {
    setNodes(baseGraph.nodes);
    setEdges(baseGraph.edges);
    positionHistoryRef.current = [];
    setCanUndo(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archData]);

  useEffect(() => {
    if (!pendingScope) return;

    const scopeName = resolveSelectedScopeName(pendingScope);

    if (!scopeName) {
      setPendingScope(null);
      return;
    }

    let cancelled = false;
    setIsArchitectureLoading(true);
    setUploadError('');

    fetchArchitectureFromFunctionByName(scopeName)
      .then((asset) => {
        if (cancelled) return;
        updateApplicationArchitecture(asset);
        setImageZoom(1);
        setImageOffset({ x: 0, y: 0 });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to auto-load application architecture:', error);
        const reason = error?.message ? ` Reason: ${error.message}` : '';
        setUploadError(`Unable to load application architecture for "${scopeName}".${reason}`);
      })
      .finally(() => {
        if (cancelled) return;
        setIsArchitectureLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pendingScope, updateApplicationArchitecture]);

  // Compute drift comparison when scope is selected and both architectures available
  useEffect(() => {
    if (!pendingScope) return;
    if (!hasApplicationArchitecture) return;
    if (!currentResourceTokens.size || !applicationResourceTokens.length) return;

    const scopeName = resolveSelectedScopeName(pendingScope);
    if (!scopeName) return;

    const computeAndUpdateDrift = async () => {
      const { hasDrift, points } = await computeDriftComparisonPoints(
        scopeName,
        pendingScope.scopeType,
        Array.from(currentResourceTokens),
        Array.from(applicationResourceTokens)
      );

      // Call onScopeChange again with drift results merged in
      onScopeChange({
        ...pendingScope,
        drift: {
          state: 'compared',
          hasDrift,
          points,
        },
      });

      setPendingScope(null);
    };

    computeAndUpdateDrift();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScope, hasApplicationArchitecture, currentResourceTokens.size, applicationResourceTokens.length, onScopeChange]);

  // Called when the user finishes dragging a node — save a snapshot of positions BEFORE the move
  const handleNodeDragStart = (_event, _node, currentNodes) => {
    const snapshot = currentNodes.map(({ id, position }) => ({ id, position: { ...position } }));
    positionHistoryRef.current.push(snapshot);
    if (positionHistoryRef.current.length > 50) positionHistoryRef.current.shift(); // cap history
    setCanUndo(true);
  };

  const handleUndo = () => {
    const history = positionHistoryRef.current;
    if (!history.length) return;
    const snapshot = history.pop();
    setCanUndo(history.length > 0);
    setNodes((prev) =>
      prev.map((node) => {
        const saved = snapshot.find((s) => s.id === node.id);
        return saved ? { ...node, position: saved.position } : node;
      })
    );
  };

  // Apply search filter on top of the live (dragged) positions
  const filteredGraph = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return { nodes, edges };

    const matchedNodeIds = new Set(
      nodes
        .filter((node) => {
          const label = String(node.data?.searchText || '').toLowerCase();
          const id = String(node.id || '').toLowerCase();
          return label.includes(term) || id.includes(term);
        })
        .map((node) => node.id)
    );

    if (matchedNodeIds.size === 0) return { nodes: [], edges: [] };

    const filteredEdges = edges.filter(
      (edge) => matchedNodeIds.has(edge.source) || matchedNodeIds.has(edge.target)
    );

    filteredEdges.forEach((edge) => {
      matchedNodeIds.add(edge.source);
      matchedNodeIds.add(edge.target);
    });

    const filteredNodes = nodes
      .filter((node) => matchedNodeIds.has(node.id))
      .map((node) => {
        const isDirectMatch =
          String(node.data?.searchText || '').toLowerCase().includes(term) ||
          String(node.id || '').toLowerCase().includes(term);
        return {
          ...node,
          style: {
            ...node.style,
            boxShadow: isDirectMatch ? '0 0 0 3px #facc15' : 'none',
            border: isDirectMatch ? '2px solid #f59e0b' : 'none',
          },
        };
      });

    return { nodes: filteredNodes, edges: filteredEdges };
  }, [nodes, edges, searchTerm]);

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleSearchToggle = () => {
    setIsSearchOpen((prev) => {
      const next = !prev;
      if (!next) {
        setSearchTerm('');
      }
      setTimeout(() => {
        if (next) searchInputRef.current?.focus();
      }, 0);
      return next;
    });
  };

  const handleFitView = () => {
    if (activeTab === 'current') {
      reactFlowInstanceRef.current?.fitView?.({ padding: 0.2, duration: 300 });
      return;
    }
    if (hasApplicationArchitecture) {
      setImageZoom(1);
      setImageOffset({ x: 0, y: 0 });
    }
  };

  // ── Mouse pan ────────────────────────────────────────────────────────────
  const handleImgMouseDown = (e) => {
    e.preventDefault();
    setIsDraggingImage(true);
    imageDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: imageOffset.x,
      originY: imageOffset.y,
    };
    const onMove = (mv) => {
      const d = imageDragRef.current;
      if (!d) return;
      setImageOffset({ x: d.originX + mv.clientX - d.startX, y: d.originY + mv.clientY - d.startY });
    };
    const onUp = () => {
      imageDragRef.current = null;
      setIsDraggingImage(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Scroll-wheel zoom (handled via non-passive useEffect above) ───────────────
  const handleImgWheel = () => {}; // placeholder — real handler attached in useEffect

  // ── Pinch-to-zoom (touch) ─────────────────────────────────────────────────
  const getTouchDist = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleImgTouchStart = (e) => {
    if (e.touches.length === 2) {
      pinchRef.current = { startDist: getTouchDist(e.touches), startZoom: imageZoom };
    } else if (e.touches.length === 1) {
      imageDragRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        originX: imageOffset.x,
        originY: imageOffset.y,
      };
    }
  };

  const handleImgTouchMove = (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && pinchRef.current) {
      const dist = getTouchDist(e.touches);
      const newZoom = +Math.min(
        Math.max((pinchRef.current.startZoom * dist) / pinchRef.current.startDist, 0.2),
        10
      ).toFixed(2);
      setImageZoom(newZoom);
    } else if (e.touches.length === 1 && imageDragRef.current) {
      const d = imageDragRef.current;
      setImageOffset({
        x: d.originX + e.touches[0].clientX - d.startX,
        y: d.originY + e.touches[0].clientY - d.startY,
      });
    }
  };

  const handleImgTouchEnd = () => {
    imageDragRef.current = null;
    pinchRef.current = null;
  };

  const handleRecommendedUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isSvgFile = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
    const isJpgFile = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name || '');
    const isPngFile = file.type === 'image/png' || /\.png$/i.test(file.name || '');

    if (!(isSvgFile || isJpgFile || isPngFile)) {
      updateApplicationArchitecture({ imageSrc: '', svgMarkup: '', isSvg: false, fileName: '' });
      setUploadError('Please upload a JPG, PNG, or SVG file.');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = ({ target }) => {
      const result = target?.result || '';

      if (isSvgFile) {
        const svgText = String(result);
        if (!/<svg[\s\S]*?>/i.test(svgText)) {
          updateApplicationArchitecture({ imageSrc: '', svgMarkup: '', isSvg: false, fileName: '' });
          setUploadError('Invalid SVG content. Please upload a valid SVG file.');
          return;
        }

        updateApplicationArchitecture({ imageSrc: '', svgMarkup: svgText, isSvg: true, fileName: file.name });
      } else {
        updateApplicationArchitecture({ imageSrc: result, svgMarkup: '', isSvg: false, fileName: file.name });
      }

      setUploadError('');
      setImageZoom(1);
      setImageOffset({ x: 0, y: 0 });
      setActiveTab((prev) => (prev === 'drift' ? 'drift' : 'application'));
    };

    if (isSvgFile) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  };

  const renderFlow = (graph) => (
    <>
      <div className="arch-body">
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={handleNodeDragStart}
          onInit={(instance) => {
            reactFlowInstanceRef.current = instance;
          }}
          fitView
          fitViewOptions={FLOW_FIT_VIEW_OPTIONS}
          minZoom={0.2}
          proOptions={FLOW_PRO_OPTIONS}
        >
          <Background color="#f1f5f9" gap={16} />
          <Controls showInteractive={false} />
          <MiniMap style={minimapStyle} nodeColor={getMiniMapNodeColor} nodeStrokeWidth={0} zoomable pannable />
        </ReactFlow>
      </div>

      <div className="legend-row">
        <div className="legend-entry"><div className="legend-line" /> User Traffic</div>
        <div className="legend-entry"><div className="legend-dashed" /> Private Link</div>
        <div className="legend-entry"><div className="legend-box" /> Subnet</div>
        <div className="legend-entry"><div className="legend-risk" /> Risk Detected</div>
      </div>
    </>
  );

  const renderApplicationArchitecture = () => {
    if (isArchitectureLoading) {
      return (
        <div className="arch-upload-state">
          <div className="upload-hint">Loading application architecture from scope selection...</div>
        </div>
      );
    }

    if (recommendedImageSrc || recommendedSvgMarkup) {
      return (
        <>
          <div
            ref={previewWrapRef}
            className="arch-image-preview-wrap"
            onMouseDown={handleImgMouseDown}
            onWheel={handleImgWheel}
            onTouchStart={handleImgTouchStart}
            onTouchMove={handleImgTouchMove}
            onTouchEnd={handleImgTouchEnd}
            style={{ cursor: isDraggingImage ? 'grabbing' : 'grab' }}
          >
            <div
              className="arch-preview-stage"
              style={{
                transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageZoom})`,
                transformOrigin: 'center center',
              }}
            >
              {isSvgRecommended ? (
                <div
                  className="arch-svg-preview"
                  dangerouslySetInnerHTML={{ __html: recommendedSvgMarkup }}
                />
              ) : (
                <img
                  src={recommendedImageSrc}
                  alt="Application architecture"
                  className="arch-image-preview"
                  draggable={false}
                />
              )}
            </div>
            <div
              className="arch-image-zoom-controls"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              <button
                className="img-zoom-btn"
                title="Zoom in"
                onClick={() => setImageZoom((z) => Math.min(+(z + 0.2).toFixed(1), 10))}
              >+</button>
              <span className="img-zoom-level">{Math.round(imageZoom * 100)}%</span>
              <button
                className="img-zoom-btn"
                title="Zoom out"
                onClick={() => setImageZoom((z) => Math.max(+(z - 0.2).toFixed(1), 0.2))}
              >−</button>
              <button
                className="img-zoom-btn img-zoom-reset"
                title="Reset zoom &amp; position"
                onClick={() => { setImageZoom(1); setImageOffset({ x: 0, y: 0 }); }}
              >⊙</button>
            </div>
          </div>
          <div className="upload-meta" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>Loaded application architecture: {uploadedFileName}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.svg,image/jpeg,image/png,image/svg+xml"
              onChange={handleRecommendedUpload}
              className="file-input-hidden"
            />
            <button
              type="button"
              onClick={openFilePicker}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 600,
                background: '#334155',
                color: '#e2e8f0',
                border: '1px solid #475569',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Change image
            </button>
          </div>
        </>
      );
    }

    return (
      <div className="arch-upload-state">
        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.svg,image/jpeg,image/png,image/svg+xml"
          onChange={handleRecommendedUpload}
          className="file-input-hidden"
        />
        <div className="upload-area" onClick={openFilePicker}>
          <strong>Select scope to auto-load application architecture</strong>
          <div className="upload-subtext">The selected subscription/resource group name is sent to Function App and image is loaded automatically.</div>
        </div>
        {uploadError && <div className="upload-error">{uploadError}</div>}
        {!uploadError && <div className="upload-hint">Manual upload is optional fallback (JPG/PNG/SVG).</div>}
      </div>
    );
  };

  const renderDriftArchitecture = () => {
    if (!archData) {
      return (
        <div className="arch-upload-state">
          <div className="upload-hint">Run Discover first to load Current Architecture for drift comparison.</div>
        </div>
      );
    }

    if (isArchitectureLoading) {
      return (
        <div className="arch-upload-state">
          <div className="upload-hint">Loading application architecture from Function App for selected scope...</div>
        </div>
      );
    }

    if (!hasApplicationArchitecture) {
      return (
        <div className="arch-upload-state">
          <input
            ref={fileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.svg,image/jpeg,image/png,image/svg+xml"
            onChange={handleRecommendedUpload}
            className="file-input-hidden"
          />
          <div className="upload-area" onClick={openFilePicker}>
            <strong>Application architecture not found for selected scope</strong>
            <div className="upload-subtext">Select another scope or upload JPG/PNG/SVG manually as fallback.</div>
          </div>
          {uploadError && <div className="upload-error">{uploadError}</div>}
        </div>
      );
    }

    return (
      <div className="drift-wrap">
        <div className="drift-summary">
          {driftSummary.state === 'extracting-application' && (
            <div className="drift-note drift-warn">
              Extracting architecture labels from the uploaded image. This can take a few seconds.
            </div>
          )}
          {driftSummary.state === 'no-svg-labels' && (
            <div className="drift-note drift-warn">
              SVG uploaded, but no readable text labels were found for semantic drift matching.
              This usually happens when the diagram's text was converted to outlines/paths, or exported as a flattened image inside the SVG.
              Tip: re-export the SVG with live text enabled (avoid "flatten"/"outline text"), or upload an SVG that keeps resource names as selectable text.
            </div>
          )}
          {driftSummary.state === 'no-image-labels' && (
            <div className="drift-note drift-warn">
              Unable to extract enough resource labels from this JPG/PNG for drift matching.
              Try a higher-resolution diagram or upload SVG with selectable text.
            </div>
          )}
          {driftSummary.state === 'compared' && (
            <>
              <div className="drift-note drift-info">
                {showLifecycleDriftSummary
                  ? `Matched resources: ${driftSummary.commonCount} | Created: ${driftSummary.onlyInCurrent.length} | Deleted: ${driftSummary.onlyInApplication.length}`
                  : `Matched resources: ${driftSummary.commonCount} | Current-only: ${driftSummary.onlyInCurrent.length}`}
              </div>
              <div className="drift-list-grid">
                <div className="drift-list-card drift-cost-card">
                  <div className="drift-list-title drift-cost-title">
                    {showLifecycleDriftSummary ? 'Newly Created Resources' : 'Current-only differences'}
                  </div>
                  {showLifecycleDriftSummary ? (
                    (() => {
                      if (!driftSummary.onlyInCurrent.length) {
                        return (
                          <div className="drift-cost-empty">
                            No newly created resources detected.
                          </div>
                        );
                      }

                      const segments = createdExactCostRows
                        .map((item) => {
                          const exactCost = item.cost === null ? null : Number(item.cost || 0);
                          const resolvedCost = exactCost;
                          return {
                            label: item.label,
                            color: item.color,
                            cost: Number.isFinite(resolvedCost) ? resolvedCost : 0,
                            service: item.matchedName || '',
                            isEstimated: false,
                          };
                        })
                        .filter((s) => s.cost > 0)
                        .sort((a, b) => b.cost - a.cost);

                      const total = Math.round(segments.reduce((sum, seg) => sum + seg.cost, 0) * 100) / 100;
                      const hasValidCosts = segments.length > 0;

                      return (
                        <div className="drift-cost-body">
                          {hasValidCosts ? (
                            <>
                              <CostDonutChart segments={segments} total={total} />
                              <div className="drift-cost-details">
                                <div className="drift-cost-row">
                                  <span className="drift-cost-label">Monthly</span>
                                  <strong className="drift-cost-value">${total}/mo</strong>
                                </div>
                                <div className="drift-cost-list">
                                  {createdExactCostRows.map((seg) => (
                                    <div key={seg.label} className="drift-cost-item">
                                      <span className="drift-cost-dot" style={{ background: seg.color }} />
                                      <span className="drift-cost-name" title={seg.matchedName ? `${seg.label} — matched: ${seg.matchedName}` : `${seg.label} — no exact cost row`}>
                                        {seg.label} - {seg.cost === null ? 'No exact value in payload' : `$${Number(seg.cost || 0).toFixed(2)}`}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </>
                          ) : (
                            <>
                              <ul className="drift-diff-list">
                                {driftSummary.onlyInCurrent.map((item) => <li key={`c-${item}`}>{item}</li>)}
                              </ul>
                              <div className="drift-cost-empty drift-cost-loading">Showing only exact cost values from payload dimensions.</div>
                            </>
                          )}
                        </div>
                      );
                    })()
                  ) : (
                    driftSummary.onlyInCurrent.length ? (
                      <ul className="drift-diff-list">
                        {driftSummary.onlyInCurrent.map((item) => <li key={`c-${item}`}>{item}</li>)}
                      </ul>
                    ) : (
                      <div className="drift-cost-empty">
                        No newly created resources detected.
                      </div>
                    )
                  )}
                </div>
                <div className="drift-list-card drift-cost-card">
                  {showLifecycleDriftSummary ? (
                    (() => {
                      if (!deletedResourceDisplayRows.length) {
                        return (
                          <>
                            <div className="drift-list-title drift-cost-title">Deleted Resources</div>
                            <div className="drift-cost-empty">
                              No deleted resources detected.
                            </div>
                          </>
                        );
                      }

                      return (
                        <>
                          <div className="drift-list-title drift-cost-title">Deleted Resources</div>
                          <div className="drift-cost-body">
                            <ul className="drift-diff-list">
                              {deletedResourceDisplayRows.map((item) => <li key={`a-${item.key}`}>{item.label}</li>)}
                            </ul>
                          </div>
                        </>
                      );
                    })()
                  ) : (
                    <>
                      <div className="drift-list-title drift-cost-title">Current-only cost</div>
                      {(() => {
                        if (!driftSummary.onlyInCurrent.length) {
                          return (
                            <div className="drift-cost-empty">
                              No current-only resources detected.
                            </div>
                          );
                        }

                        const segments = createdExactCostRows
                          .map((item) => {
                            const exactCost = item.cost === null ? null : Number(item.cost || 0);
                            return {
                              label: item.label,
                              color: item.color,
                              cost: Number.isFinite(exactCost) ? exactCost : 0,
                              service: item.matchedName || '',
                            };
                          })
                          .filter((s) => s.cost > 0)
                          .sort((a, b) => b.cost - a.cost);

                        const total = Math.round(segments.reduce((sum, seg) => sum + seg.cost, 0) * 100) / 100;
                        const hasValidCosts = segments.length > 0;

                        return (
                          <div className="drift-cost-body">
                            {hasValidCosts ? (
                              <>
                                <CostDonutChart segments={segments} total={total} />
                                <div className="drift-cost-details">
                                  <div className="drift-cost-row">
                                    <span className="drift-cost-label">Monthly</span>
                                    <strong className="drift-cost-value">${total}/mo</strong>
                                  </div>
                                  <div className="drift-cost-list">
                                    {createdExactCostRows.map((seg) => (
                                      <div key={seg.label} className="drift-cost-item">
                                        <span className="drift-cost-dot" style={{ background: seg.color }} />
                                        <span className="drift-cost-name" title={seg.matchedName ? `${seg.label} — matched: ${seg.matchedName}` : `${seg.label} — no exact cost row`}>
                                          {seg.label} - {seg.cost === null ? 'No exact value in payload' : `$${Number(seg.cost || 0).toFixed(2)}`}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </>
                            ) : (
                              <div className="drift-cost-empty">
                                No exact current-only cost values are available in the payload.
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="drift-view-grid">
          <div className="drift-view-card drift-current-card">
            <div className="drift-view-title">Current Architecture</div>
            <div className="drift-current-flow">
              <ReactFlow
                nodes={filteredGraph.nodes}
                edges={filteredGraph.edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStart={handleNodeDragStart}
                onInit={(instance) => {
                  reactFlowInstanceRef.current = instance;
                }}
                fitView
                fitViewOptions={FLOW_FIT_VIEW_OPTIONS}
                minZoom={0.2}
                proOptions={FLOW_PRO_OPTIONS}
              >
                <Background color="#f1f5f9" gap={16} />
                <Controls showInteractive={false} />
                <MiniMap style={minimapStyle} nodeColor={getMiniMapNodeColor} nodeStrokeWidth={0} zoomable pannable />
              </ReactFlow>
            </div>
          </div>

          <div className="drift-view-card drift-app-card">
            <div className="drift-view-title">Application Architecture</div>
            <div className="drift-app-preview-wrap">
              {isSvgRecommended ? (
                <div className="arch-svg-preview" dangerouslySetInnerHTML={{ __html: recommendedSvgMarkup }} />
              ) : (
                <img src={recommendedImageSrc} alt="Application architecture" className="arch-image-preview" draggable={false} />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (discoveryStatus === 'loading') {
    return (
      <div className="arch-panel">
        <div className="panel-header">
          <h3>Architecture Diagram</h3>
        </div>
        <div className="loading-overlay">
          <div className="loading-stack">
            <span className="spinner spinner-lg spinner-ring" />
            <div className="loading-title">
              {discoveryMessage || 'Triggering Logic App...'}
            </div>
            <div className="loading-subtitle">
              Please wait — Logic App is scanning your Azure subscription
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (discoveryStatus === 'error') {
    return (
      <div className="arch-panel">
        <div className="panel-header">
          <h3>Architecture Diagram</h3>
        </div>
        <div className="loading-overlay">
          <div style={{ color: '#dc2626', fontSize: 13, textAlign: 'center', maxWidth: 520 }}>
            {discoveryMessage || 'Discovery failed. Please try again.'}
          </div>
        </div>
      </div>
    );
  }

  if (!archData) {
    return (
      <div className="arch-panel">
        <div className="panel-header">
          <h3>Architecture Diagram</h3>
        </div>
        <div className="arch-body" />
      </div>
    );
  }

  return (
    <div className="arch-panel">
      <div className="panel-header">
        <h3>Architecture Diagram</h3>
        <div className="tab-group">
          <button className={`tab-btn ${activeTab === 'application' ? 'active' : ''}`} onClick={() => setActiveTab('application')}>
            Application Architecture
          </button>
          <button className={`tab-btn ${activeTab === 'current' ? 'active' : ''}`} onClick={() => setActiveTab('current')}>
            Current Architecture
          </button>
          <button className={`tab-btn ${activeTab === 'drift' ? 'active' : ''}`} onClick={() => setActiveTab('drift')}>
            Drift Architecture
          </button>
        </div>
        <div className="panel-actions">
          {activeTab === 'current' && isSearchOpen && (
            <input
              ref={searchInputRef}
              type="text"
              className="arch-search-input"
              placeholder="Search diagram"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          )}
          <button
            title="Architecture Scope"
            onClick={() => {
              setIsScopeModalOpen(true);
              setScopeModalStep('choice');
              setSelectedScopeSubscription('');
            }}
            style={{ position: 'relative' }}
          >
            ⚙ Scope
          </button>
          <button
            title="Undo last move"
            onClick={handleUndo}
            disabled={activeTab !== 'current' || !canUndo}
            style={{ fontSize: 13 }}
          >
            ↩
          </button>
          <button
            title="Search"
            onClick={handleSearchToggle}
            disabled={activeTab !== 'current'}
          >
            🔍
          </button>
          <button
            title="Fit view"
            onClick={handleFitView}
            disabled={activeTab !== 'current' && !hasApplicationArchitecture}
          >
            ⛶
          </button>
          <button title="Download">⬇</button>
        </div>
      </div>

      {activeTab === 'current' ? (
        filteredGraph.nodes.length > 0 || !searchTerm.trim() ? (
          renderFlow(filteredGraph)
        ) : (
          <div className="arch-upload-state">
            <div className="upload-hint">No matching resources found for "{searchTerm}".</div>
          </div>
        )
      ) : activeTab === 'application' ? (
        renderApplicationArchitecture()
      ) : (
        renderDriftArchitecture()
      )}

      {/* Scope Selection Modal */}
      {isScopeModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
          }}
        >
          <div
            ref={scopeModalRef}
            style={{
              background: '#1e293b',
              border: '1px solid #475569',
              borderRadius: 12,
              padding: '32px',
              maxWidth: 500,
              width: 'calc(100% - 32px)',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.8)',
              maxHeight: '80vh',
              overflowY: 'auto',
            }}
          >
            {scopeModalStep === 'choice' && (
              <div>
                <h3 style={{ margin: '0 0 24px 0', color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>
                  Select Scope Type
                </h3>
                <button
                  onClick={() => {
                    if (selectedSubscriptionSummary.length === 1) {
                      // If only one subscription, auto-select it
                      const scopeData = {
                        scopeType: 'subscription',
                        scopeName: selectedSubscriptionSummary[0].name,
                        selectedSubscriptionId: selectedSubscriptionSummary[0].id,
                        selectedResourceGroup: '',
                        scopedArchData: null,
                      };
                      setPendingScope(scopeData);
                      onScopeChange(scopeData);
                      setIsScopeModalOpen(false);
                      setScopeModalStep('choice');
                    } else {
                      setScopeModalStep('subscription');
                    }
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '16px',
                    marginBottom: 12,
                    background: '#334155',
                    color: '#e2e8f0',
                    border: '1px solid #475569',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 600,
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.background = '#475569';
                    e.target.style.borderColor = '#64748b';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = '#334155';
                    e.target.style.borderColor = '#475569';
                  }}
                >
                  📋 Subscription Scope
                </button>
                <button
                  onClick={() => {
                    setScopeModalStep('resource-group');
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '16px',
                    background: '#334155',
                    color: '#e2e8f0',
                    border: '1px solid #475569',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 600,
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.target.style.background = '#475569';
                    e.target.style.borderColor = '#64748b';
                  }}
                  onMouseLeave={(e) => {
                    e.target.style.background = '#334155';
                    e.target.style.borderColor = '#475569';
                  }}
                >
                  📁 Resource Group Scope
                </button>
                <button
                  onClick={() => setIsScopeModalOpen(false)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '10px',
                    marginTop: 16,
                    background: 'transparent',
                    color: '#94a3b8',
                    border: '1px solid #475569',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              </div>
            )}

            {scopeModalStep === 'subscription' && (
              <div>
                <h3 style={{ margin: '0 0 24px 0', color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>
                  Select Subscription
                </h3>
                <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 16 }}>
                  {selectedSubscriptionSummary.map((sub) => (
                    <button
                      key={sub.id}
                      onClick={() => {
                        const scopeData = {
                          scopeType: 'subscription',
                          scopeName: sub.name,
                          selectedSubscriptionId: sub.id,
                          selectedResourceGroup: '',
                          scopedArchData: null,
                        };
                        setPendingScope(scopeData);
                        onScopeChange(scopeData);
                        setIsScopeModalOpen(false);
                        setScopeModalStep('choice');
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '12px',
                        marginBottom: 8,
                        background: '#334155',
                        color: '#e2e8f0',
                        border: '1px solid #475569',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 13,
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.background = '#475569';
                        e.target.style.borderColor = '#64748b';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.background = '#334155';
                        e.target.style.borderColor = '#475569';
                      }}
                    >
                      {sub.name}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setScopeModalStep('choice')}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '10px',
                    background: 'transparent',
                    color: '#94a3b8',
                    border: '1px solid #475569',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  ← Back
                </button>
              </div>
            )}

            {scopeModalStep === 'resource-group' && (
              <div>
                <h3 style={{ margin: '0 0 24px 0', color: '#e2e8f0', fontSize: 18, fontWeight: 700 }}>
                  {selectedScopeSubscription ? 'Select Resource Group' : 'Select Subscription'}
                </h3>
                
                {!selectedScopeSubscription ? (
                  <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 16 }}>
                    {selectedSubscriptionSummary.map((sub) => (
                      <button
                        key={sub.id}
                        onClick={() => setSelectedScopeSubscription(sub.id)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '12px',
                          marginBottom: 8,
                          background: '#334155',
                          color: '#e2e8f0',
                          border: '1px solid #475569',
                          borderRadius: 6,
                          cursor: 'pointer',
                          fontSize: 13,
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          e.target.style.background = '#475569';
                          e.target.style.borderColor = '#64748b';
                        }}
                        onMouseLeave={(e) => {
                          e.target.style.background = '#334155';
                          e.target.style.borderColor = '#475569';
                        }}
                      >
                        {sub.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  (() => {
                    const subscriptions = relData?.data?.subscriptions || {};
                    const matchedSubKey = Object.keys(subscriptions).find(
                      (key) =>
                        key === selectedScopeSubscription ||
                        subscriptions[key]?.id === selectedScopeSubscription ||
                        `subscription_${key}` === selectedScopeSubscription
                    );
                    const resourceGroups = matchedSubKey 
                      ? Object.keys(subscriptions[matchedSubKey]?.resource_groups || {})
                      : [];

                    return (
                      <div>
                        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 16 }}>
                          {resourceGroups.length === 0 ? (
                            <div style={{ color: '#94a3b8', textAlign: 'center', padding: '20px 0' }}>
                              No resource groups found
                            </div>
                          ) : (
                            resourceGroups.map((rgName) => (
                              <button
                                key={rgName}
                                onClick={() => {
                                  const scopeData = {
                                    scopeType: 'resource-group',
                                    scopeName: rgName,
                                    selectedSubscriptionId: selectedScopeSubscription,
                                    selectedResourceGroup: rgName,
                                    scopedArchData: null,
                                  };
                                  setPendingScope(scopeData);
                                  onScopeChange(scopeData);
                                  setIsScopeModalOpen(false);
                                  setScopeModalStep('choice');
                                  setSelectedScopeSubscription('');
                                }}
                                style={{
                                  display: 'block',
                                  width: '100%',
                                  textAlign: 'left',
                                  padding: '12px',
                                  marginBottom: 8,
                                  background: '#334155',
                                  color: '#e2e8f0',
                                  border: '1px solid #475569',
                                  borderRadius: 6,
                                  cursor: 'pointer',
                                  fontSize: 13,
                                  transition: 'all 0.2s',
                                }}
                                onMouseEnter={(e) => {
                                  e.target.style.background = '#475569';
                                  e.target.style.borderColor = '#64748b';
                                }}
                                onMouseLeave={(e) => {
                                  e.target.style.background = '#334155';
                                  e.target.style.borderColor = '#475569';
                                }}
                              >
                                {rgName}
                              </button>
                            ))
                          )}
                        </div>
                        <button
                          onClick={() => setSelectedScopeSubscription('')}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '10px',
                            background: 'transparent',
                            color: '#94a3b8',
                            border: '1px solid #475569',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: 12,
                          }}
                        >
                          ← Back
                        </button>
                      </div>
                    );
                  })()
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
