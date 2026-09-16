import React, { useMemo, useState } from 'react';
import { PiggyBank, TrendingDown, CheckCircle } from 'lucide-react';

// Build a lookup of { resourceGroupName -> actualMonthlyCost } from apiCostAnalysis dimensions
function buildRgCostMap(costData) {
  const map = {};
  if (!costData) return map;
  const dimensions = Array.isArray(costData.dimensions) ? costData.dimensions : [];
  const rgDim = dimensions.find((d) => /resource.?group/i.test(String(d.key || d.dimensionKey || '')));
  const rows = Array.isArray(rgDim?.data) ? rgDim.data : [];
  rows.forEach((row) => {
    const name = String(row.name || '').trim();
    const value = Number(row.value || 0);
    if (name) map[name.toLowerCase()] = value;
  });
  return map;
}

// Build a lookup of { resourceName -> actualMonthlyCost } from apiCostAnalysis dimensions
function buildResourceCostMap(costData) {
  const map = {};
  if (!costData) return map;
  const dimensions = Array.isArray(costData.dimensions) ? costData.dimensions : [];
  const resDim = dimensions.find((d) => {
    const k = String(d.key || d.dimensionKey || '').toLowerCase();
    return k === 'resource' || k === 'resourcename';
  });
  const rows = Array.isArray(resDim?.data) ? resDim.data : [];
  rows.forEach((row) => {
    const name = String(row.name || '').trim();
    const value = Number(row.value || 0);
    if (name) map[name.toLowerCase()] = value;
  });
  return map;
}

