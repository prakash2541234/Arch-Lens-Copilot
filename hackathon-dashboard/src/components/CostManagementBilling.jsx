import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';

const SCOPE_OPTIONS = ['Subscription', 'Resource Group', 'Resource'];

const RESOURCE_RULES = {
  'compute.virtual_machines': { family: 'Virtual Machines', type: 'Virtual Machine', monthlyCost: 520 },
  'compute.virtual_machine_scale_sets': { family: 'Virtual Machines', type: 'VM Scale Set', monthlyCost: 780 },
  'app_services.function_apps': { family: 'App Services', type: 'Function App', monthlyCost: 110 },
  'app_services.web_apps': { family: 'App Services', type: 'Web App', monthlyCost: 160 },
  'app_services.app_service_plans': { family: 'App Services', type: 'App Service Plan', monthlyCost: 145 },
  'app_services.logic_apps': { family: 'App Services', type: 'Logic App', monthlyCost: 95 },
  'storage.storage_accounts': { family: 'Storage', type: 'Storage Account', monthlyCost: 95 },
  'security.keyvaults': { family: 'Security', type: 'Key Vault', monthlyCost: 36 },
  'monitoring.application_insights': { family: 'Monitoring', type: 'Application Insights', monthlyCost: 42 },
  'monitoring.log_analytics_workspaces': { family: 'Monitoring', type: 'Log Analytics Workspace', monthlyCost: 68 },
  'networking.network_interfaces': { family: 'Networking', type: 'Network Interface', monthlyCost: 14 },
  'networking.public_ip_addresses': { family: 'Networking', type: 'Public IP', monthlyCost: 21 },
  'networking.network_security_groups': { family: 'Networking', type: 'Network Security Group', monthlyCost: 16 },
  'networking.virtual_networks': { family: 'Networking', type: 'Virtual Network', monthlyCost: 50 },
  'networking.subnets': { family: 'Networking', type: 'Subnet', monthlyCost: 18 },
  'ai_services.openai_resources': { family: 'AI Services', type: 'Azure OpenAI', monthlyCost: 320 },
  'ai_services.cognitive_services': { family: 'AI Services', type: 'Cognitive Service', monthlyCost: 210 },
  'identity.managed_identities': { family: 'Identity', type: 'Managed Identity', monthlyCost: 12 },
};

function addResources(target, names, rule) {
  if (!Array.isArray(names)) return;

  names.forEach((name) => {
    target.push({
      id: name,
      name,
      family: rule.family,
      type: rule.type,
      monthlyCost: rule.monthlyCost,
    });
  });
}

function inferOtherResourceMeta(name) {
  const normalized = String(name || '').toLowerCase();

  if (normalized.includes('sql')) {
    return { family: 'Database', type: 'SQL Database', monthlyCost: 260 };
  }

  if (normalized.includes('disk')) {
    return { family: 'Storage', type: 'Managed Disk', monthlyCost: 44 };
  }

  return { family: 'Other', type: 'Other Resource', monthlyCost: 72 };
}

function collectResourcesFromResourceGroup(resourceGroup) {
  const resources = [];
  const categories = resourceGroup?.categories || {};

  Object.entries(RESOURCE_RULES).forEach(([path, rule]) => {
    const [groupKey, itemKey] = path.split('.');
    addResources(resources, categories[groupKey]?.[itemKey], rule);
  });

  const virtualNetworks = categories.networking?.virtual_networks || {};
  Object.entries(virtualNetworks).forEach(([vnetName, vnet]) => {
    resources.push({
      id: vnetName,
      name: vnetName,
      family: 'Networking',
      type: 'Virtual Network',
      monthlyCost: RESOURCE_RULES['networking.virtual_networks'].monthlyCost,
    });

    addResources(resources, vnet?.subnets, RESOURCE_RULES['networking.subnets']);
  });

  (categories.other_resources || []).forEach((name) => {
    const meta = inferOtherResourceMeta(name);
    resources.push({
      id: name,
      name,
      family: meta.family,
      type: meta.type,
      monthlyCost: meta.monthlyCost,
    });
  });

  return resources;
}

