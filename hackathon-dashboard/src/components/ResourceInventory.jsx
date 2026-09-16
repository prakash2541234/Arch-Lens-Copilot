import React, { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const CATEGORY_COLORS = {
  Compute: '#3b82f6',
  Networking: '#8b5cf6',
  Storage: '#10b981',
  Data: '#f59e0b',
  Security: '#ef4444',
  Integration: '#06b6d4',
  Monitoring: '#ec4899',
  Others: '#94a3b8',
};

const COST_COLORS = {
  'VM Cost': '#3b82f6',
  'Storage Cost': '#10b981',
  'Function Apps Cost': '#f59e0b',
  'Key Vaults Cost': '#ef4444',
  'Networking Cost': '#8b5cf6',
  'Others Cost': '#94a3b8',
};

function getRowColor(name, isCost) {
  return isCost ? (COST_COLORS[name] || '#94a3b8') : (CATEGORY_COLORS[name] || '#94a3b8');
}

function computeInventory(data) {
  if (!data) return [];

  const totals = {
    Compute: 0, Networking: 0, Storage: 0, Data: 0,
    Security: 0, Integration: 0, Monitoring: 0, Others: 0,
  };

  const subs = data.data?.subscriptions || {};
  Object.values(subs).forEach(sub => {
    Object.values(sub.resource_groups || {}).forEach(rg => {
      const cats = rg.categories || {};
      totals.Compute += (cats.compute?.virtual_machines?.length || 0)
        + (cats.compute?.virtual_machine_scale_sets?.length || 0)
        + (cats.app_services?.function_apps?.length || 0)
        + (cats.app_services?.web_apps?.length || 0)
        + (cats.app_services?.app_service_plans?.length || 0);
      totals.Networking += (cats.networking?.network_security_groups?.length || 0)
        + Object.keys(cats.networking?.virtual_networks || {}).length
        + (cats.networking?.public_ip_addresses?.length || 0)
        + (cats.networking?.network_interfaces?.length || 0);
      totals.Storage += (cats.storage?.storage_accounts?.length || 0);
      totals.Data += (cats.ai_services?.openai_resources?.length || 0)
        + (cats.ai_services?.cognitive_services?.length || 0);
      totals.Security += (cats.security?.keyvaults?.length || 0);
      totals.Integration += (cats.app_services?.logic_apps?.length || 0);
      totals.Monitoring += (cats.monitoring?.application_insights?.length || 0)
        + (cats.monitoring?.log_analytics_workspaces?.length || 0);
      totals.Others += (cats.identity?.managed_identities?.length || 0)
        + (cats.other_resources?.length || 0);
    });
  });

  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  return Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({
      name,
      value,
      pct: total > 0 ? Math.round((value / total) * 100) : 0,
    }));
}

function computeCostAnalysis(data) {
  if (!data) return [];

  let vmCount = 0;
  let storageCount = 0;
  let functionAppCount = 0;
  let keyVaultCount = 0;
  let networkCount = 0;
  let othersCount = 0;

  const subs = data.data?.subscriptions || {};
  Object.values(subs).forEach((sub) => {
    Object.values(sub.resource_groups || {}).forEach((rg) => {
      const cats = rg.categories || {};
      vmCount += (cats.compute?.virtual_machines?.length || 0)
        + (cats.compute?.virtual_machine_scale_sets?.length || 0);
      storageCount += (cats.storage?.storage_accounts?.length || 0);
      functionAppCount += (cats.app_services?.function_apps?.length || 0);
      keyVaultCount += (cats.security?.keyvaults?.length || 0);
      networkCount += (cats.networking?.network_interfaces?.length || 0)
        + (cats.networking?.public_ip_addresses?.length || 0)
        + (cats.networking?.network_security_groups?.length || 0);
      othersCount += (cats.app_services?.web_apps?.length || 0)
        + (cats.app_services?.app_service_plans?.length || 0)
        + (cats.app_services?.logic_apps?.length || 0)
        + (cats.monitoring?.application_insights?.length || 0)
        + (cats.monitoring?.log_analytics_workspaces?.length || 0)
        + (cats.ai_services?.openai_resources?.length || 0)
        + (cats.ai_services?.cognitive_services?.length || 0)
        + (cats.identity?.managed_identities?.length || 0)
        + Object.keys(cats.networking?.virtual_networks || {}).length
        + Object.values(cats.networking?.virtual_networks || {}).reduce(
          (sum, vnet) => sum + ((vnet?.subnets || []).length || 0),
          0,
        )
        + (cats.other_resources?.length || 0);
    });
  });

  const estimatedTotals = {
    'VM Cost': vmCount * 52,
    'Storage Cost': storageCount * 38,
    'Function Apps Cost': functionAppCount * 24,
    'Key Vaults Cost': keyVaultCount * 18,
    'Networking Cost': networkCount * 14,
    'Others Cost': othersCount * 20,
  };

  const hasData = Object.values(estimatedTotals).some((value) => value > 0);
  const totals = hasData ? estimatedTotals : {};
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);

  return Object.entries(totals).map(([name, value]) => ({
    name,
    value,
    pct: total > 0 ? Math.round((value / total) * 100) : 0,
  }));
}