function deriveCostRecommendations(data, costData) {
  const recommendations = [];

  if (!data) return [];

  const rgCostMap = buildRgCostMap(costData);
  const resourceCostMap = buildResourceCostMap(costData);

  // Helper: get actual RG spend or 0
  const getRgCost = (rgName) => rgCostMap[String(rgName || '').toLowerCase()] || 0;

  // Helper: sum cost for a list of resource objects (each has .name)
  const sumResourceCost = (resources) =>
    resources.reduce((sum, r) => {
      const key = String(r?.name || r || '').toLowerCase();
      return sum + (resourceCostMap[key] || 0);
    }, 0);

  const subs = data.data?.subscriptions || {};

  Object.entries(subs).forEach(([subId, sub]) => {
    Object.entries(sub?.resource_groups || {}).forEach(([rgName, rg]) => {
      const cats = rg?.categories || {};
      const vms = cats.compute?.virtual_machines || [];
      const vmss = cats.compute?.virtual_machine_scale_sets || [];
      const storages = cats.storage?.storage_accounts || [];
      const webApps = cats.app_services?.web_apps || [];
      const plans = cats.app_services?.app_service_plans || [];
      const logs = cats.monitoring?.log_analytics_workspaces || [];
      const ips = cats.networking?.public_ip_addresses || [];

      const rgActualCost = getRgCost(rgName);

      if (vms.length + vmss.length > 0) {
        const computeCount = vms.length + vmss.length;
        // Use actual compute resource costs if available, otherwise 30% of RG spend
        const computeCost = sumResourceCost([...vms, ...vmss]);
        const baseCost = computeCost > 0 ? computeCost : rgActualCost * 0.6;
        const savings = baseCost > 0 ? Math.round(baseCost * 0.28) : computeCount * 52;
        recommendations.push({
          title: `Right-size compute in ${rgName}`,
          detail: `${computeCount} compute resource(s) found in ${subId}. Consider smaller SKUs or schedule-based shutdown.`,
          impact: 'High',
          fromState: `${computeCount} VM/VMSS instance(s) running at current SKU and runtime schedule${rgActualCost > 0 ? ` (RG spend: $${Math.round(rgActualCost)}/mo)` : ''}`,
          toState: 'Rightsized VM/VMSS + auto-shutdown policy on non-critical windows',
          benefit: 'Reduces baseline compute spend while keeping performance aligned to workload demand.',
          estimatedSavingsMonthly: savings,
        });
      }

      if (storages.length > 0) {
        const storageCount = storages.length;
        const storageCost = sumResourceCost(storages);
        const baseCost = storageCost > 0 ? storageCost : rgActualCost * 0.2;
        const savings = baseCost > 0 ? Math.round(baseCost * 0.35) : storageCount * 38;
        recommendations.push({
          title: `Optimize storage tiers in ${rgName}`,
          detail: `${storageCount} storage account(s) detected. Enable lifecycle rules and cool/archive tiers for inactive data.`,
          impact: 'Medium',
          fromState: `${storageCount} storage account(s) with general/default tiering${storageCost > 0 ? ` (cost: $${Math.round(storageCost)}/mo)` : ''}`,
          toState: 'Lifecycle rules with hot/cool/archive transitions and snapshot expiry',
          benefit: 'Lowers storage unit price for inactive data and removes stale backups.',
          estimatedSavingsMonthly: savings,
        });
      }

      if (webApps.length > 1 && plans.length > 1) {
        const reduciblePlans = plans.length - 1;
        const planCost = sumResourceCost(plans);
        const baseCost = planCost > 0 ? planCost : rgActualCost * 0.25;
        const savings = baseCost > 0 ? Math.round(baseCost * 0.4) : reduciblePlans * 48;
        recommendations.push({
          title: `Consolidate App Service Plans in ${rgName}`,
          detail: `${webApps.length} web app(s) are spread across ${plans.length} plans. Consolidate same-region apps into one shared plan where sizing allows.`,
          impact: 'Medium',
          fromState: `${plans.length} app service plan(s) for ${webApps.length} web app(s)${planCost > 0 ? ` (plan cost: $${Math.round(planCost)}/mo)` : ''}`,
          toState: 'Single shared App Service Plan for same-region web apps, with autoscale and right-sized SKU',
          benefit: 'Removes duplicate baseline plan charges and improves plan utilization.',
          estimatedSavingsMonthly: savings,
        });
      }

      if (logs.length > 0) {
        const logCount = logs.length;
        const logCost = sumResourceCost(logs);
        const baseCost = logCost > 0 ? logCost : rgActualCost * 0.1;
        const savings = baseCost > 0 ? Math.round(baseCost * 0.4) : logCount * 22;
        recommendations.push({
          title: `Reduce monitoring spend in ${rgName}`,
          detail: `${logCount} Log Analytics workspace(s) found. Tune retention and data collection rules.`,
          impact: 'Low',
          fromState: `${logCount} workspace(s) with default retention and broad telemetry capture${logCost > 0 ? ` (cost: $${Math.round(logCost)}/mo)` : ''}`,
          toState: 'Targeted data collection rules and retention tuned per compliance class',
          benefit: 'Cuts ingestion/storage cost while preserving critical observability signals.',
          estimatedSavingsMonthly: savings,
        });
      }

      if (ips.length > 0) {
        const ipCount = ips.length;
        const ipCost = sumResourceCost(ips);
        const savings = ipCost > 0 ? Math.round(ipCost * 0.5) : ipCount * 14;
        recommendations.push({
          title: `Review public IP allocation in ${rgName}`,
          detail: `${ipCount} public IP address(es) detected. Remove unattached IPs to prevent unnecessary charges.`,
          impact: 'Low',
          fromState: `${ipCount} public IP(s) allocated regardless of attachment state${ipCost > 0 ? ` (cost: $${Math.round(ipCost)}/mo)` : ''}`,
          toState: 'Keep only attached/needed public IPs and release idle addresses',
          benefit: 'Eliminates avoidable network allocation charges.',
          estimatedSavingsMonthly: savings,
        });
      }
    });
  });

  const dedup = new Set();
  return recommendations
    .filter((row) => {
      const key = `${row.title}|${row.detail}`;
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    })
    .slice(0, 12);
}

