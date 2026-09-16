import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell } from 'lucide-react';

const REGIONS = [
  'Australia East',
  'Australia Southeast',
  'Austria East',
  'Belgium Central',
  'Canada Central',
  'Canada East',
  'Central India',
  'Central US',
  'East Asia',
  'East US',
  'East US 2',
  'France Central',
  'Germany West Central',
  'Indonesia Central',
  'Israel Central',
  'Italy North',
  'Japan East',
  'Japan West',
  'Korea Central',
  'Korea South',
  'Malaysia West',
  'Mexico Central',
  'New Zealand North',
  'North Central US',
  'North Europe',
  'Norway East',
  'Poland Central',
  'South Africa North',
  'South Central US',
  'South India',
  'Southeast Asia',
  'Spain Central',
  'Sweden Central',
  'Switzerland North',
  'UAE North',
  'UK West',
  'West Central US',
  'West Europe',
  'West US',
  'West US 2',
  'West US 3',
];
const ENVIRONMENTS = ['dev', 'prod', 'non-prod', 'poc'];
const GLOBAL_BUSINESSES = ['ict', 'others'];
const GLOBAL_SUBFUNCTIONS = ['GDPA', 'others'];
const APPLICATION_NAMES = ['MGMT/AZURE', 'others'];
const SCOPE_OPTIONS = [
  { key: 'subscription', label: 'Subscription' },
  { key: 'environment', label: 'Environment' },
  { key: 'global-business', label: 'Global Business' },
  { key: 'global-subfunction', label: 'Global Subfunction' },
  { key: 'application-name', label: 'Application Name' },
];

// Filter subscriptions API — read from runtime config.js (window._env_.FILTER_SUBSCRIPTIONS_URL)
const FILTER_SUBSCRIPTIONS_URL = (window._env_ && window._env_.FILTER_SUBSCRIPTIONS_URL) || '';

function getSubscriptionDisplayName(subscriptionId, metadata = {}) {
  return metadata.subscriptionName
    || metadata.displayName
    || metadata.name
    || String(subscriptionId || '');
}

function inferEnvironment(resourceGroups) {
  const names = resourceGroups.map((name) => name.toLowerCase());
  if (names.some((name) => name.includes('poc'))) return 'poc';
  if (names.some((name) => name.includes('prod'))) return 'prod';
  if (names.some((name) => name.includes('dev'))) return 'dev';
  return 'non-prod';
}

function buildSubscriptionCatalog(relData, fallbackRegion) {
  const subscriptions = relData?.data?.subscriptions || {};

  return Object.entries(subscriptions).map(([subscriptionId, subscription], index) => {
    const metadata = subscription.metadata || {};
    const resourceGroups = Object.entries(subscription.resource_groups || {});
    const resourceGroupNames = resourceGroups.map(([name]) => name);
    const categoriesText = JSON.stringify(resourceGroups.map(([, group]) => group.categories || {})).toLowerCase();
    const hasNetwork = categoriesText.includes('public_ip_addresses') || categoriesText.includes('virtual_networks');
    const hasIctFootprint = categoriesText.includes('compute') || categoriesText.includes('app_services') || categoriesText.includes('networking');
    const hasDataFootprint = categoriesText.includes('storage') || categoriesText.includes('sql') || categoriesText.includes('monitoring');

    return {
      id: subscriptionId,
      name: getSubscriptionDisplayName(subscriptionId, metadata),
      region: metadata.region || fallbackRegion || REGIONS[index % REGIONS.length],
      environment: metadata.environment || inferEnvironment(resourceGroupNames),
      globalBusiness: metadata.globalBusiness || (hasIctFootprint ? 'ict' : 'others'),
      globalSubfunction: metadata.globalSubfunction || (hasDataFootprint ? 'GDPA' : 'others'),
      applicationName: metadata.applicationName || (hasNetwork ? 'MGMT/AZURE' : 'others'),
      resourceGroups: resourceGroupNames,
    };
  });
}