function collectOtherUtilizedResources(data) {
  if (!data) return [];

  const resources = new Set();
  const subs = data.data?.subscriptions || {};

  Object.values(subs).forEach((sub) => {
    Object.values(sub.resource_groups || {}).forEach((rg) => {
      const cats = rg.categories || {};

      const addMany = (items) => {
        (items || []).forEach((item) => {
          if (typeof item === 'string' && item.trim()) resources.add(item.trim());
        });
      };

      addMany(cats.app_services?.web_apps);
      addMany(cats.app_services?.app_service_plans);
      addMany(cats.app_services?.logic_apps);
      addMany(cats.monitoring?.application_insights);
      addMany(cats.monitoring?.log_analytics_workspaces);
      addMany(cats.ai_services?.openai_resources);
      addMany(cats.ai_services?.cognitive_services);
      addMany(cats.identity?.managed_identities);
      addMany(cats.other_resources);

      Object.entries(cats.networking?.virtual_networks || {}).forEach(([vnetName, vnet]) => {
        if (vnetName?.trim()) resources.add(vnetName.trim());
        addMany(vnet?.subnets);
      });
    });
  });

  return Array.from(resources).sort((a, b) => a.localeCompare(b));
}

function ChartBlock({ title, data, totalLabel, isCost }) {
  const total = data.reduce((sum, row) => sum + row.value, 0);
  const formatValue = (value) => (isCost ? `$${value}` : `${value}`);

  return (
    <div className="bottom-panel">
      <div className="panel-header">
        <h3>{title}</h3>
      </div>
      <div className="inventory-body">
        <div style={{ width: 110, height: 110, position: 'relative', flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.length ? data : [{ name: 'empty', value: 1 }]}
                cx="50%"
                cy="50%"
                innerRadius={32}
                outerRadius={50}
                paddingAngle={2}
                dataKey="value"
              >
                {data.map((entry) => (
                  <Cell key={entry.name} fill={getRowColor(entry.name, isCost)} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [isCost ? `$${v}` : v, n]} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none'
          }}>
            <div className="inventory-total" style={{ fontSize: 16, fontWeight: 800 }}>{formatValue(total)}</div>
            <div style={{ fontSize: 9, color: '#9ca3af' }}>{totalLabel}</div>
          </div>
        </div>

        <div className="inventory-legend">
          {data.map(({ name, value, pct }) => (
            <div
              className={`legend-item ${isCost ? 'cost-legend-item' : ''}`}
              style={isCost ? { '--cost-accent': getRowColor(name, true) } : undefined}
              key={name}
            >
              <div className="legend-dot" style={{ background: getRowColor(name, isCost) }} />
              <span>{name}</span>
              <span className="legend-count">{formatValue(value)} ({pct}%)</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ResourceInventory({
  data,
  onViewAll,
  showBoth = false,
  forcedView,
  hideSwitcher = false,
  hideViewAll = false,
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOthersModalOpen, setIsOthersModalOpen] = useState(false);
  const inventory = useMemo(() => computeInventory(data), [data]);
  const costAnalysis = useMemo(() => computeCostAnalysis(data), [data]);
  const otherUtilizedResources = useMemo(() => collectOtherUtilizedResources(data), [data]);

  const views = [
    {
      key: 'inventory',
      title: 'Resource Inventory',
      rows: inventory,
      totalLabel: 'Total',
      isCost: false,
    },
    {
      key: 'cost-analysis',
      title: 'Cost Analysis',
      rows: costAnalysis,
      totalLabel: 'Monthly USD',
      isCost: true,
    },
  ];

  const forcedViewIndex = forcedView ? views.findIndex((view) => view.key === forcedView) : -1;
  const resolvedIndex = forcedViewIndex >= 0 ? forcedViewIndex : activeIndex;
  const activeView = views[resolvedIndex];

  if (showBoth) {
    return (
      <div className="reports-two-halves">
        {views.map((view) => (
          <ChartBlock
            key={view.key}
            title={view.title}
            data={view.rows}
            totalLabel={view.totalLabel}
            isCost={view.isCost}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="bottom-panel">
        <div className="panel-header">
          <h3>{activeView.title}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!hideViewAll && (
              <button
                type="button"
                className="stat-link"
                style={{ fontSize: 11, background: 'none', border: 'none' }}
                onClick={onViewAll}
              >
                View all
              </button>
            )}
          </div>
        </div>
        <div className="inventory-body">
        <div style={{ width: 110, height: 110, position: 'relative', flexShrink: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={activeView.rows.length ? activeView.rows : [{ name: 'empty', value: 1 }]}
                cx="50%"
                cy="50%"
                innerRadius={32}
                outerRadius={50}
                paddingAngle={2}
                dataKey="value"
              >
                {activeView.rows.map((entry) => (
                  <Cell key={entry.name} fill={getRowColor(entry.name, activeView.isCost)} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [activeView.isCost ? `$${v}` : v, n]} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center', pointerEvents: 'none'
          }}>
            <div className="inventory-total" style={{ fontSize: 16, fontWeight: 800 }}>
              {activeView.isCost
                ? `$${activeView.rows.reduce((sum, row) => sum + row.value, 0)}`
                : activeView.rows.reduce((sum, row) => sum + row.value, 0)}
            </div>
            <div style={{ fontSize: 9, color: '#9ca3af' }}>{activeView.totalLabel}</div>
          </div>
        </div>

          <div className="inventory-legend">
            {activeView.rows.map(({ name, value, pct }) => (
              <div
                className={`legend-item ${activeView.isCost ? 'cost-legend-item' : ''}`}
                style={activeView.isCost ? { '--cost-accent': getRowColor(name, true) } : undefined}
                key={name}
              >
                <div className="legend-dot" style={{ background: getRowColor(name, activeView.isCost) }} />
                <span>{name}</span>
                <span className="legend-count">{activeView.isCost ? `$${value}` : value} ({pct}%)</span>
              </div>
            ))}
          </div>
        </div>
        {!hideSwitcher && forcedViewIndex < 0 && (
          <div className="inventory-switch">
            <button
              type="button"
              className="inventory-switch-btn"
              onClick={() => setActiveIndex((prev) => (prev - 1 + views.length) % views.length)}
            >
              {'<'}
            </button>
            <div className="inventory-switch-state">{activeIndex + 1} / {views.length}</div>
            <button
              type="button"
              className="inventory-switch-btn"
              onClick={() => setActiveIndex((prev) => (prev + 1) % views.length)}
            >
              {'>'}
            </button>
          </div>
        )}
      </div>

      {isOthersModalOpen && (
        <div className="stats-modal-backdrop" onClick={() => setIsOthersModalOpen(false)}>
          <div className="stats-modal" onClick={(event) => event.stopPropagation()}>
            <div className="stats-modal-header">
              <h3>Other Utilized Resources</h3>
              <button
                type="button"
                className="stats-modal-close"
                onClick={() => setIsOthersModalOpen(false)}
                aria-label="Close others resources list"
              >
                ×
              </button>
            </div>
            <div className="stats-modal-subtitle">
              {otherUtilizedResources.length} item(s)
            </div>
            <div className="stats-modal-body">
              {otherUtilizedResources.length === 0 ? (
                <div className="stats-modal-empty">No other utilized resources found.</div>
              ) : (
                <ul className="stats-resource-list">
                  {otherUtilizedResources.map((resourceName) => (
                    <li key={resourceName}>{resourceName}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
