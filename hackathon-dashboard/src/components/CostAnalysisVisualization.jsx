import React, { useEffect, useMemo, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { ChevronDown } from 'lucide-react';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#94a3b8'];

const RESOURCE_RULES = {
  'compute.virtual_machines': { family: 'Compute', type: 'Virtual Machine', serviceName: 'Virtual Machines', monthlyCost: 520 },
  'compute.virtual_machine_scale_sets': { family: 'Compute', type: 'VM Scale Set', serviceName: 'Virtual Machine Scale Sets', monthlyCost: 780 },
  'app_services.function_apps': { family: 'Application', type: 'Function App', serviceName: 'Azure Functions', monthlyCost: 110 },
  'app_services.web_apps': { family: 'Application', type: 'Web App', serviceName: 'App Service', monthlyCost: 160 },
  'app_services.app_service_plans': { family: 'Application', type: 'App Service Plan', serviceName: 'App Service Plan', monthlyCost: 145 },
  'app_services.logic_apps': { family: 'Integration', type: 'Logic App', serviceName: 'Logic Apps', monthlyCost: 95 },
  'storage.storage_accounts': { family: 'Storage', type: 'Storage Account', serviceName: 'Storage Accounts', monthlyCost: 95 },
  'security.keyvaults': { family: 'Security', type: 'Key Vault', serviceName: 'Azure Key Vault', monthlyCost: 36 },
  'monitoring.application_insights': { family: 'Monitoring', type: 'Application Insights', serviceName: 'Application Insights', monthlyCost: 42 },
  'monitoring.log_analytics_workspaces': { family: 'Monitoring', type: 'Log Analytics Workspace', serviceName: 'Log Analytics', monthlyCost: 68 },
  'networking.network_interfaces': { family: 'Networking', type: 'Network Interface', serviceName: 'Network Interfaces', monthlyCost: 14 },
  'networking.public_ip_addresses': { family: 'Networking', type: 'Public IP', serviceName: 'Public IP Addresses', monthlyCost: 21 },
  'networking.network_security_groups': { family: 'Networking', type: 'Network Security Group', serviceName: 'Network Security Groups', monthlyCost: 16 },
  'ai_services.openai_resources': { family: 'AI Services', type: 'Azure OpenAI', serviceName: 'Azure OpenAI', monthlyCost: 320 },
  'ai_services.cognitive_services': { family: 'AI Services', type: 'Cognitive Service', serviceName: 'Cognitive Services', monthlyCost: 210 },
  'identity.managed_identities': { family: 'Identity', type: 'Managed Identity', serviceName: 'Managed Identity', monthlyCost: 12 },
};

const DIMENSION_VALUES = {
  benefit: ['Premium', 'Standard', 'Basic'],
  chargeType: ['Commitment', 'Pay-As-You-Go', 'Savings Plan'],
  costAllocation: ['Department', 'Project', 'Cost Center', 'Business Unit'],
  frequency: ['Daily', 'Monthly', 'Yearly'],
  invoiceId: ['Invoice-001', 'Invoice-002', 'Invoice-003', 'Invoice-004'],
  pricingModel: ['Consumption', 'Reservation', 'Hybrid Benefit'],
  productOwner: ['Cloud Team', 'Data Team', 'Platform Team', 'Security Team'],
  provider: ['Microsoft Azure', 'AWS', 'Google Cloud'],
  publisherType: ['Microsoft', 'Third-Party', 'Custom'],
  reservation: ['1-Year', '3-Year', 'Pay-As-You-Go'],
  unitOfMeasure: ['GB', 'TB', 'Hours', 'Requests'],
};

const ALL_DIMENSIONS = [
  { key: 'benefit',           label: 'Benefit',             values: ['Premium', 'Standard', 'Basic'] },
  { key: 'chargeType',        label: 'Charge Type',         values: ['Commitment', 'Pay-As-You-Go', 'Savings Plan'] },
  { key: 'costAllocation',    label: 'Cost Allocation',     values: ['Department', 'Project', 'Cost Center', 'Business Unit'] },
  { key: 'frequency',         label: 'Frequency',           values: ['Daily', 'Monthly', 'Yearly'] },
  { key: 'invoiceId',         label: 'Invoice ID',          values: ['Invoice-001', 'Invoice-002', 'Invoice-003'] },
  { key: 'location',          label: 'Location',            values: ['Australia East','Australia Southeast','Austria East','Belgium Central','Canada Central','Canada East','Central India','Central US','East Asia','East US','East US 2','France Central','Germany West Central','Indonesia Central','Israel Central','Italy North','Japan East','Japan West','Korea Central','Korea South','Malaysia West','Mexico Central','New Zealand North','North Central US','North Europe','Norway East','Poland Central','South Africa North','South Central US','South India','Southeast Asia','Spain Central','Sweden Central','Switzerland North','UAE North','UK West','West Central US','West Europe','West US','West US 2','West US 3'] },
  { key: 'meter',             label: 'Meter',               values: ['Virtual Machines', 'Storage', 'Bandwidth', 'Compute Hours'] },
  { key: 'meterCategory',     label: 'Meter Category',      values: ['Compute', 'Storage', 'Network', 'Database'] },
  { key: 'meterSubcategory',  label: 'Meter Sub Category',  values: ['VM Core Hours', 'Standard HDD', 'Data Transfer', 'SQL Database'] },
  { key: 'partNumber',        label: 'Part Number',         values: ['PN-001', 'PN-002', 'PN-003', 'PN-004'] },
  { key: 'pricingModel',      label: 'Pricing Model',       values: ['Consumption', 'Reservation', 'Hybrid Benefit'] },
  { key: 'product',           label: 'Product',             values: ['Virtual Machines', 'Storage Accounts', 'App Service', 'SQL Database'] },
  { key: 'productOwner',      label: 'Product Owner',       values: ['Cloud Team', 'Data Team', 'Platform Team'] },
  { key: 'provider',          label: 'Provider',            values: ['Microsoft Azure', 'AWS', 'Google Cloud'] },
  { key: 'publisherType',     label: 'Publisher Type',      values: ['Microsoft', 'Third-Party', 'Custom'] },
  { key: 'reservation',       label: 'Reservation',         values: ['1-Year', '3-Year', 'Pay-As-You-Go'] },
  { key: 'resource',          label: 'Resource',            values: ['vm-prod-01', 'storage-001', 'app-service-01'] },
  { key: 'resourceGroupName', label: 'Resource Group Name', values: ['rg-prod', 'rg-dev', 'rg-test'] },
  { key: 'resourceGuide',     label: 'Resource Guide',      values: ['Production', 'Development', 'Testing'] },
  { key: 'resourceType',      label: 'Resource Type',       values: ['Virtual Machine', 'Storage Account', 'App Service', 'SQL Database'] },
  { key: 'serviceFamily',     label: 'Service Family',      values: ['Compute', 'Storage', 'Networking', 'Database'] },
  { key: 'serviceName',       label: 'Service Name',        values: ['Virtual Machines', 'Blob Storage', 'CDN', 'Azure SQL'] },
  { key: 'tag',               label: 'Tag',                 values: ['Environment: Prod', 'Environment: Dev', 'Team: Backend', 'Team: Frontend'] },
  { key: 'unitOfMeasure',     label: 'Unit of Measure',     values: ['GB', 'TB', 'Hours', 'Requests'] },
];

const API_DIMENSION_LABELS = {
  by_service: 'By Service',
  by_resource_group: 'By Resource Group',
  by_subscription: 'By Subscription',
  by_charge_type: 'By Charge Type',
  by_location: 'By Location',
  by_product: 'By Product',
  by_resource_type: 'By Resource Type',
  by_meter: 'By Meter',
  by_meter_category: 'By Meter Category',
  by_meter_sub_category: 'By Meter Sub Category',
  by_pricing_model: 'By Pricing Model',
  by_frequency: 'By Frequency',
  by_part_number: 'By Part Number',
  by_invoice_id: 'By Invoice ID',
  by_reservation: 'By Reservation',
  by_publisher_type: 'By Publisher Type',
};

const API_DIMENSION_ORDER = [
  'by_service',
  'by_resource_group',
  'by_subscription',
  'by_charge_type',
  'by_location',
  'by_product',
  'by_resource_type',
  'by_meter',
  'by_meter_category',
  'by_meter_sub_category',
  'by_pricing_model',
  'by_frequency',
  'by_part_number',
  'by_invoice_id',
  'by_reservation',
  'by_publisher_type',
];

function getApiDimensionLabel(key) {
  return API_DIMENSION_LABELS[key] || key;
}

function getDimensionDisplayLabel(key) {
  if (API_DIMENSION_LABELS[key]) return API_DIMENSION_LABELS[key];
  const local = ALL_DIMENSIONS.find((d) => d.key === key);
  if (local?.label) return local.label;
  return toTitleCase(String(key || '').replace(/^by_/, '').replace(/_/g, ' '));
}

function hashString(value) {
  return String(value || '').split('').reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) >>> 0, 7);
}

