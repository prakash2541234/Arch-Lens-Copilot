import React, { useMemo, useState } from 'react';

function normalizePillar(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSeverity(value = 'medium') {
  const normalized = String(value || 'medium').trim().toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) return normalized;
  return 'medium';
}

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeRecommendationText(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const compact = raw.replace(/\s+/g, ' ').trim();
  const duplicateDashPattern = /^(.+?)\s*[-–—]\s*\1$/i;
  const duplicateDashMatch = compact.match(duplicateDashPattern);
  if (duplicateDashMatch?.[1]) {
    return duplicateDashMatch[1].trim();
  }

  return compact;
}

function normalizeSubscriptionScopeId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const armMatch = raw.match(/\/subscriptions\/([^/\s]+)/i);
  if (armMatch?.[1]) return armMatch[1].toLowerCase();
  return raw.toLowerCase();
}

function parseResourceCounts(item, resourceName = '') {
  const rawActive = item?.activeResources
    ?? item?.active_resources
    ?? item?.resourceCount
    ?? item?.resource_count
    ?? item?.activeResourcesText
    ?? item?.active_resources_text;

  const rawTotal = item?.totalResources
    ?? item?.total_resources
    ?? item?.totalResourceCount
    ?? item?.total_resource_count;

  const parseNumber = (value) => {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber);
    const match = String(value || '').match(/(\d+)/);
    return match ? Number(match[1]) : NaN;
  };

  const activeText = String(rawActive || '').trim();
  const ofMatch = activeText.match(/(\d+)\s*of\s*(\d+)/i);
  if (ofMatch) {
    return {
      activeResources: Number(ofMatch[1]),
      totalResources: Number(ofMatch[2]),
    };
  }

  const activeParsed = parseNumber(rawActive);
  const totalParsed = parseNumber(rawTotal);

  const activeResources = Number.isFinite(activeParsed) && activeParsed > 0
    ? activeParsed
    : (resourceName ? 1 : 0);

  const totalResources = Number.isFinite(totalParsed) && totalParsed > 0
    ? totalParsed
    : 0;

  return { activeResources, totalResources };
}

const ADVISOR_FILTERS = [
  { id: 'cost', label: 'Cost' },
  { id: 'security', label: 'Security' },
  { id: 'reliability', label: 'Reliability' },
  { id: 'operational', label: 'Operational Excellence' },
  { id: 'performance', label: 'Performance' },
  { id: 'all', label: 'All recomandations' },
];

const FILTER_PILLAR_MAP = {
  cost: ['cost optimization', 'cost'],
  security: ['security'],
  reliability: ['reliability'],
  operational: ['operational excellence', 'operational'],
  performance: ['performance efficiency', 'performance'],
};

const FILTER_KEYWORDS = {
  cost: /(cost|saving|savings|rightsiz|reserved|unused|idle|orphan|waste)/i,
  security: /(security|identity|auth|authentication|defender|nsg|private[ -]?endpoint|firewall|encryption|internet[ -]?exposed|shared[ -]?key|private[ -]?link|key[ -]?access|local[ -]?auth|certificate|tls|ssl|network[ -]?access|network[ -]?rule|virtual[ -]?network|ingestion|trusted|diagnostic|https|public[ -]?access|managed[ -]?identity|function[ -]?app|web[ -]?app|cognitive|foundry)/i,
  reliability: /(reliability|availability|resilien|backup|restore|redundan|disaster|dr)/i,
  operational: /(operational|monitor|alert|diagnostic|governance|policy|observability)/i,
  performance: /(performance|latency|throughput|efficiency|scale|optimi[sz]e)/i,
};

const FILTER_SCORE_LABEL_MAP = {
  all: 'Well-Architected Score',
  cost: 'Cost Score',
  security: 'Security Score',
  reliability: 'Reliability Score',
  operational: 'Operational Excellence Score',
  performance: 'Performance Score',
};

