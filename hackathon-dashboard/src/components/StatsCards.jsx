import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AZURE_ICON_FILE_MAP } from './azureIconPaths';

const STATS_ICON_PATHS = {
  totalResources: AZURE_ICON_FILE_MAP.virtualMachine,
  resourceGroups: AZURE_ICON_FILE_MAP.resourceGroup,
  virtualNetworks: AZURE_ICON_FILE_MAP.virtualNetwork,
  computeServices: AZURE_ICON_FILE_MAP.functionApp,
  dataServices: AZURE_ICON_FILE_MAP.storageAccount,
};

function collectStatsAndResources(data) {
  if (!data) {
    return {
      stats: null,
      resources: {
        totalResources: [],
        resourceGroups: [],
        virtualNetworks: [],
        computeServices: [],
        dataServices: [],
        riskFindings: [],
      },
      groupedResources: {
        totalResources: [],
        resourceGroups: [],
        virtualNetworks: [],
        computeServices: [],
        dataServices: [],
        riskFindings: [],
      },
    };
  }

  let totalResources = 0;
  let resourceGroups = 0;
  let virtualNetworks = 0;
  let computeServices = 0;
  let dataServices = 0;
  let riskFindings = 0;

  const resources = {
    totalResources: new Set(),
    resourceGroups: new Set(),
    virtualNetworks: new Set(),
    computeServices: new Set(),
    dataServices: new Set(),
    riskFindings: new Set(),
  };

  const groupedResources = {
    totalResources: {},
    resourceGroups: {},
    virtualNetworks: {},
    computeServices: {},
    dataServices: {},
    riskFindings: {},
  };

  const addMany = (targetSet, values) => {
    values.forEach((value) => {
      if (typeof value === 'string' && value.trim()) {
        targetSet.add(value);
      }
    });
  };

  const addGrouped = (grouped, key, groupName, values) => {
    const validValues = values.filter((value) => typeof value === 'string' && value.trim());
    if (validValues.length === 0) {
      return;
    }

    if (!grouped[key][groupName]) {
      grouped[key][groupName] = new Set();
    }
    validValues.forEach((value) => {
      grouped[key][groupName].add(value);
    });
  };

  const subs = data.data?.subscriptions || {};
  Object.values(subs).forEach(sub => {
    const rgs = sub.resource_groups || {};
    resourceGroups += Object.keys(rgs).length;
    addMany(resources.resourceGroups, Object.keys(rgs));

    Object.entries(rgs).forEach(([rgName, rg]) => {
      totalResources += rg.total_resources || 0;
      const cats = rg.categories || {};

      addGrouped(groupedResources, 'resourceGroups', rgName, [rgName]);

      // Virtual networks
      const vnets = cats.networking?.virtual_networks || {};
      virtualNetworks += Object.keys(vnets).length;
      addMany(resources.virtualNetworks, Object.keys(vnets));
      addGrouped(groupedResources, 'virtualNetworks', rgName, Object.keys(vnets));

      // Compute
      const computeResources = [
        ...(cats.compute?.virtual_machines || []),
        ...(cats.compute?.virtual_machine_scale_sets || []),
        ...(cats.app_services?.function_apps || []),
        ...(cats.app_services?.web_apps || []),
      ];
      computeServices += computeResources.length;
      addMany(resources.computeServices, computeResources);
      addGrouped(groupedResources, 'computeServices', rgName, computeResources);

      // Data
      const dataResources = [
        ...(cats.storage?.storage_accounts || []),
        ...(cats.ai_services?.openai_resources || []),
        ...(cats.ai_services?.cognitive_services || []),
      ];
      dataServices += dataResources.length;
      addMany(resources.dataServices, dataResources);
      addGrouped(groupedResources, 'dataServices', rgName, dataResources);

      const allKnownResources = [
        ...Object.keys(vnets),
        ...(cats.compute?.virtual_machines || []),
        ...(cats.compute?.virtual_machine_scale_sets || []),
        ...(cats.app_services?.function_apps || []),
        ...(cats.app_services?.web_apps || []),
        ...(cats.app_services?.app_service_plans || []),
        ...(cats.app_services?.logic_apps || []),
        ...(cats.storage?.storage_accounts || []),
        ...(cats.ai_services?.openai_resources || []),
        ...(cats.ai_services?.cognitive_services || []),
        ...(cats.security?.keyvaults || []),
        ...(cats.monitoring?.application_insights || []),
        ...(cats.monitoring?.log_analytics_workspaces || []),
        ...(cats.networking?.network_interfaces || []),
        ...(cats.networking?.public_ip_addresses || []),
        ...(cats.networking?.network_security_groups || []),
        ...(cats.identity?.managed_identities || []),
        ...(cats.other_resources || []),
      ];
      addMany(resources.totalResources, allKnownResources);
      addGrouped(groupedResources, 'totalResources', rgName, allKnownResources);

      // Risks: missing security configs
      if ((cats.security?.keyvaults?.length || 0) === 0 && rg.total_resources > 0) {
        riskFindings++;
        const riskText = `${rgName}: Missing Key Vault for active resources`;
        resources.riskFindings.add(riskText);
        addGrouped(groupedResources, 'riskFindings', rgName, [riskText]);
      }
    });
  });

  const normalizeGrouped = (value) => Object.entries(value)
    .map(([group, items]) => ({ group, items: Array.from(items).sort() }))
    .filter(({ items }) => items.length > 0)
    .sort((a, b) => a.group.localeCompare(b.group));

  return {
    stats: { totalResources, resourceGroups, virtualNetworks, computeServices, dataServices, riskFindings },
    resources: {
      totalResources: Array.from(resources.totalResources).sort(),
      resourceGroups: Array.from(resources.resourceGroups).sort(),
      virtualNetworks: Array.from(resources.virtualNetworks).sort(),
      computeServices: Array.from(resources.computeServices).sort(),
      dataServices: Array.from(resources.dataServices).sort(),
      riskFindings: Array.from(resources.riskFindings).sort(),
    },
    groupedResources: {
      totalResources: normalizeGrouped(groupedResources.totalResources),
      resourceGroups: normalizeGrouped(groupedResources.resourceGroups),
      virtualNetworks: normalizeGrouped(groupedResources.virtualNetworks),
      computeServices: normalizeGrouped(groupedResources.computeServices),
      dataServices: normalizeGrouped(groupedResources.dataServices),
      riskFindings: normalizeGrouped(groupedResources.riskFindings),
    },
  };
}