function extractHierarchy(data) {
  const hierarchy = {
    subscriptions: [],
    resourceGroups: {},
    resources: {},
  };

  const subscriptions = data?.data?.subscriptions || {};

  Object.entries(subscriptions).forEach(([subscriptionId, subscription]) => {
    if (!subscriptionId || !subscription || typeof subscription !== 'object') return;
    const subscriptionName = subscription?.metadata?.subscriptionName
      || subscription?.metadata?.displayName
      || subscriptionId;
    hierarchy.subscriptions.push({ id: subscriptionId, name: subscriptionName });

    const resourceGroups = Object.entries(subscription?.resource_groups || {});
    hierarchy.resourceGroups[subscriptionId] = resourceGroups.map(([resourceGroupName]) => ({
      id: resourceGroupName,
      name: resourceGroupName,
    }));

    resourceGroups.forEach(([resourceGroupName, resourceGroup]) => {
      const key = `${subscriptionId}|${resourceGroupName}`;
      hierarchy.resources[key] = collectResourcesFromResourceGroup(resourceGroup || {}).map((resource) => ({
        id: resource.id,
        name: resource.name,
      }));
    });
  });

  return hierarchy;
}

function resolveSubscriptionKey(subscriptions, candidateId) {
  const candidate = String(candidateId || '').trim().toLowerCase();
  if (!candidate) return '';

  return Object.keys(subscriptions).find((key) => {
    const normalizedKey = String(key || '').trim().toLowerCase();
    const metadataId = String(subscriptions[key]?.id || '').trim().toLowerCase();
    return normalizedKey === candidate
      || metadataId === candidate
      || normalizedKey.replace(/^subscription_/, '') === candidate.replace(/^subscription_/, '');
  }) || '';
}

function buildScopedResources(data, scope, selectedSubscriptions, selectedResourceGroup, selectedResource) {
  const subscriptions = data?.data?.subscriptions || {};
  const subscriptionIds = Array.isArray(selectedSubscriptions) ? selectedSubscriptions : [selectedSubscriptions || Object.keys(subscriptions)[0] || ''];
  
  if (scope === 'Subscription') {
    const resources = subscriptionIds.flatMap((subscriptionId) => {
      const resolvedId = resolveSubscriptionKey(subscriptions, subscriptionId);
      const subscription = subscriptions[resolvedId];
      if (!subscription) return [];
        const subscriptionGroups = subscription.resource_groups || {};
        const resourceGroupNames = Array.isArray(selectedResourceGroup)
          ? selectedResourceGroup
          : [selectedResourceGroup];
      return Object.values(subscriptionGroups).flatMap((resourceGroup) => collectResourcesFromResourceGroup(resourceGroup));
    });

    const scopeName = subscriptionIds.length > 1 ? `${subscriptionIds.length} subscriptions` : subscriptionIds[0];
    return {
      resources,
      subscriptionIds,
      resourceGroupName: '',
      scopeName,
      scopeTypeLabel: 'subscriptions',
      isMultiSubscription: subscriptionIds.length > 1,
    };
  }

  // For Resource Group and Resource scopes, use first selected subscription
  const subscriptionId = subscriptionIds[0] || '';
  const resolvedSubscriptionId = resolveSubscriptionKey(subscriptions, subscriptionId);
  const subscription = subscriptions[resolvedSubscriptionId];

  if (!subscription) {
    return {
      resources: [],
      subscriptionIds,
      resourceGroupName: '',
      scopeName: 'No scope selected',
      scopeTypeLabel: 'scope',
      isMultiSubscription: false,
    };
  }

  const subscriptionGroups = subscription.resource_groups || {};
    const requestedResourceGroups = Array.isArray(selectedResourceGroup)
      ? selectedResourceGroup
      : [selectedResourceGroup];
    const fallbackResourceGroup = requestedResourceGroups.find((name) => subscriptionGroups[name])
      || Object.keys(subscriptionGroups)[0] || '';
    const selectedResourceGroups = requestedResourceGroups.filter((name) => subscriptionGroups[name]);
  const resourceGroup = subscriptionGroups[fallbackResourceGroup];

  if (!resourceGroup) {
    return {
      resources: [],
      subscriptionIds,
      resourceGroupName: '',
      scopeName: 'No resource group selected',
      scopeTypeLabel: 'resource group',
      isMultiSubscription: false,
    };
  }

  const groupResources = collectResourcesFromResourceGroup(resourceGroup);

  if (scope === 'Resource Group') {
    return {
      resources: groupResources,
      subscriptionIds,
      resourceGroupName: fallbackResourceGroup,
      scopeName: fallbackResourceGroup,
      scopeTypeLabel: 'resource group',
      isMultiSubscription: false,
    };
  }

  const resourceName = selectedResource || groupResources[0]?.name || '';
  const scopedResource = groupResources.filter((resource) => resource.name === resourceName);

  return {
    resources: scopedResource,
    subscriptionIds,
    resourceGroupName: fallbackResourceGroup,
    scopeName: resourceName || 'No resource selected',
    scopeTypeLabel: 'resource',
    isMultiSubscription: false,
  };
}