const SCORE_KEYS = {
  overall: ['overall', 'overallScore', 'overall_score'],
  cost: ['costOptimization', 'cost_optimization', 'cost'],
  security: ['security'],
  reliability: ['reliability'],
  operational: ['operationalExcellence', 'operational_excellence', 'operational'],
  performance: ['performanceEfficiency', 'performance_efficiency', 'performance'],
};

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function readFirstScoreValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const num = Number(obj[key]);
      if (Number.isFinite(num)) return num;
    }
  }
  return undefined;
}

function extractAdvisorScores(data, apiScoreSummary) {
  const candidates = [
    apiScoreSummary,
    data?.scoreSummary,
    data?.well_architected,
    data?.wellArchitected,
    data?.well_architected_score,
    data?.wellArchitectedScore,
    data?.data?.well_architected,
    data?.data?.wellArchitected,
    data?.data?.well_architected_score,
    data?.data?.wellArchitectedScore,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const cost = readFirstScoreValue(candidate, SCORE_KEYS.cost);
    const security = readFirstScoreValue(candidate, SCORE_KEYS.security);
    const reliability = readFirstScoreValue(candidate, SCORE_KEYS.reliability);
    const operational = readFirstScoreValue(candidate, SCORE_KEYS.operational);
    const performance = readFirstScoreValue(candidate, SCORE_KEYS.performance);

    if ([cost, security, reliability, operational, performance].some((v) => Number.isFinite(v))) {
      const computedOverall = clampScore(
        [cost, security, reliability, operational, performance]
          .map((v) => (Number.isFinite(v) ? Number(v) : 0))
          .reduce((sum, val) => sum + val, 0) / 5
      );
      const overall = readFirstScoreValue(candidate, SCORE_KEYS.overall);

      return {
        all: Number.isFinite(overall) ? clampScore(overall) : computedOverall,
        cost: clampScore(cost),
        security: clampScore(security),
        reliability: clampScore(reliability),
        operational: clampScore(operational),
        performance: clampScore(performance),
      };
    }
  }

  return {
    all: 0,
    cost: 0,
    security: 0,
    reliability: 0,
    operational: 0,
    performance: 0,
  };
}

function normalizeRecommendations(source) {
  const rows = Array.isArray(source)
    ? source
    : Array.isArray(source?.recommendations)
      ? source.recommendations
      : Array.isArray(source?.findings)
        ? source.findings
        : Array.isArray(source?.risks)
          ? source.risks
          : [];

  return rows
    .map((item) => {
      const recommendation = normalizeRecommendationText(String(
        item?.recommendation
        || item?.issue
        || item?.title
        || item?.finding
        || item?.text
        || ''
      ));

      const severity = normalizeSeverity(item?.severity || item?.impact || 'medium');
      const resourceType = String(item?.resourceType || item?.resource_type || item?.targetType || 'Resources').trim() || 'Resources';
      const resourceName = String(item?.resource || item?.resourceName || item?.target || '').trim();
      const subscriptionId = String(
        item?.subscriptionId
        || item?.subscription_id
        || item?.subscription
        || ''
      ).trim();
      const resourceGroup = String(
        item?.resourceGroup
        || item?.resource_group
        || item?.resourceGroupName
        || ''
      ).trim();
      const { activeResources, totalResources } = parseResourceCounts(item, resourceName);

      const impactedPillars = Array.isArray(item?.impactedPillars)
        ? item.impactedPillars.map((pillar) => normalizePillar(pillar)).filter(Boolean)
        : item?.pillar
          ? [normalizePillar(item.pillar)]
          : [];
      const category = String(item?.category || item?.advisorCategory || '').trim().toLowerCase();
      const resourceGroups = Array.isArray(item?.resourceGroups)
        ? item.resourceGroups.filter(Boolean).map((value) => String(value).trim())
        : (resourceGroup ? [resourceGroup] : []);
      const subscriptionIds = Array.isArray(item?.subscriptionIds)
        ? item.subscriptionIds.filter(Boolean).map((value) => String(value).trim())
        : (subscriptionId ? [subscriptionId] : []);
      const scopes = resourceGroups.length > 0 ? resourceGroups : subscriptionIds;

      if (!recommendation) return null;

      return {
        recommendation,
        severity,
        category,
        resourceType,
        activeResources,
        totalResources,
        resourceName,
        subscriptionId,
        subscriptionIds,
        resourceGroup,
        resourceGroups,
        scopes,
        impactedPillars,
      };
    })
    .filter(Boolean);
}