export default function Header({
  scopeType,
  setScopeType,
  subscriptionId,
  setSubscriptionId,
  selectedSubscriptionIds,
  setSelectedSubscriptionIds,
  resourceGroup,
  setResourceGroup,
  region,
  setRegion,
  scopeRegion,
  setScopeRegion,
  scopeCriteria,
  setScopeCriteria,
  relData,
  onDiscover,
  onLoadDemoData,
  onSubscriptionNamesChange,
  loading,
  onNotifications,
}) {
  const [isScopeModalOpen, setIsScopeModalOpen] = useState(false);
  const [scopeModalStep, setScopeModalStep] = useState('scope');
  const [subscriptionSearch, setSubscriptionSearch] = useState('');
  const [draftScopeType, setDraftScopeType] = useState(scopeType);
  const [draftSelectedSubscriptionIds, setDraftSelectedSubscriptionIds] = useState(selectedSubscriptionIds);
  const [draftScopeRegion, setDraftScopeRegion] = useState(scopeRegion || region);
  const [draftScopeCriteria, setDraftScopeCriteria] = useState(scopeCriteria);
  const [fetchedSubscriptions, setFetchedSubscriptions] = useState([]);
  const [hasFetchedSubscriptions, setHasFetchedSubscriptions] = useState(false);
  const [isScopeFetching, setIsScopeFetching] = useState(false);
  const [scopeFetchError, setScopeFetchError] = useState('');
  const resultsPanelRef = useRef(null);

  const subscriptionCatalog = useMemo(
    () => buildSubscriptionCatalog(relData, scopeRegion || region),
    [relData, region, scopeRegion]
  );

  const matchingSubscriptions = useMemo(() => {
    if (draftScopeType === 'environment') {
      return subscriptionCatalog.filter(
        (item) => item.region === draftScopeRegion && item.environment === draftScopeCriteria.environment
      );
    }

    if (draftScopeType === 'global-business') {
      return subscriptionCatalog.filter(
        (item) => item.region === draftScopeRegion && item.globalBusiness === draftScopeCriteria.globalBusiness
      );
    }

    if (draftScopeType === 'global-subfunction') {
      return subscriptionCatalog.filter(
        (item) => item.region === draftScopeRegion && item.globalSubfunction === draftScopeCriteria.globalSubfunction
      );
    }

    if (draftScopeType === 'application-name') {
      return subscriptionCatalog.filter(
        (item) => item.region === draftScopeRegion && item.applicationName === draftScopeCriteria.applicationName
      );
    }

    return subscriptionCatalog;
  }, [draftScopeCriteria, draftScopeRegion, draftScopeType, subscriptionCatalog]);

  const activeSubscriptions = useMemo(() => (
    hasFetchedSubscriptions ? fetchedSubscriptions : matchingSubscriptions
  ), [hasFetchedSubscriptions, fetchedSubscriptions, matchingSubscriptions]);

  const filteredSubscriptions = useMemo(() => {
    const query = subscriptionSearch.trim().toLowerCase();

    if (!query) return activeSubscriptions;

    return activeSubscriptions.filter((item) => (
      item.name.toLowerCase().includes(query)
      || item.id.toLowerCase().includes(query)
      || item.region.toLowerCase().includes(query)
      || item.environment.toLowerCase().includes(query)
      || item.globalBusiness.toLowerCase().includes(query)
      || item.globalSubfunction.toLowerCase().includes(query)
      || item.applicationName.toLowerCase().includes(query)
    ));
  }, [activeSubscriptions, subscriptionSearch]);

  const selectedSubscriptionNames = useMemo(() => (
    subscriptionCatalog
      .filter((item) => selectedSubscriptionIds.includes(item.id))
      .map((item) => item.name)
  ), [selectedSubscriptionIds, subscriptionCatalog]);

  const scopeSummary = selectedSubscriptionIds.length
    ? `${SCOPE_OPTIONS.find((option) => option.key === scopeType)?.label || 'Scope'}: ${selectedSubscriptionIds.length} subscription${selectedSubscriptionIds.length > 1 ? 's' : ''} selected${selectedSubscriptionNames.length ? ` • ${selectedSubscriptionNames.slice(0, 2).join(', ')}${selectedSubscriptionNames.length > 2 ? '…' : ''}` : ''}`
    : `${SCOPE_OPTIONS.find((option) => option.key === scopeType)?.label || 'Scope'}: Not selected`;

  useEffect(() => {
    if (!isScopeModalOpen || scopeModalStep !== 'subscriptions') return;

    window.requestAnimationFrame(() => {
      resultsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [isScopeModalOpen, scopeModalStep]);

  const selectedScopeLabel = SCOPE_OPTIONS.find((option) => option.key === draftScopeType)?.label || 'Scope';

  const selectedScopeDescription = draftScopeType === 'environment'
    ? `Region ${draftScopeRegion} • Environment ${draftScopeCriteria.environment}`
    : draftScopeType === 'global-business'
      ? `Region ${draftScopeRegion} • Global Business ${draftScopeCriteria.globalBusiness}`
      : draftScopeType === 'global-subfunction'
        ? `Region ${draftScopeRegion} • Global Subfunction ${draftScopeCriteria.globalSubfunction}`
        : draftScopeType === 'application-name'
          ? `Region ${draftScopeRegion} • Application Name ${draftScopeCriteria.applicationName}`
          : 'No extra filter is required for subscription scope.';

  const openScopeModal = () => {
    setDraftScopeType(scopeType);
    setDraftSelectedSubscriptionIds(selectedSubscriptionIds);
    setDraftScopeRegion(scopeRegion || region);
    setDraftScopeCriteria(scopeCriteria);
    setScopeModalStep('scope');
    setSubscriptionSearch('');
    setIsScopeModalOpen(true);
  };
  const closeScopeModal = () => {
    if (!loading) {
      setScopeModalStep('scope');
      setSubscriptionSearch('');
      setIsScopeModalOpen(false);
    }
  };

  const toggleSubscription = (subscriptionValue) => {
    setDraftSelectedSubscriptionIds((prev) => (
      prev.includes(subscriptionValue)
        ? prev.filter((item) => item !== subscriptionValue)
        : [...prev, subscriptionValue]
    ));
  };

  const selectAllMatchingSubscriptions = () => {
    const next = filteredSubscriptions.map((item) => item.id);
    setDraftSelectedSubscriptionIds(next);
  };

  const clearSelectedSubscriptions = () => {
    setDraftSelectedSubscriptionIds([]);
  };

  const normalizeResponseSubscriptions = (responsePayload) => {
    const rawItems = Array.isArray(responsePayload)
      ? responsePayload
      : Array.isArray(responsePayload?.data)
        ? responsePayload.data
        : Array.isArray(responsePayload?.subscriptions)
          ? responsePayload.subscriptions
          : responsePayload?.data?.subscriptions && typeof responsePayload.data.subscriptions === 'object'
            ? Object.entries(responsePayload.data.subscriptions).map(([id, meta]) => ({ id, ...meta }))
            : [];

    const fallbackById = new Map(subscriptionCatalog.map((item) => [item.id, item]));

    return rawItems
      .map((entry) => {
        const id = String(
          entry?.subscription_id
          || entry?.subscriptionId
          || entry?.stla_subscription_id
          || entry?.id
          || ''
        ).trim();

        if (!id) return null;

        const fallback = fallbackById.get(id);
        return {
          id,
          name: entry?.subscription_name || entry?.subscriptionName || entry?.name || entry?.displayName || fallback?.name || id,
          region: entry?.stla_region || entry?.region || fallback?.region || draftScopeRegion,
          environment: entry?.stla_environment || entry?.environment || fallback?.environment || 'non-prod',
          globalBusiness: entry?.stla_global_business || entry?.globalBusiness || fallback?.globalBusiness || 'others',
          globalSubfunction: entry?.stla_global_subfunction || entry?.globalSubfunction || fallback?.globalSubfunction || 'others',
          applicationName: entry?.stla_application_name || entry?.applicationName || fallback?.applicationName || 'others',
        };
      })
      .filter(Boolean);
  };

  const fetchSubscriptionsByScope = async (nextScopeType, nextCriteria, nextRegion) => {
    setIsScopeFetching(true);
    setScopeFetchError('');

    try {
      const requestBody = nextScopeType === 'subscription'
        ? {}
        : nextScopeType === 'environment'
          ? { stla_region: nextRegion, stla_environment: nextCriteria.environment }
          : nextScopeType === 'global-business'
            ? { stla_region: nextRegion, stla_global_business: nextCriteria.globalBusiness }
            : nextScopeType === 'global-subfunction'
              ? { stla_region: nextRegion, stla_global_subfunction: nextCriteria.globalSubfunction }
              : { stla_region: nextRegion, stla_application_name: nextCriteria.applicationName };

      const requestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      };

      const response = await fetch(FILTER_SUBSCRIPTIONS_URL, requestInit);
      if (!response.ok) {
        let errorMessage = `Filter API failed with ${response.status}`;
        try {
          const errorPayload = await response.json();
          const detail = [errorPayload?.message, errorPayload?.details].filter(Boolean).join(' | ');
          if (detail) errorMessage = detail;
        } catch {
          // ignore parse errors and keep generic status message
        }
        throw new Error(errorMessage);
      }

      const payload = await response.json();
      const normalized = normalizeResponseSubscriptions(payload);
      setFetchedSubscriptions(normalized);
      setHasFetchedSubscriptions(true);
      setDraftSelectedSubscriptionIds([]);
    } catch (error) {
      setFetchedSubscriptions([]);
      setHasFetchedSubscriptions(true);
      setScopeFetchError(error?.message || 'Failed to fetch subscriptions from filter API.');
    } finally {
      setIsScopeFetching(false);
    }
  };

  const handleScopeTypeChange = async (nextScope) => {
    setDraftScopeType(nextScope);
    setDraftSelectedSubscriptionIds([]);
    setSubscriptionSearch('');
    setFetchedSubscriptions([]);
    setHasFetchedSubscriptions(false);
    setScopeFetchError('');

    if (nextScope === 'subscription') {
      setScopeModalStep('subscriptions');
      await fetchSubscriptionsByScope('subscription', draftScopeCriteria, draftScopeRegion);
      return;
    }

    setScopeModalStep('criteria');
  };

  const applyDraftScope = () => {
    setScopeType(draftScopeType);
    setSelectedSubscriptionIds(draftSelectedSubscriptionIds);
    setScopeRegion(draftScopeRegion);
    setScopeCriteria(draftScopeCriteria);
    setRegion(draftScopeRegion || region);
    setResourceGroup('');

    if (draftSelectedSubscriptionIds[0]) {
      setSubscriptionId(draftSelectedSubscriptionIds[0]);
    }

    // Propagate subscription names so App can display them in the banner
    if (onSubscriptionNamesChange) {
      const nameMap = {};
      activeSubscriptions.forEach((sub) => {
        if (sub.id && sub.name) nameMap[sub.id] = sub.name;
      });
      onSubscriptionNamesChange(nameMap);
    }
  };

  const handleModalDiscover = async () => {
    applyDraftScope();
    const success = await onDiscover({
      scopeType: draftScopeType,
      selectedSubscriptionIds: draftSelectedSubscriptionIds,
      subscriptionId: draftSelectedSubscriptionIds[0] || subscriptionId,
      scopeRegion: draftScopeRegion,
      scopeCriteria: draftScopeCriteria,
      region: draftScopeRegion || region,
      resourceGroup: '',
    });
    if (success) closeScopeModal();
  };

  return (
    <>
      <div className="header">
        <div className="header-left">
          <button
            type="button"
            className="scope-picker-btn"
            onClick={openScopeModal}
            disabled={loading}
          >
            {loading ? 'Scope Locked During Discovery' : 'Select Scope'}
          </button>
          <span className="scope-summary">{scopeSummary}</span>
          <button
            className={`discover-btn ${loading ? 'loading' : ''}`}
            onClick={onDiscover}
            disabled={loading}
          >
            {loading ? 'Discovering...' : 'Discover'}
          </button>
          <button
            className="discover-btn"
            onClick={onLoadDemoData}
            disabled={loading}
            type="button"
            style={{ marginLeft: 8 }}
          >
            Load Demo Data
          </button>
        </div>

        <div className="header-right">
          <Bell size={18} className="bell" onClick={onNotifications} style={{ cursor: 'pointer' }} />
          <div className="user-avatar">AL</div>
          <span className="user-email">Cloud Architecture Intelligence & Drift Governance Platform</span>
        </div>
      </div>

      {isScopeModalOpen && (
        <div className="scope-modal-backdrop" onClick={closeScopeModal}>
          <div className="scope-modal scope-modal-wide" onClick={(e) => e.stopPropagation()}>
            {loading && (
              <div className="scope-modal-loading-overlay" role="status" aria-live="polite">
                <div className="scope-modal-loading-content">
                  <span className="spinner spinner-lg spinner-ring" aria-hidden="true" />
                  <span>Discovering resources...</span>
                </div>
              </div>
            )}
            <div className="scope-modal-header">
              <div>
                <h3>
                  {scopeModalStep === 'scope'
                    ? 'Select Discovery Scope'
                    : scopeModalStep === 'criteria'
                      ? `Configure ${selectedScopeLabel}`
                      : `Choose Subscriptions for ${selectedScopeLabel}`}
                </h3>
                <div className="scope-results-meta">
                  {scopeModalStep === 'scope'
                    ? 'Step 1 of 3'
                    : scopeModalStep === 'criteria'
                      ? 'Step 2 of 3'
                      : 'Step 3 of 3'}
                </div>
              </div>
              <button type="button" className="scope-modal-close" onClick={closeScopeModal} aria-label="Close scope form">
                ×
              </button>
            </div>

            {scopeModalStep === 'scope' && (
              <div className="scope-option-list">
                {SCOPE_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`scope-option-card ${draftScopeType === option.key ? 'active' : ''}`}
                    onClick={() => {
                      void handleScopeTypeChange(option.key);
                    }}
                  >
                    <strong>{option.label}</strong>
                    <span>
                      {option.key === 'subscription'
                        ? 'Select one subscription, multiple subscriptions, or all subscriptions.'
                        : option.key === 'environment'
                          ? 'Filter subscriptions by region and environment.'
                          : option.key === 'global-business'
                            ? 'Filter subscriptions by region and global business.'
                            : option.key === 'global-subfunction'
                              ? 'Filter subscriptions by region and global subfunction.'
                              : 'Filter subscriptions by region and application name.'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {scopeModalStep === 'criteria' && (
              <>
                <div className="scope-helper scope-helper-strong scope-helper-stage">
                  Selected scope: <strong>{selectedScopeLabel}</strong>
                  <br />
                  {selectedScopeDescription}
                </div>

                <div className="scope-form-grid">
                  {draftScopeType === 'environment' && (
                    <>
                      <label className="scope-field">
                        <span>Region</span>
                        <select
                          className="scope-select"
                          value={draftScopeRegion}
                          onChange={(e) => setDraftScopeRegion(e.target.value)}
                          disabled={loading}
                        >
                          {REGIONS.map((regionOption) => (
                            <option key={regionOption} value={regionOption}>{regionOption}</option>
                          ))}
                        </select>
                      </label>
                      <label className="scope-field">
                        <span>Environment</span>
                        <select
                          className="scope-select"
                          value={draftScopeCriteria.environment}
                          onChange={(e) => setDraftScopeCriteria((prev) => ({ ...prev, environment: e.target.value }))}
                          disabled={loading}
                        >
                          {ENVIRONMENTS.map((environment) => (
                            <option key={environment} value={environment}>{environment}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  {draftScopeType === 'global-business' && (
                    <>
                      <label className="scope-field">
                        <span>Region</span>
                        <select className="scope-select" value={draftScopeRegion} onChange={(e) => setDraftScopeRegion(e.target.value)} disabled={loading}>
                          {REGIONS.map((regionOption) => (
                            <option key={regionOption} value={regionOption}>{regionOption}</option>
                          ))}
                        </select>
                      </label>
                      <label className="scope-field">
                        <span>Global Business</span>
                        <select
                          className="scope-select"
                          value={draftScopeCriteria.globalBusiness}
                          onChange={(e) => setDraftScopeCriteria((prev) => ({ ...prev, globalBusiness: e.target.value }))}
                          disabled={loading}
                        >
                          {GLOBAL_BUSINESSES.map((value) => (
                            <option key={value} value={value}>{value}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  {draftScopeType === 'global-subfunction' && (
                    <>
                      <label className="scope-field">
                        <span>Region</span>
                        <select className="scope-select" value={draftScopeRegion} onChange={(e) => setDraftScopeRegion(e.target.value)} disabled={loading}>
                          {REGIONS.map((regionOption) => (
                            <option key={regionOption} value={regionOption}>{regionOption}</option>
                          ))}
                        </select>
                      </label>
                      <label className="scope-field">
                        <span>Global Subfunction</span>
                        <select
                          className="scope-select"
                          value={draftScopeCriteria.globalSubfunction}
                          onChange={(e) => setDraftScopeCriteria((prev) => ({ ...prev, globalSubfunction: e.target.value }))}
                          disabled={loading}
                        >
                          {GLOBAL_SUBFUNCTIONS.map((value) => (
                            <option key={value} value={value}>{value}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  {draftScopeType === 'application-name' && (
                    <>
                      <label className="scope-field">
                        <span>Region</span>
                        <select className="scope-select" value={draftScopeRegion} onChange={(e) => setDraftScopeRegion(e.target.value)} disabled={loading}>
                          {REGIONS.map((regionOption) => (
                            <option key={regionOption} value={regionOption}>{regionOption}</option>
                          ))}
                        </select>
                      </label>
                      <label className="scope-field">
                        <span>Application Name</span>
                        <select
                          className="scope-select"
                          value={draftScopeCriteria.applicationName}
                          onChange={(e) => setDraftScopeCriteria((prev) => ({ ...prev, applicationName: e.target.value }))}
                          disabled={loading}
                        >
                          {APPLICATION_NAMES.map((value) => (
                            <option key={value} value={value}>{value}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}

                  {draftScopeType === 'subscription' && (
                    <div className="scope-helper">
                      Subscription scope does not require extra filters. Press <strong>Apply Actions</strong> to continue to subscription selection.
                    </div>
                  )}
                </div>
              </>
            )}

            {scopeModalStep === 'subscriptions' && (
              <>
                <div className="scope-helper scope-helper-strong scope-helper-stage">
                  Scope ready: <strong>{selectedScopeLabel}</strong>
                  <br />
                  Search and select one subscription, multiple subscriptions, or use <strong>Select All Subscriptions</strong>.
                </div>

                <div className="scope-results-panel" ref={resultsPanelRef}>
                  <div className="scope-results-header">
                    <div>
                      <strong>Available Subscriptions</strong>
                      <div className="scope-results-meta">{filteredSubscriptions.length} of {activeSubscriptions.length} matched for the current scope</div>
                    </div>
                    <div className="scope-results-actions">
                      <button type="button" className="scope-chip-btn" onClick={selectAllMatchingSubscriptions} disabled={!activeSubscriptions.length || loading || isScopeFetching}>
                        Select All Subscriptions
                      </button>
                      <button type="button" className="scope-chip-btn" onClick={clearSelectedSubscriptions} disabled={!draftSelectedSubscriptionIds.length || loading || isScopeFetching}>
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="scope-search-row">
                    <input
                      className="scope-input scope-search-input"
                      placeholder="Search subscription name, ID, region, environment..."
                      value={subscriptionSearch}
                      onChange={(e) => setSubscriptionSearch(e.target.value)}
                      disabled={loading}
                    />
                  </div>

                  <div className="scope-subscription-list">
                    {isScopeFetching && (
                      <div className="scope-empty-state">
                        ⏳ Loading subscriptions...
                      </div>
                    )}

                    {!isScopeFetching && scopeFetchError && (
                      <div className="scope-empty-state">
                        ❌ Failed to load subscriptions. {scopeFetchError}
                      </div>
                    )}

                    {!isScopeFetching && !scopeFetchError && !hasFetchedSubscriptions && (
                      <div className="scope-empty-state">
                        ❌ No subscriptions fetched. Please apply actions to fetch subscriptions.
                      </div>
                    )}

                    {!isScopeFetching && hasFetchedSubscriptions && !filteredSubscriptions.length && !scopeFetchError && (
                      <div className="scope-empty-state">
                        No subscriptions matched this search. Adjust the filters or search text and try again.
                      </div>
                    )}

                    {filteredSubscriptions.map((item) => (
                      <label key={item.id} className="scope-subscription-item">
                        <input
                          type="checkbox"
                          checked={draftSelectedSubscriptionIds.includes(item.id)}
                          onChange={() => toggleSubscription(item.id)}
                          disabled={loading}
                        />
                        <div className="scope-subscription-copy">
                          <strong>{item.name}</strong>
                          <span>
                            {item.id} • {item.region} • {item.environment} • {item.globalBusiness} • {item.globalSubfunction} • {item.applicationName}
                          </span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="scope-modal-actions scope-modal-actions-split">
              <div className="scope-results-meta">
                {scopeModalStep === 'subscriptions'
                  ? `Selected: ${draftSelectedSubscriptionIds.length} subscription${draftSelectedSubscriptionIds.length === 1 ? '' : 's'}`
                  : `Current scope: ${selectedScopeLabel}`}
              </div>
              <div className="scope-results-actions">
                {scopeModalStep !== 'scope' && (
                  <button
                    type="button"
                    className="scope-save-btn"
                    onClick={() => {
                      if (scopeModalStep === 'subscriptions') {
                        setScopeModalStep(draftScopeType === 'subscription' ? 'scope' : 'criteria');
                      } else {
                        setScopeModalStep('scope');
                      }
                    }}
                    disabled={loading}
                  >
                    Back
                  </button>
                )}

                {scopeModalStep === 'criteria' && (
                  <button
                    type="button"
                    className="scope-save-btn scope-discover-btn"
                    onClick={async () => {
                      setSubscriptionSearch('');
                      setDraftSelectedSubscriptionIds([]);
                      setScopeModalStep('subscriptions');
                      await fetchSubscriptionsByScope(draftScopeType, draftScopeCriteria, draftScopeRegion);
                    }}
                    disabled={loading || isScopeFetching}
                  >
                    {isScopeFetching ? 'Loading...' : 'Apply Actions'}
                  </button>
                )}

                {scopeModalStep === 'subscriptions' && (
                  <>
                    <button
                      type="button"
                      className="scope-save-btn"
                      onClick={() => {
                        applyDraftScope();
                        closeScopeModal();
                      }}
                      disabled={loading}
                    >
                      Apply Selection
                    </button>
                    <button type="button" className="scope-save-btn scope-discover-btn" onClick={handleModalDiscover} disabled={loading || isScopeFetching || !draftSelectedSubscriptionIds.length}>
                      {loading ? 'Discovering...' : 'Discover'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