export default function CostOptimizationRecommendations({ data, apiRecommendations = null, costData = null }) {
  const [selectedRecommendation, setSelectedRecommendation] = useState(null);
  const rows = useMemo(() => {
    if (Array.isArray(apiRecommendations) && apiRecommendations.length) {
      return apiRecommendations;
    }
    return deriveCostRecommendations(data, costData);
  }, [apiRecommendations, data, costData]);

  const formatCurrency = (value) => `$${Math.max(0, Math.round(value)).toLocaleString()}`;

  const getImpactColor = (impact) => {
    const level = String(impact || '').toLowerCase();
    if (level === 'critical' || level === 'high') return '#dc2626';
    if (level === 'medium') return '#d97706';
    return '#0284c7';
  };

  const getImpactIcon = (impact) => {
    const level = String(impact || '').toLowerCase();
    if (level === 'critical' || level === 'high') return '⚠️';
    if (level === 'medium') return '⚡';
    return 'ℹ️';
  };

  return (
    <>
      <div className="bottom-panel cost-rec-panel">
        <div className="panel-header">
          <h3>
            <PiggyBank size={16} style={{ marginRight: '8px', display: 'inline' }} />
            Cost Optimization Recommendations
          </h3>
          {rows.length > 0 && (
            <span style={{ 
              marginLeft: 'auto', 
              fontSize: '12px', 
              color: '#6b7280',
              backgroundColor: '#f3f4f6',
              padding: '4px 12px',
              borderRadius: '12px'
            }}>
              {rows.length} recommendation{rows.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="bottom-panel-body cost-rec-body">
          {rows.length === 0 ? (
            <div className="cost-rec-empty">No recommendations available yet. Run Discover first.</div>
          ) : (
            rows.map((row, index) => (
              <button
                type="button"
                className="cost-rec-item cost-rec-btn"
                key={`${row.title}-${index}`}
                onClick={() => setSelectedRecommendation(row)}
              >
                <div className="cost-rec-icon" style={{ 
                  background: String(row.impact || '').toLowerCase() === 'high' ? '#fee2e2' : 
                               String(row.impact || '').toLowerCase() === 'medium' ? '#fef3c7' : '#e0f2fe',
                }}>
                  <PiggyBank size={14} style={{ color: getImpactColor(row.impact) }} />
                </div>
                <div className="cost-rec-content">
                  <div className="cost-rec-title">{row.title}</div>
                  <div className="cost-rec-detail">{row.detail}</div>
                  <div className="cost-rec-savings-inline">
                    💰 Estimated savings: <strong>{formatCurrency(row.estimatedSavingsMonthly)}</strong> / month
                  </div>
                </div>
                <span className={`cost-impact-badge ${String(row.impact || '').toLowerCase()}`}>
                  {getImpactIcon(row.impact)} {row.impact}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {selectedRecommendation && (
        <div className="cost-rec-modal-backdrop" onClick={() => setSelectedRecommendation(null)}>
          <div className="cost-rec-modal" onClick={(event) => event.stopPropagation()}>
            <div className="cost-rec-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                <TrendingDown size={20} style={{ color: '#047857' }} />
                <h3>{selectedRecommendation.title}</h3>
              </div>
              <button
                type="button"
                className="cost-rec-modal-close"
                onClick={() => setSelectedRecommendation(null)}
                aria-label="Close recommendation details"
              >
                ×
              </button>
            </div>

            <div className="cost-rec-modal-body">
              <div className="cost-rec-detail-row">
                <span className="cost-rec-detail-label">📋 Summary</span>
                <div className="cost-rec-detail-value">{selectedRecommendation.detail}</div>
              </div>

              {selectedRecommendation.impact && (
                <div className="cost-rec-detail-row" style={{
                  borderColor: getImpactColor(selectedRecommendation.impact),
                  background: String(selectedRecommendation.impact || '').toLowerCase() === 'high' ? '#fee2e2' : 
                               String(selectedRecommendation.impact || '').toLowerCase() === 'medium' ? '#fef3c7' : '#e0f2fe'
                }}>
                  <span className="cost-rec-detail-label">⚡ Impact Level</span>
                  <div className="cost-rec-detail-value" style={{ color: getImpactColor(selectedRecommendation.impact), fontWeight: 600 }}>
                    {getImpactIcon(selectedRecommendation.impact)} {selectedRecommendation.impact}
                  </div>
                </div>
              )}

              <div className="cost-rec-detail-row">
                <span className="cost-rec-detail-label">🔄 Current State</span>
                <div className="cost-rec-detail-value">{selectedRecommendation.fromState || 'Not specified'}</div>
              </div>

              <div className="cost-rec-detail-row">
                <span className="cost-rec-detail-label">✅ Target State</span>
                <div className="cost-rec-detail-value">{selectedRecommendation.toState || 'Not specified'}</div>
              </div>

              {selectedRecommendation.benefit && (
                <div className="cost-rec-detail-row">
                  <span className="cost-rec-detail-label">💡 Benefit</span>
                  <div className="cost-rec-detail-value">{selectedRecommendation.benefit}</div>
                </div>
              )}

              <div className="cost-rec-savings-card">
                <div className="cost-rec-savings-title">💰 Estimated Cost Reduction</div>
                <div className="cost-rec-savings-value">
                  {formatCurrency(selectedRecommendation.estimatedSavingsMonthly)}
                </div>
                <div className="cost-rec-savings-subvalue">
                  per month | {formatCurrency(selectedRecommendation.estimatedSavingsMonthly * 12)} per year
                </div>
              </div>

              <div style={{
                padding: '12px',
                background: '#f0fdf4',
                border: '1px solid #86efac',
                borderRadius: '10px',
                fontSize: '12px',
                color: '#166534',
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start'
              }}>
                <CheckCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>Implementing this recommendation can help optimize your cloud spend while maintaining performance and reliability.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