function groupRecommendations(normalized) {
  const grouped = new Map();

  normalized.forEach((row) => {
    const key = [
      normalizeKey(row.recommendation),
      row.severity,
      normalizeKey(row.category || ''),
    ].join('|');

    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...row,
        activeResources: row.activeResources || 0,
        totalResources: row.totalResources || 0,
        occurrenceCount: 1,
        resourceNames: new Set(row.resourceName ? [row.resourceName] : []),
        resourceGroups: new Set(row.resourceGroups || []),
        subscriptionIds: new Set(row.subscriptionIds || []),
        resourceTypes: new Set(row.resourceType ? [row.resourceType] : []),
      });
      return;
    }

    existing.activeResources += row.activeResources || 0;
    existing.totalResources = Math.max(existing.totalResources || 0, row.totalResources || 0);
    existing.occurrenceCount = (existing.occurrenceCount || 0) + 1;

    if (row.resourceName) {
      existing.resourceNames.add(row.resourceName);
    }
    (row.resourceGroups || []).forEach((value) => existing.resourceGroups.add(value));
    (row.subscriptionIds || []).forEach((value) => existing.subscriptionIds.add(value));
    if (row.resourceType) {
      existing.resourceTypes.add(row.resourceType);
    }
  });

  return Array.from(grouped.values()).map((row) => {
    const resourceNames = Array.from(row.resourceNames || []);
    const resourceGroups = Array.from(row.resourceGroups || []);
    const subscriptionIds = Array.from(row.subscriptionIds || []);
    const resourceTypes = Array.from(row.resourceTypes || []).filter(Boolean);
    const uniqueResourceCount = resourceNames.length;
    const activeResources = Math.max(row.activeResources || 0, uniqueResourceCount || 0, row.occurrenceCount || 0);
    const totalResources = Math.max(row.totalResources || 0, activeResources);
    const scopes = resourceGroups.length > 0 ? resourceGroups : subscriptionIds;
    const resourceType = resourceTypes.length === 1 ? resourceTypes[0] : 'Resources';

    return {
      ...row,
      resourceType,
      activeResources,
      totalResources,
      resourceName: resourceNames[0] || row.resourceName || '',
      resourceNames,
      resourceTypes,
      resourceGroups,
      subscriptionIds,
      scopes,
    };
  });
}

function collectResourceNames(node, names) {
  if (Array.isArray(node)) {
    node.forEach((item) => collectResourceNames(item, names));
    return;
  }

  if (!node || typeof node !== 'object') return;

  Object.values(node).forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (typeof entry === 'string' && entry.trim()) {
          names.push(entry.trim());
        } else if (entry && typeof entry === 'object') {
          collectResourceNames(entry, names);
        }
      });
      return;
    }

    if (value && typeof value === 'object') {
      collectResourceNames(value, names);
    }
  });
}

function buildResourceScopeLookup(relData) {
  const lookup = {};
  const subscriptions = relData?.data?.subscriptions || {};

  Object.entries(subscriptions).forEach(([subscriptionId, sub]) => {
    const resourceGroups = sub?.resource_groups || {};
    Object.entries(resourceGroups).forEach(([resourceGroupName, group]) => {
      const resourceNames = [];
      collectResourceNames(group?.categories || {}, resourceNames);
      resourceNames.forEach((resourceName) => {
        lookup[normalizeKey(resourceName)] = {
          subscriptionId,
          resourceGroup: resourceGroupName,
        };
      });
    });
  });

  return lookup;
}