function pickFromList(values, seed) {
  if (!values?.length) return 'Unassigned';
  return values[Math.abs(seed) % values.length];
}

function toTitleCase(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferOtherMeta(name) {
  const normalized = String(name || '').toLowerCase();

  if (normalized.includes('sql')) {
    return { family: 'Database', type: 'SQL Database', serviceName: 'Azure SQL', monthlyCost: 260 };
  }

  if (normalized.includes('disk')) {
    return { family: 'Storage', type: 'Managed Disk', serviceName: 'Managed Disks', monthlyCost: 44 };
  }

  return { family: 'Other', type: 'Other Resource', serviceName: 'Other Services', monthlyCost: 72 };
}

function buildResourceRecord({ name, rule, subscriptionId, resourceGroupName, metadata, seedOffset = 0 }) {
  const seed = hashString(`${subscriptionId}|${resourceGroupName}|${name}|${seedOffset}`);
  const environment = metadata.environment || 'non-prod';
  const globalBusiness = metadata.globalBusiness || 'others';
  const region = metadata.region || 'East US';

  const tagOptions = [
    `Environment: ${toTitleCase(environment)}`,
    `Region: ${region}`,
    `Business: ${toTitleCase(globalBusiness)}`,
    `Network: ${toTitleCase(metadata.networkModel || 'standalone')}`,
  ];

  const provider = pickFromList(DIMENSION_VALUES.provider, seed);
  const publisherType = provider === 'Microsoft Azure'
    ? 'Microsoft'
    : pickFromList(['Third-Party', 'Custom'], seed + 5);

  return {
    benefit: pickFromList(DIMENSION_VALUES.benefit, seed + 1),
    chargeType: pickFromList(DIMENSION_VALUES.chargeType, seed + 2),
    costAllocation: pickFromList(DIMENSION_VALUES.costAllocation, seed + 3),
    frequency: pickFromList(DIMENSION_VALUES.frequency, seed + 4),
    invoiceId: pickFromList(DIMENSION_VALUES.invoiceId, seed + 5),
    location: region,
    meter: rule.serviceName,
    meterCategory: rule.family,
    meterSubcategory: rule.type,
    partNumber: `PN-${String((seed % 900) + 100).padStart(3, '0')}`,
    pricingModel: pickFromList(DIMENSION_VALUES.pricingModel, seed + 6),
    product: rule.serviceName,
    productOwner: pickFromList(DIMENSION_VALUES.productOwner, seed + 7),
    provider,
    publisherType,
    reservation: pickFromList(DIMENSION_VALUES.reservation, seed + 8),
    resource: name,
    resourceGroupName,
    resourceGuide: toTitleCase(environment),
    resourceType: rule.type,
    serviceFamily: rule.family,
    serviceName: rule.serviceName,
    tag: pickFromList(tagOptions, seed + 9),
    unitOfMeasure: pickFromList(DIMENSION_VALUES.unitOfMeasure, seed + 10),
    monthlyCost: rule.monthlyCost,
    subscriptionId,
  };
}

function collectScopedResources(data, scope = 'Subscription', selectedSubscriptions = [], selectedResourceGroup = '', selectedResource = '') {
  const subscriptions = data?.data?.subscriptions || {};
  const subscriptionIds = Array.isArray(selectedSubscriptions) ? selectedSubscriptions : (selectedSubscriptions ? [selectedSubscriptions] : Object.keys(subscriptions));
  const activeSubscriptionIds = subscriptionIds.filter((id) => subscriptions[id]) || Object.keys(subscriptions).slice(0, 1);

  if (!activeSubscriptionIds.length) return [];

  const allResources = activeSubscriptionIds.flatMap((activeSubscriptionId) => {
    const subscription = subscriptions[activeSubscriptionId];
    const metadata = subscription?.metadata || {};
    const resourceGroups = subscription?.resource_groups || {};
    const resourceGroupEntries = Object.entries(resourceGroups).filter(([resourceGroupName]) => (
      scope !== 'Resource Group' && scope !== 'Resource'
        ? true
        : resourceGroupName === selectedResourceGroup
    ));

    return resourceGroupEntries.flatMap(([resourceGroupName, resourceGroup]) => {
      const categories = resourceGroup?.categories || {};
      const resources = [];

      Object.entries(RESOURCE_RULES).forEach(([path, rule]) => {
        const [groupKey, itemKey] = path.split('.');
        const names = categories[groupKey]?.[itemKey] || [];

        names.forEach((name, index) => {
          resources.push(buildResourceRecord({
            name,
            rule,
            subscriptionId: activeSubscriptionId,
            resourceGroupName,
            metadata,
            seedOffset: index,
          }));
        });
      });

      Object.entries(categories.networking?.virtual_networks || {}).forEach(([vnetName, vnet], index) => {
        resources.push(buildResourceRecord({
          name: vnetName,
          rule: { family: 'Networking', type: 'Virtual Network', serviceName: 'Virtual Networks', monthlyCost: 50 },
          subscriptionId: activeSubscriptionId,
          resourceGroupName,
          metadata,
          seedOffset: index,
        }));

        (vnet?.subnets || []).forEach((subnetName, subnetIndex) => {
          resources.push(buildResourceRecord({
            name: subnetName,
            rule: { family: 'Networking', type: 'Subnet', serviceName: 'Virtual Networks', monthlyCost: 18 },
            subscriptionId: activeSubscriptionId,
            resourceGroupName,
            metadata,
            seedOffset: subnetIndex + 20,
          }));
        });
      });

      (categories.other_resources || []).forEach((name, index) => {
      resources.push(buildResourceRecord({
        name,
        rule: inferOtherMeta(name),
        subscriptionId: activeSubscriptionId,
        resourceGroupName,
        metadata,
        seedOffset: index + 40,
      }));
    });

      return resources;
    });
  });

  if (scope === 'Resource') {
    return allResources.filter((resource) => resource.resource === selectedResource);
  }

  return allResources;
}

function generateCostData(resources, dimensionKey) {
  const grouped = resources.reduce((acc, resource) => {
    const key = resource[dimensionKey] || 'Unassigned';
    acc.set(key, (acc.get(key) || 0) + (resource.monthlyCost || 0));
    return acc;
  }, new Map());

  return Array.from(grouped.entries())
    .map(([name, value]) => ({ name, value: Math.round(value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

function DimensionDropdown({ circleIndex, selectedKey, usedKeys, onChange, options }) {
  const [open, setOpen] = useState(false);

  const dimensionOptions = options.filter(
    (d) => d.key === selectedKey || !usedKeys.includes(d.key)
  );

  const selectedLabel = getDimensionDisplayLabel(selectedKey);

  return (
    <div className="circle-dim-selector">
      <button
        type="button"
        className="circle-dim-button"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="circle-dim-label">{selectedLabel}</span>
        <ChevronDown
          size={12}
          style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s', flexShrink: 0 }}
        />
      </button>
      {open && (
        <div className="circle-dim-menu">
          {dimensionOptions.map((dim) => (
            <button
              key={dim.key}
              type="button"
              className={`circle-dim-option${dim.key === selectedKey ? ' selected' : ''}`}
              onClick={() => { onChange(circleIndex, dim.key); setOpen(false); }}
            >
              {getDimensionDisplayLabel(dim.key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CostCircle({
  circleIndex,
  selectedKey,
  usedKeys,
  onDimensionChange,
  data,
  dropdownOptions,
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="cost-circle-container">
      <DimensionDropdown
        circleIndex={circleIndex}
        selectedKey={selectedKey}
        usedKeys={usedKeys}
        onChange={onDimensionChange}
        options={dropdownOptions}
      />
      <div className="cost-circle-wrapper">
        <div style={{ width: 140, height: 140, position: 'relative' }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.length ? data : [{ name: 'No Data', value: 1 }]}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={65}
                paddingAngle={1.5}
                dataKey="value"
              >
                {data.map((entry, index) => (
                  <Cell key={`${entry.name || 'cost-item'}-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
            </PieChart>
          </ResponsiveContainer>
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
              pointerEvents: 'none',
            }}
          >
            <div className="cost-circle-total">
              ${total.toLocaleString()}
            </div>
            <div className="cost-circle-label">Cost</div>
          </div>
        </div>

        <div className="cost-legend-compact">
          {data.map((item, index) => (
            <div key={`${item.name || 'cost-item'}-${index}`} className="cost-legend-item-compact">
              <div className="cost-legend-dot" style={{ background: COLORS[index % COLORS.length] }} />
              <span className="cost-legend-text">{item.name}</span>
              <span className="cost-legend-value">${item.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function CostAnalysisVisualization({
  data,
  scope = 'Subscription',
  selectedSubscription = [],
  selectedResourceGroup = '',
  selectedResource = '',
  apiCostAnalysis = null,
}) {
  const apiDimensionMap = useMemo(() => {
    const entries = Array.isArray(apiCostAnalysis?.dimensions) ? apiCostAnalysis.dimensions : [];
    const map = new Map();
    entries.forEach((entry) => {
      const key = String(entry?.key || entry?.dimensionKey || '').trim();
      const rows = Array.isArray(entry?.data) ? entry.data : [];
      if (key) map.set(key, rows);
    });
    return map;
  }, [apiCostAnalysis]);

  const hasApiCostDimensions = apiDimensionMap.size > 0;

  const apiDimensionOptions = useMemo(() => {
    const apiOrdered = API_DIMENSION_ORDER
      .filter((key) => apiDimensionMap.has(key))
      .map((key) => ({ key, label: getApiDimensionLabel(key) }));

    const apiUnordered = Array.from(apiDimensionMap.keys())
      .filter((key) => !API_DIMENSION_ORDER.includes(key))
      .map((key) => ({ key, label: getApiDimensionLabel(key) }));

    const localOptions = ALL_DIMENSIONS.map((item) => ({ key: item.key, label: item.label }));

    const merged = [...apiOrdered, ...apiUnordered, ...localOptions];
    const seen = new Set();
    return merged.filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
  }, [apiDimensionMap]);

  const [dims, setDims] = useState(() => (
    hasApiCostDimensions
      ? apiDimensionOptions.slice(0, 3).map((item) => item.key)
      : ['serviceFamily', 'location', 'meterCategory']
  ));

  useEffect(() => {
    if (hasApiCostDimensions) {
      const preferred = ['by_service', 'by_resource_group', 'by_subscription'];
      const availableKeys = apiDimensionOptions.map((item) => item.key);
      const next = [...preferred.filter((key) => availableKeys.includes(key)), ...availableKeys]
        .filter((key, index, arr) => arr.indexOf(key) === index)
        .slice(0, 3);
      setDims((prev) => {
        if (
          prev.length === next.length
          && prev.every((item, index) => item === next[index])
        ) {
          return prev;
        }
        return next;
      });
      return;
    }

    setDims((prev) => {
      const fallback = ['serviceFamily', 'location', 'meterCategory'];
      if (prev.length === fallback.length && prev.every((item, index) => item === fallback[index])) {
        return prev;
      }
      return fallback;
    });
  }, [hasApiCostDimensions, apiDimensionOptions]);

  const [dim0, dim1, dim2] = dims;

  const scopedResources = useMemo(
    () => collectScopedResources(data, scope, selectedSubscription, selectedResourceGroup, selectedResource),
    [data, scope, selectedSubscription, selectedResourceGroup, selectedResource]
  );

  const scopeSummary = useMemo(() => {
    const selectedLabel = scope === 'Subscription'
      ? (selectedSubscription || 'No subscription selected')
      : scope === 'Resource Group'
        ? (selectedResourceGroup || 'No resource group selected')
        : (selectedResource || 'No resource selected');
    return `${scope} scope • ${selectedLabel} • ${scopedResources.length} resources`;
  }, [scope, selectedSubscription, selectedResourceGroup, selectedResource, scopedResources.length]);

  const handleChange = (circleIndex, newKey) => {
    setDims((prev) => {
      const updated = [...prev];
      updated[circleIndex] = newKey;
      return updated;
    });
  };

  const data0 = useMemo(() => generateCostData(scopedResources, dim0), [dim0, scopedResources]);
  const data1 = useMemo(() => generateCostData(scopedResources, dim1), [dim1, scopedResources]);
  const data2 = useMemo(() => generateCostData(scopedResources, dim2), [dim2, scopedResources]);

  const normalizeApiRows = (rows) => (Array.isArray(rows) ? rows : [])
    .map((item) => ({
      name: String(item?.name || '').trim(),
      value: Number(item?.value ?? 0),
    }))
    .filter((item) => item.name && Number.isFinite(item.value) && item.value >= 0);

  const resolvedData0 = hasApiCostDimensions
    ? normalizeApiRows(apiDimensionMap.get(dim0) || [])
    : data0;
  const resolvedData1 = hasApiCostDimensions
    ? normalizeApiRows(apiDimensionMap.get(dim1) || [])
    : data1;
  const resolvedData2 = hasApiCostDimensions
    ? normalizeApiRows(apiDimensionMap.get(dim2) || [])
    : data2;

  const dropdownOptions = hasApiCostDimensions
    ? apiDimensionOptions
    : ALL_DIMENSIONS;

  return (
    <div className="cost-analysis-container">
      <div className="cost-analysis-summary">{scopeSummary}</div>
      <div className="cost-circles-container">
        {!!dims[0] && (
          <CostCircle
            circleIndex={0}
            selectedKey={dims[0]}
            usedKeys={dims}
            onDimensionChange={handleChange}
            data={resolvedData0}
            dropdownOptions={dropdownOptions}
          />
        )}
        {!!dims[1] && (
          <CostCircle
            circleIndex={1}
            selectedKey={dims[1]}
            usedKeys={dims}
            onDimensionChange={handleChange}
            data={resolvedData1}
            dropdownOptions={dropdownOptions}
          />
        )}
        {!!dims[2] && (
          <CostCircle
            circleIndex={2}
            selectedKey={dims[2]}
            usedKeys={dims}
            onDimensionChange={handleChange}
            data={resolvedData2}
            dropdownOptions={dropdownOptions}
          />
        )}
      </div>
    </div>
  );
}