const cardConfig = [
  { key: 'totalResources',  label: 'Total Resources',   iconPath: STATS_ICON_PATHS.totalResources, color: '#dbeafe' },
  { key: 'resourceGroups', label: 'Resource Groups',   iconPath: STATS_ICON_PATHS.resourceGroups, color: '#f0fdf4' },
  { key: 'virtualNetworks',label: 'Virtual Networks',  iconPath: STATS_ICON_PATHS.virtualNetworks, color: '#eff6ff' },
  { key: 'computeServices',label: 'Compute Services',  iconPath: STATS_ICON_PATHS.computeServices, color: '#fdf4ff' },
  { key: 'dataServices',   label: 'Data Services',     iconPath: STATS_ICON_PATHS.dataServices, color: '#fff7ed' },
  { key: 'riskFindings',   label: 'Risk Findings',     LucideIcon: AlertTriangle, color: '#fef2f2', iconColor: '#ef4444' },
];

export default function StatsCards({ data, loading = false }) {
  const { stats, resources, groupedResources } = useMemo(() => collectStatsAndResources(data), [data]);
  const [activeCardKey, setActiveCardKey] = useState(null);

  const activeCard = cardConfig.find((card) => card.key === activeCardKey) || null;
  const activeResources = activeCard ? (resources[activeCard.key] || []) : [];
  const activeGroupedResources = activeCard ? (groupedResources[activeCard.key] || []) : [];

  return (
    <>
      <div className="stats-row">
        {cardConfig.map(({ key, label, iconPath, LucideIcon, color, iconColor, sub }) => (
          <button
            type="button"
            className="stat-card stat-card-btn"
            key={key}
            onClick={() => setActiveCardKey(key)}
          >
            <div className="stat-icon" style={{ background: color }}>
              {iconPath ? (
                <img
                  src={iconPath}
                  alt=""
                  aria-hidden="true"
                  style={{ width: 20, height: 20, objectFit: 'contain' }}
                />
              ) : (
                <LucideIcon size={18} color={iconColor} />
              )}
            </div>
            <div className="stat-info">
              <h3>{label}</h3>
              <div className="stat-value">{stats ? stats[key] : '—'}</div>
              {sub && <div className="stat-sub">{sub}</div>}
            </div>
          </button>
        ))}
      </div>

      {activeCard && (
        <div className="stats-modal-backdrop" onClick={() => setActiveCardKey(null)}>
          <div className="stats-modal" onClick={(event) => event.stopPropagation()}>
            <div className="stats-modal-header">
              <h3>{activeCard.label}</h3>
              <button
                type="button"
                className="stats-modal-close"
                onClick={() => setActiveCardKey(null)}
                aria-label="Close resources list"
              >
                ×
              </button>
            </div>
            <div className="stats-modal-subtitle">
              {activeResources.length} item(s)
            </div>
            <div className="stats-modal-body">
              {loading ? (
                <div className="stats-modal-loading" role="status" aria-live="polite">
                  <span className="spinner spinner-lg spinner-ring" aria-hidden="true" />
                  <span>Loading resources...</span>
                </div>
              ) : activeResources.length === 0 ? (
                <div className="stats-modal-empty">No resources found for this card.</div>
              ) : activeCard.key === 'resourceGroups' ? (
                <ul className="stats-resource-list">
                  {activeResources.map((resourceName) => (
                    <li key={resourceName}>{resourceName}</li>
                  ))}
                </ul>
              ) : (
                <div className="stats-resource-groups">
                  {activeGroupedResources.map(({ group, items }) => (
                    <div className="stats-resource-group" key={group}>
                      <div className="stats-resource-group-title">{group}</div>
                      <ul className="stats-resource-list">
                        {items.map((resourceName) => (
                          <li key={resourceName}>{resourceName}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