function rowMatchesScope(row, selectedSubscriptionId, selectedResourceGroup, resourceScopeLookup) {
  const normalizedSelectedSub = normalizeSubscriptionScopeId(selectedSubscriptionId);
  const normalizedSelectedRg = normalizeKey(selectedResourceGroup);
  if (!normalizedSelectedSub && !normalizedSelectedRg) return true;

  // Rows are now aggregated cross-RG; check multi-value arrays first.
  const rowSubIds = Array.isArray(row.subscriptionIds) && row.subscriptionIds.length > 0
    ? row.subscriptionIds.map(normalizeSubscriptionScopeId)
    : [normalizeSubscriptionScopeId(row.subscriptionId || '')];

  const rowRgs = Array.isArray(row.resourceGroups) && row.resourceGroups.length > 0
    ? row.resourceGroups.map(normalizeKey)
    : [normalizeKey(row.resourceGroup || '')];

  // Fall back to lookup for rows that have no explicit scope metadata.
  const mappedScope = resourceScopeLookup[normalizeKey(row.resourceName)] || null;
  if (rowSubIds.every((s) => !s) && mappedScope?.subscriptionId) {
    rowSubIds.push(normalizeSubscriptionScopeId(mappedScope.subscriptionId));
  }
  if (rowRgs.every((r) => !r) && mappedScope?.resourceGroup) {
    rowRgs.push(normalizeKey(mappedScope.resourceGroup));
  }

  if (normalizedSelectedSub) {
    const subMatch = rowSubIds.some((s) => s === normalizedSelectedSub);
    if (!subMatch) return false;
  }

  if (normalizedSelectedRg) {
    const rgMatch = rowRgs.some((r) => r === normalizedSelectedRg);
    if (!rgMatch) return false;
  }

  return true;
}

function rowMatchesFilter(row, filterId) {
  if (filterId === 'all') return true;

  const requiredPillars = FILTER_PILLAR_MAP[filterId] || [];
  const rowPillars = row.impactedPillars || [];
  const hasPillarMatch = requiredPillars.some((required) => rowPillars.includes(required));
  if (hasPillarMatch) return true;

  const category = normalizeKey(row.category || '');
  if (category) {
    const categoryFilterMap = {
      security: 'security',
      highavailability: 'reliability',
      reliability: 'reliability',
      performance: 'performance',
      performanceefficiency: 'performance',
      cost: 'cost',
      costoptimization: 'cost',
      operationalexcellence: 'operational',
      operational: 'operational',
    };

    const mappedFilter = categoryFilterMap[category];
    if (mappedFilter) {
      return mappedFilter === filterId;
    }
  }

  const keyword = FILTER_KEYWORDS[filterId];
  return keyword ? keyword.test(row.recommendation) : true;
}

function toImpactLabel(severity) {
  if (severity === 'critical') return 'Critical';
  if (severity === 'high') return 'High';
  if (severity === 'medium') return 'Medium';
  return 'Low';
}