function buildScopeTotals(data, scope, selectedSubscriptions, selectedResourceGroup, selectedResource, currentDay, daysInMonth, apiCostAnalysis = null) {
  const scoped = buildScopedResources(
    data,
    scope,
    selectedSubscriptions,
    selectedResourceGroup,
    selectedResource
  );

  const apiDimensions = Array.isArray(apiCostAnalysis?.dimensions) ? apiCostAnalysis.dimensions : [];
  const bySubscriptionDimension = apiDimensions.find((entry) => {
    const k = String(entry?.key || entry?.dimensionKey || '').trim().toLowerCase();
    return k === 'by_subscription';
  });
  const byResourceGroupDimension = apiDimensions.find((entry) => {
    const k = String(entry?.key || entry?.dimensionKey || '').trim().toLowerCase();
    return k === 'by_resource_group';
  });
  const byResourceDimension = apiDimensions.find((entry) => {
    const k = String(entry?.key || entry?.dimensionKey || '').trim().toLowerCase();
    return k === 'by_resource';
  });

  const bySubscriptionData = Array.isArray(bySubscriptionDimension?.data) ? bySubscriptionDimension.data : [];
  const byResourceGroupData = Array.isArray(byResourceGroupDimension?.data) ? byResourceGroupDimension.data : [];
  const byResourceData = Array.isArray(byResourceDimension?.data) ? byResourceDimension.data : [];

  const selectedSet = new Set(scoped.subscriptionIds || []);
  const apiSubscriptionUsed = bySubscriptionData
    .filter((item) => selectedSet.size === 0 || selectedSet.has(String(item?.name || '').trim()))
    .reduce((sum, item) => sum + Number(item?.value || 0), 0);

  const apiResourceGroupUsed = scope === 'Resource Group'
    ? byResourceGroupData
        .filter((item) => String(item?.name || '').trim().toLowerCase() === String(scoped.resourceGroupName || '').trim().toLowerCase())
        .reduce((sum, item) => sum + Number(item?.value || 0), 0)
    : 0;

  const apiResourceUsed = scope === 'Resource'
    ? byResourceData
        .filter((item) => String(item?.name || '').trim().toLowerCase() === String(scoped.scopeName || '').trim().toLowerCase())
        .reduce((sum, item) => sum + Number(item?.value || 0), 0)
    : 0;

  const syntheticForecast = scoped.resources.reduce((sum, resource) => sum + resource.monthlyCost, 0);
  const progress = daysInMonth ? Math.min(currentDay / daysInMonth, 1) : 0;

  let actual;
  let forecast;

  if (scope === 'Subscription' && apiSubscriptionUsed > 0) {
    actual = Math.round(apiSubscriptionUsed);
    const normalizedProgress = Math.max(progress, 0.05);
    forecast = Math.max(actual, Math.round(actual / normalizedProgress));
  } else if (scope === 'Resource Group' && apiResourceGroupUsed > 0) {
    actual = Math.round(apiResourceGroupUsed);
    const normalizedProgress = Math.max(progress, 0.05);
    forecast = Math.max(actual, Math.round(actual / normalizedProgress));
  } else if (scope === 'Resource' && apiResourceUsed > 0) {
    actual = Math.round(apiResourceUsed);
    const normalizedProgress = Math.max(progress, 0.05);
    forecast = Math.max(actual, Math.round(actual / normalizedProgress));
  } else {
    forecast = syntheticForecast;
    actual = Math.round(forecast * progress * 0.96);
  }

  const breakdownMap = new Map();
  if (scope === 'Subscription' && byResourceGroupData.length > 0) {
    byResourceGroupData.forEach((item) => {
      const name = String(item?.name || '').trim();
      const value = Number(item?.value || 0);
      if (name && value >= 0) breakdownMap.set(name, (breakdownMap.get(name) || 0) + value);
    });
  } else if (scope === 'Resource Group' && byResourceData.length > 0) {
    byResourceData.forEach((item) => {
      const name = String(item?.name || '').trim();
      const value = Number(item?.value || 0);
      if (name && value >= 0) breakdownMap.set(name, (breakdownMap.get(name) || 0) + value);
    });
  } else if (scope === 'Resource' && byResourceData.length > 0) {
    const name = String(scoped.scopeName || '').trim();
    const value = byResourceData
      .filter((item) => String(item?.name || '').trim().toLowerCase() === name.toLowerCase())
      .reduce((sum, item) => sum + Number(item?.value || 0), 0);
    if (name) breakdownMap.set(name, value);
  } else {
    scoped.resources.forEach((resource) => {
      const key = scope === 'Resource' ? resource.type : resource.family;
      breakdownMap.set(key, (breakdownMap.get(key) || 0) + resource.monthlyCost);
    });
  }

  const breakdown = Array.from(breakdownMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const usedLabel = scope === 'Subscription'
    ? scoped.isMultiSubscription ? 'Used so far for selected subscriptions' : 'Used so far for subscription'
    : scope === 'Resource Group'
      ? 'Used so far for resource group'
      : 'Used so far for resource';

  const estimatedLabel = scope === 'Subscription'
    ? scoped.isMultiSubscription ? 'Estimated month-end for selected subscriptions' : 'Estimated month-end for subscription'
    : scope === 'Resource Group'
      ? 'Estimated month-end for resource group'
      : 'Estimated month-end for resource';

  const scopeSubtitle = scope === 'Subscription'
    ? scoped.isMultiSubscription 
      ? `Tracking ${scoped.scopeName}`
      : `Tracking the selected subscription: ${scoped.scopeName}`
    : scope === 'Resource Group'
      ? `Tracking resource group ${scoped.scopeName} in ${scoped.subscriptionIds[0]}`
      : `Tracking resource ${scoped.scopeName} in ${scoped.resourceGroupName}`;

  return {
    actual,
    forecast,
    breakdown: breakdown.length ? breakdown : [{ name: 'No cost data', value: 0 }],
    usedLabel,
    estimatedLabel,
    scopeSubtitle,
    scopeName: scoped.scopeName,
    scopeTypeLabel: scoped.scopeTypeLabel,
    resourceCount: scoped.resources.length,
  };
}

function buildAccumulatedSeries(actual, forecast, currentDay, daysInMonth) {
  const dayPoints = Array.from({ length: daysInMonth }, (_, index) => index + 1);

  return dayPoints.map((day) => {
    const forecastProgress = day / daysInMonth;
    const actualProgress = currentDay > 0 ? day / currentDay : 0;

    return {
      label: `Day ${day}`,
      actual: day <= currentDay ? Math.round(actual * actualProgress) : null,
      forecast: Math.round(forecast * forecastProgress),
    };
  });
}

function buildSixValueTicks(maxValue) {
  const safeMax = Math.max(1, Number(maxValue || 0));
  const roughStep = safeMax / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;

  let niceNormalized = 1;
  if (normalized > 1 && normalized <= 2) niceNormalized = 2;
  else if (normalized > 2 && normalized <= 5) niceNormalized = 5;
  else if (normalized > 5) niceNormalized = 10;

  const step = niceNormalized * magnitude;
  return Array.from({ length: 6 }, (_, index) => Math.round(index * step));
}

function FilterDropdown({ label, value, onChange, options, disabled = false, isMultiSelect = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const wrapperRef = useRef(null);

  const validOptions = (Array.isArray(options) ? options : []).filter((option) => {
    if (typeof option === 'string') return option.trim().length > 0;
    return option && typeof option === 'object' && String(option.id || option.name || '').trim().length > 0;
  });
  const selectedArray = isMultiSelect ? (Array.isArray(value) ? value : []) : value;
  const displayValue = isMultiSelect
    ? selectedArray.length === validOptions.length && validOptions.length > 0
      ? `All ${validOptions.length} selected`
      : selectedArray.length > 0
        ? `${selectedArray.length} selected`
        : `Select ${label}`
    : value || `Select ${label}`;

  const handleSelectAll = () => {
    const allValues = validOptions.map((opt) => (typeof opt === 'string' ? opt : opt.id || opt.name));
    onChange(allValues);
  };

  const handleToggleOption = (optionValue) => {
    if (!isMultiSelect) {
      onChange(optionValue);
      setIsOpen(false);
      return;
    }

    const updated = selectedArray.includes(optionValue)
      ? selectedArray.filter((v) => v !== optionValue)
      : [...selectedArray, optionValue];
    onChange(updated);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && isOpen) {
      setIsOpen(false);
      setInputValue('');
    }
  };

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleOutsideClick = (event) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [isOpen]);

  return (
    <div className="filter-dropdown" ref={wrapperRef}>
      <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>
        {label}
      </label>
      <div className="dropdown-wrapper">
        <button
          className="dropdown-button"
          onClick={() => !disabled && setIsOpen(!isOpen)}
          type="button"
          disabled={disabled}
          style={{
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <span>{displayValue}</span>
          <ChevronDown
            size={14}
            style={{
              transform: isOpen ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.2s',
            }}
          />
        </button>
        {isOpen && !disabled && (
          <div className="dropdown-menu">
            {isMultiSelect && (
              <>
                <button
                  className="dropdown-option select-all-btn"
                  onClick={handleSelectAll}
                  type="button"
                  style={{
                    fontWeight: 'bold',
                    borderBottom: '1px solid #e5e7eb',
                    backgroundColor: '#f9fafb',
                  }}
                >
                  ✓ Select All
                </button>
                <div className="dropdown-search" style={{ padding: '8px', borderBottom: '1px solid #e5e7eb' }}>
                  <input
                    type="text"
                    placeholder="Search..."
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    style={{
                      width: '100%',
                      padding: '6px 8px',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '13px',
                    }}
                  />
                </div>
              </>
            )}
            {validOptions
              .filter((opt) => {
                const label = typeof opt === 'string' ? opt : opt.name || opt.id;
                return label.toLowerCase().includes(inputValue.toLowerCase());
              })
              .map((option) => {
                const optionValue = String(typeof option === 'string' ? option : option.id || option.name || '').trim();
                const optionLabel = String(typeof option === 'string' ? option : option.name || option.id || optionValue).trim();
                const isSelected = isMultiSelect ? selectedArray.includes(optionValue) : value === optionValue;

                return (
                  <button
                    key={optionValue}
                    className={`dropdown-option ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleToggleOption(optionValue)}
                    type="button"
                    style={isMultiSelect ? { display: 'flex', alignItems: 'center', gap: '8px' } : undefined}
                  >
                    {isMultiSelect && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => { }}
                        style={{ cursor: 'pointer' }}
                      />
                    )}
                    {optionLabel}
                  </button>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CostManagementBilling({
  data,
  apiCostAnalysis = null,
  scope: controlledScope,
  setScope: setControlledScope,
  selectedSubscription: controlledSelectedSubscription,
  setSelectedSubscription: setControlledSelectedSubscription,
  selectedResourceGroup: controlledSelectedResourceGroup,
  setSelectedResourceGroup: setControlledSelectedResourceGroup,
  selectedResource: controlledSelectedResource,
  setSelectedResource: setControlledSelectedResource,
}) {
  const hierarchy = useMemo(() => extractHierarchy(data), [data]);

  const [localScope, setLocalScope] = useState('Subscription');
  const [localSelectedSubscriptions, setLocalSelectedSubscriptions] = useState([]);
  const [localSelectedResourceGroup, setLocalSelectedResourceGroup] = useState('');
  const [localSelectedResource, setLocalSelectedResource] = useState('');

  const scope = controlledScope ?? localScope;
  const setScope = setControlledScope ?? setLocalScope;
  
  // Support both single subscription (backward compat) and multiple subscriptions
  const selectedSubscriptions = controlledSelectedSubscription
    ? (Array.isArray(controlledSelectedSubscription) ? controlledSelectedSubscription : [controlledSelectedSubscription])
    : localSelectedSubscriptions;
  const setSelectedSubscriptions = (value) => {
    if (setControlledSelectedSubscription) {
      setControlledSelectedSubscription(value);
    } else {
      setLocalSelectedSubscriptions(Array.isArray(value) ? value : [value]);
    }
  };
  
  const selectedResourceGroup = controlledSelectedResourceGroup ?? localSelectedResourceGroup;
  const setSelectedResourceGroup = setControlledSelectedResourceGroup ?? setLocalSelectedResourceGroup;
  const selectedResource = controlledSelectedResource ?? localSelectedResource;
  const setSelectedResource = setControlledSelectedResource ?? setLocalSelectedResource;

  useEffect(() => {
    if (selectedSubscriptions.length === 0 && hierarchy.subscriptions.length > 0) {
      setSelectedSubscriptions([hierarchy.subscriptions[0].id]);
    }
  }, [hierarchy.subscriptions, selectedSubscriptions.length]);

  const availableResourceGroups = useMemo(
    () => {
      const firstSubscription = selectedSubscriptions[0];
      return firstSubscription ? (hierarchy.resourceGroups[firstSubscription] || []) : [];
    },
    [hierarchy.resourceGroups, selectedSubscriptions]
  );

  useEffect(() => {
    if (!availableResourceGroups.length) {
      if (selectedResourceGroup) setSelectedResourceGroup('');
      if (selectedResource) setSelectedResource('');
      return;
    }

    if (!availableResourceGroups.some((resourceGroup) => resourceGroup.id === selectedResourceGroup)) {
      const nextResourceGroup = availableResourceGroups[0].id;
      if (selectedResourceGroup !== nextResourceGroup) setSelectedResourceGroup(nextResourceGroup);
      if (selectedResource) setSelectedResource('');
    }
  }, [availableResourceGroups, selectedResourceGroup, selectedResource]);

  const availableResources = useMemo(() => {
    const firstSubscription = selectedSubscriptions[0];
    const key = `${firstSubscription}|${selectedResourceGroup}`;
    return hierarchy.resources[key] || [];
  }, [hierarchy.resources, selectedResourceGroup, selectedSubscriptions]);

  useEffect(() => {
    if (!availableResources.length) {
      if (selectedResource) setSelectedResource('');
      return;
    }

    if (!availableResources.some((resource) => resource.id === selectedResource)) {
      const nextResource = availableResources[0].id;
      if (selectedResource !== nextResource) setSelectedResource(nextResource);
    }
  }, [availableResources, selectedResource]);

  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const currentDay = Math.min(today.getDate(), daysInMonth);

  const totals = useMemo(
    () => buildScopeTotals(
      data,
      scope,
      selectedSubscriptions,
      selectedResourceGroup,
      selectedResource,
      currentDay,
      daysInMonth,
      apiCostAnalysis
    ),
    [data, scope, selectedSubscriptions, selectedResourceGroup, selectedResource, currentDay, daysInMonth, apiCostAnalysis]
  );

  const series = useMemo(
    () => buildAccumulatedSeries(totals.actual, totals.forecast, currentDay, daysInMonth),
    [totals.actual, totals.forecast, currentDay, daysInMonth]
  );

  const yTicks = useMemo(
    () => buildSixValueTicks(Math.max(totals.forecast, totals.actual)),
    [totals.actual, totals.forecast]
  );

  const currency = (value) => `$${Number(value || 0).toLocaleString()}`;

  return (
    <div className="cost-mgmt-panel">
      <div className="panel-header">
        <div className="cost-mgmt-header-copy">
          <h3>Cost Management + Billing</h3>
          <p className="cost-mgmt-subtitle">{totals.scopeSubtitle}</p>
        </div>
      </div>

      <div className="cost-scope-section-mgmt">
        <div className="scope-selector">
          <label>Select Scope</label>
          <div className="scope-buttons">
            {SCOPE_OPTIONS.map((scopeOption) => (
              <button
                key={scopeOption}
                type="button"
                className={`scope-button ${scope === scopeOption ? 'active' : ''}`}
                onClick={() => {
                  setScope(scopeOption);
                  if (scopeOption === 'Subscription') {
                    setSelectedResourceGroup('');
                    setSelectedResource('');
                  }
                  if (scopeOption === 'Resource Group') {
                    setSelectedResource('');
                  }
                }}
              >
                {scopeOption}
              </button>
            ))}
          </div>
        </div>

        <div className="scope-cascading-selectors-mgmt">
          <FilterDropdown
            label="Subscription"
            value={selectedSubscriptions}
            onChange={setSelectedSubscriptions}
            options={hierarchy.subscriptions}
            disabled={hierarchy.subscriptions.length === 0}
            isMultiSelect={true}
          />

          {(scope === 'Resource Group' || scope === 'Resource') && (
            <FilterDropdown
              label="Resource Group"
              value={selectedResourceGroup}
              onChange={setSelectedResourceGroup}
              options={availableResourceGroups}
              disabled={availableResourceGroups.length === 0}
            />
          )}

          {scope === 'Resource' && (
            <FilterDropdown
              label="Resource"
              value={selectedResource}
              onChange={setSelectedResource}
              options={availableResources}
              disabled={availableResources.length === 0}
            />
          )}
        </div>
      </div>

      <div className="cost-mgmt-metrics">
        <div className="cost-metric-box">
          <div className="cost-metric-label">{totals.usedLabel}</div>
          <div className="cost-metric-value">{currency(totals.actual)}</div>
        </div>
        <div className="cost-metric-box">
          <div className="cost-metric-label">{totals.estimatedLabel}</div>
          <div className="cost-metric-value">{currency(totals.forecast)}</div>
        </div>
      </div>

      <div className="cost-mgmt-chart-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6b7280' }} minTickGap={18} />
            <YAxis
              tick={{ fontSize: 12, fill: '#6b7280' }}
              ticks={yTicks}
              domain={[0, yTicks[yTicks.length - 1]]}
              interval={0}
              width={82}
              tickFormatter={(value) => `$${Number(value).toLocaleString()}`}
            />
            <Tooltip
              formatter={(value, name) => [currency(value), name === 'actual' ? 'Used so far' : 'Estimated trend']}
            />
            <ReferenceLine
              x={`Day ${currentDay}`}
              stroke="#0ea5e9"
              strokeDasharray="4 4"
              label={{ value: `Today (Day ${currentDay})`, position: 'insideTopLeft', fill: '#0369a1', fontSize: 10 }}
            />
            <ReferenceLine
              y={totals.forecast}
              stroke="#16a34a"
              strokeDasharray="5 5"
              label={{ value: `Estimated month: ${currency(totals.forecast)}`, position: 'insideTopRight', fill: '#166534', fontSize: 10 }}
            />
            <Area type="monotone" dataKey="forecast" stroke="#86efac" fill="#dcfce7" strokeWidth={2} />
            <Area type="monotone" dataKey="actual" stroke="#22c55e" fill="#86efac" strokeWidth={2} />
            <ReferenceDot
              x={`Day ${currentDay}`}
              y={totals.actual}
              r={4}
              fill="#16a34a"
              stroke="#14532d"
              label={{
                value: `Used now: ${currency(totals.actual)}`,
                position: 'top',
                fill: '#166534',
                fontSize: 10,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="cost-mgmt-breakdown">
        {totals.breakdown.map((item) => (
          <div key={item.name} className="cost-mgmt-breakdown-item">
            <span>{item.name}</span>
            <strong>{currency(item.value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