export default function WellArchitectedScore({
  data,
  relData,
  apiSecurityRisks = null,
  apiScoreSummary = null,
  selectedSubscriptionSummary = [],
  selectedSubscriptionIds = [],
  selectedSubscriptionId = '',
  selectedResourceGroup = '',
  selectedResourceGroupLabel = '',
  onSubscriptionChange = null,
  onResourceGroupChange = null,
}) {
  const [activeFilter, setActiveFilter] = useState('all');
  const [showSubscriptionSelector, setShowSubscriptionSelector] = useState(false);
  const [showResourceGroupSelector, setShowResourceGroupSelector] = useState(false);

  const resourceScopeLookup = useMemo(() => buildResourceScopeLookup(relData), [relData]);

  const rawRecommendations = useMemo(() => (
    normalizeRecommendations(apiSecurityRisks || data?.advisor || null)
  ), [apiSecurityRisks, data]);

  const recommendations = useMemo(() => {
    const activeSubId = String(selectedSubscriptionId || '').trim();
    const activeRg = String(selectedResourceGroup || '').trim();
    const scopeFiltered = rawRecommendations.filter((row) =>
      rowMatchesScope(row, activeSubId, activeRg, resourceScopeLookup)
    );
    return groupRecommendations(scopeFiltered);
  }, [rawRecommendations, selectedSubscriptionId, selectedResourceGroup, resourceScopeLookup]);

  const filteredRecommendations = useMemo(() => (
    recommendations.filter((row) => rowMatchesFilter(row, activeFilter))
  ), [recommendations, activeFilter]);

  const activeRecommendationCount = filteredRecommendations.length;
  const advisorScores = useMemo(() => extractAdvisorScores(data, apiScoreSummary), [data, apiScoreSummary]);
  const activeResourceLabel = FILTER_SCORE_LABEL_MAP[activeFilter] || 'Advisor Score';
  const activeScoreValue = advisorScores[activeFilter] ?? advisorScores.all ?? 0;

  const resourceGroupLabel = selectedResourceGroupLabel || selectedResourceGroup || 'all';
  const activeSubscriptionId = String(selectedSubscriptionId || '').trim();

  const subscriptions = useMemo(() => {
    const subs = relData?.data?.subscriptions || {};
    const filterIds = Array.isArray(selectedSubscriptionIds) && selectedSubscriptionIds.length > 0
      ? selectedSubscriptionIds
      : Object.keys(subs);
    
    return filterIds
      .filter((subId) => subs[subId])
      .map((subId) => {
        const subData = subs[subId];
        return {
          id: subId,
          resourceGroups: Object.keys(subData?.resource_groups || {}),
        };
      });
  }, [relData, selectedSubscriptionIds]);

  const selectedSubscription = useMemo(
    () => subscriptions.find((sub) => sub.id === activeSubscriptionId) || null,
    [subscriptions, activeSubscriptionId]
  );

  const resourceGroupsForSelectedSubscription = selectedSubscription?.resourceGroups || [];
  const subscriptionDisplayValue = activeSubscriptionId || 'all';
  const selectedSubscriptionName = useMemo(() => {
    if (!activeSubscriptionId) return '';
    const match = Array.isArray(selectedSubscriptionSummary)
      ? selectedSubscriptionSummary.find((item) => String(item?.id || '') === activeSubscriptionId)
      : null;
    return String(match?.name || '').trim();
  }, [selectedSubscriptionSummary, activeSubscriptionId]);
  const subscriptionScopeLabel = activeSubscriptionId
    ? (selectedSubscriptionName ? `${selectedSubscriptionName} (${activeSubscriptionId})` : activeSubscriptionId)
    : 'all';

  return (
    <div className="score-panel advisor-score-panel">
      <h3>Well-Architected Score</h3>

      <div className="advisor-filter-row">
        {ADVISOR_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={`advisor-filter-btn ${activeFilter === filter.id ? 'active' : ''}`}
            onClick={() => setActiveFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="advisor-scope-row">
        <div className="advisor-scope-control">
          <button
            type="button"
            className="advisor-scope-chip advisor-scope-selector-btn"
            onClick={() => {
              setShowSubscriptionSelector((prev) => !prev);
              setShowResourceGroupSelector(false);
            }}
          >
            Subscription ID == {subscriptionDisplayValue}
          </button>

          {showSubscriptionSelector && (
            <div className="advisor-scope-dropdown">
              <div className="advisor-scope-dropdown-header">
                Select Subscription ID
              </div>
              <div className="advisor-scope-dropdown-list">
                <div className="advisor-scope-item">
                  <button
                    type="button"
                    className={`advisor-scope-sub-btn ${!activeSubscriptionId ? 'active' : ''}`}
                    onClick={() => {
                      if (onSubscriptionChange) onSubscriptionChange('');
                      setShowSubscriptionSelector(false);
                    }}
                  >
                    All subscriptions
                  </button>
                </div>
                {subscriptions.map((sub) => (
                  <div key={sub.id} className="advisor-scope-item">
                    <button
                      type="button"
                      className={`advisor-scope-sub-btn ${activeSubscriptionId === sub.id ? 'active' : ''}`}
                      onClick={() => {
                        if (onSubscriptionChange) onSubscriptionChange(sub.id);
                        setShowSubscriptionSelector(false);
                      }}
                    >
                      {sub.id}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="advisor-scope-control">
          <button
            type="button"
            className="advisor-scope-chip advisor-scope-selector-btn"
            onClick={() => {
              setShowResourceGroupSelector((prev) => !prev);
              setShowSubscriptionSelector(false);
            }}
            disabled={!activeSubscriptionId}
          >
            Resource Group equals {resourceGroupLabel}
          </button>

          {showResourceGroupSelector && (
            <div className="advisor-scope-dropdown">
              <div className="advisor-scope-dropdown-header">
                Select Resource Group
              </div>
              <div className="advisor-scope-dropdown-list">
                <div className="advisor-scope-item">
                  <button
                    type="button"
                    className={`advisor-scope-rg-btn ${!selectedResourceGroup ? 'active' : ''}`}
                    onClick={() => {
                      if (onResourceGroupChange) onResourceGroupChange('');
                      setShowResourceGroupSelector(false);
                    }}
                  >
                    All resource groups
                  </button>
                </div>
                {resourceGroupsForSelectedSubscription.length ? resourceGroupsForSelectedSubscription.map((rg) => (
                  <div key={rg} className="advisor-scope-item">
                    <button
                      type="button"
                      className={`advisor-scope-rg-btn ${resourceGroupLabel === rg ? 'active' : ''}`}
                      onClick={() => {
                        if (onResourceGroupChange) onResourceGroupChange(rg);
                        setShowResourceGroupSelector(false);
                      }}
                    >
                      {rg}
                    </button>
                  </div>
                )) : (
                  <div className="advisor-empty-row">No resource groups for selected subscription.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="advisor-stats-row">
        <div className="advisor-stat-box">
          <div className="advisor-stat-label">Active recommendations</div>
          <div className="advisor-stat-value">{activeRecommendationCount}</div>
        </div>
        <div className="advisor-stat-box">
          <div className="advisor-stat-label">{activeResourceLabel}</div>
          <div className="advisor-stat-value">{activeScoreValue}</div>
        </div>
      </div>

      <div className="advisor-results-scope-label">
        Showing results for: {subscriptionScopeLabel} / {resourceGroupLabel}
      </div>

      <div className="advisor-table-wrap">
        <table className="advisor-table">
          <thead>
            <tr>
              <th>Recommendation</th>
              <th>Impact</th>
              <th>Active resources</th>
            </tr>
          </thead>
          <tbody>
            {filteredRecommendations.length ? filteredRecommendations.map((row, index) => (
              <tr key={`${row.recommendation}-${row.resourceType}-${index}`}>
                <td>
                  <div>{row.recommendation}</div>
                  {row.scopes && row.scopes.length > 1 && (
                    <div style={{ fontSize: '0.72em', color: '#8a9bb8', marginTop: 3 }}>
                      {row.scopes.join(' · ')}
                    </div>
                  )}
                  {row.scopes && row.scopes.length === 1 && row.scopes[0] && (
                    <div style={{ fontSize: '0.72em', color: '#8a9bb8', marginTop: 3 }}>
                      {row.scopes[0]}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`advisor-impact-badge ${row.severity}`}>{toImpactLabel(row.severity)}</span>
                </td>
                <td>
                  {row.totalResources && row.totalResources > (row.activeResources || 0)
                    ? `${row.activeResources || 0} of ${row.totalResources} ${row.resourceType}`
                    : `${row.activeResources || 0} ${row.resourceType}`}
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan={3} className="advisor-empty-row">No recommendations available for this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}