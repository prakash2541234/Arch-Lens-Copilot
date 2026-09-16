import React, { useEffect, useMemo, useRef, useState } from 'react';

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeKey(value = '') {
  return normalizeText(value).toLowerCase();
}

function extractSubscriptionIdFromLabel(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  const match = text.match(/\(([^()]+)\)\s*$/);
  if (!match?.[1]) return '';
  return normalizeText(match[1]);
}

function extractSubscriptionNameFromLabel(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  const match = text.match(/^(.*)\(([^()]+)\)\s*$/);
  if (match?.[1]) return normalizeText(match[1]);
  return text;
}

function flattenPolicyAssignments(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {
      rows: Array.isArray(source)
        ? source
        : Array.isArray(source?.assignments)
          ? source.assignments
          : Array.isArray(source?.policyAssignments)
            ? source.policyAssignments
            : Array.isArray(source?.recommendations)
              ? source.recommendations
              : Array.isArray(source?.findings)
                ? source.findings
                : Array.isArray(source?.risks)
                  ? source.risks
                  : [],
      hasSubscriptionGrouping: false,
    };
  }

  const groupedEntries = Object.entries(source).filter(([, value]) => (
    value
    && typeof value === 'object'
    && (Array.isArray(value?.assignments) || Array.isArray(value?.policyAssignments))
  ));

  if (!groupedEntries.length) {
    return {
      rows: Array.isArray(source?.assignments)
        ? source.assignments
        : Array.isArray(source?.policyAssignments)
          ? source.policyAssignments
          : Array.isArray(source?.recommendations)
            ? source.recommendations
            : Array.isArray(source?.findings)
              ? source.findings
              : Array.isArray(source?.risks)
                ? source.risks
                : [],
      hasSubscriptionGrouping: false,
    };
  }

  const flattened = [];
  groupedEntries.forEach(([subscriptionLabel, value]) => {
    const bucketRows = Array.isArray(value?.assignments)
      ? value.assignments
      : Array.isArray(value?.policyAssignments)
        ? value.policyAssignments
        : [];

    const subscriptionId = extractSubscriptionIdFromLabel(subscriptionLabel);
    const subscriptionName = extractSubscriptionNameFromLabel(subscriptionLabel);

    bucketRows.forEach((item) => {
      flattened.push({
        ...item,
        subscriptionId: normalizeText(item?.subscriptionId || item?.subscription_id || subscriptionId),
        subscriptionName: normalizeText(item?.subscriptionName || subscriptionName),
      });
    });
  });

  return { rows: flattened, hasSubscriptionGrouping: true };
}

function normalizePolicyAssignments(source) {
  const { rows, hasSubscriptionGrouping } = flattenPolicyAssignments(source);

  const grouped = new Map();

  rows.forEach((item) => {
    const assignmentName = normalizeText(
      item?.assignmentName
      || item?.name
      || item?.displayName
      || item?.recommendation
      || item?.issue
      || item?.title
      || item?.finding
      || item?.text
    );

    if (!assignmentName) return;

    const scope = normalizeText(
      item?.scope
      || item?.resourceGroup
      || item?.resource_group
      || item?.resourceGroupName
      || item?.subscriptionName
      || item?.subscriptionId
      || item?.subscription_id
      || item?.subscription
      || 'PLATFORM'
    );

    const typeRaw = normalizeText(item?.type || item?.definitionType || item?.assignmentType);
    const inferredType = /initiative/i.test(typeRaw) ? 'Initiative' : 'Policy';
    const type = typeRaw ? inferredType : 'Policy';

    const subscriptionId = normalizeText(item?.subscriptionId || item?.subscription_id);
    const subscriptionName = normalizeText(item?.subscriptionName);

    const key = `${normalizeKey(assignmentName)}|${normalizeKey(scope)}|${normalizeKey(type)}|${normalizeKey(subscriptionId)}`;
    if (grouped.has(key)) return;

    grouped.set(key, {
      id: key,
      assignmentName,
      scope,
      type,
      subscriptionId,
      subscriptionName,
      hasSubscriptionGrouping,
      raw: item,
    });
  });

  return Array.from(grouped.values());
}

export default function PolicyPage({
  policySource = null,
  selectedSubscriptionSummary = [],
  selectedSubscriptionId = '',
  onOpenDefinition = () => {},
  onOpenAssignment = () => {},
}) {
  const [searchText, setSearchText] = useState('');
  const [definitionType, setDefinitionType] = useState('all');
  const [showScopeSelector, setShowScopeSelector] = useState(false);
  const [showDefinitionSelector, setShowDefinitionSelector] = useState(false);
  const [selectedScopeSubscriptionId, setSelectedScopeSubscriptionId] = useState('all');
  const scopeControlRef = useRef(null);
  const definitionControlRef = useRef(null);

  const assignmentRows = useMemo(() => normalizePolicyAssignments(policySource), [policySource]);

  const selectedSubscriptionName = useMemo(() => {
    const activeId = normalizeText(selectedSubscriptionId);
    if (!activeId) return '';
    const match = Array.isArray(selectedSubscriptionSummary)
      ? selectedSubscriptionSummary.find((item) => normalizeText(item?.id) === activeId)
      : null;
    return normalizeText(match?.name);
  }, [selectedSubscriptionSummary, selectedSubscriptionId]);

  const scopeLabel = selectedSubscriptionName
    ? `${selectedSubscriptionName}`
    : (normalizeText(selectedSubscriptionId) || 'All subscriptions');

  const scopeOptions = useMemo(() => {
    const options = [{ id: 'all', label: 'All selected subscriptions' }];
    if (Array.isArray(selectedSubscriptionSummary) && selectedSubscriptionSummary.length > 0) {
      selectedSubscriptionSummary.forEach((item) => {
        const id = normalizeText(item?.id);
        if (!id) return;
        const name = normalizeText(item?.name);
        options.push({ id, label: name ? `${name} (${id})` : id, name });
      });
      return options;
    }

    const fallbackId = normalizeText(selectedSubscriptionId);
    if (fallbackId) {
      options.push({ id: fallbackId, label: scopeLabel, name: selectedSubscriptionName });
    }
    return options;
  }, [selectedSubscriptionSummary, selectedSubscriptionId, selectedSubscriptionName, scopeLabel]);

  const selectedScopeOption = scopeOptions.find((opt) => opt.id === selectedScopeSubscriptionId) || scopeOptions[0];

  const definitionTypeOptions = [
    { id: 'all', label: 'All definition types' },
    { id: 'initiative', label: 'Initiative' },
    { id: 'policy', label: 'Policy' },
  ];
  const selectedDefinitionTypeOption = definitionTypeOptions.find((opt) => opt.id === definitionType) || definitionTypeOptions[0];

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (
        scopeControlRef.current
        && !scopeControlRef.current.contains(event.target)
      ) {
        setShowScopeSelector(false);
      }

      if (
        definitionControlRef.current
        && !definitionControlRef.current.contains(event.target)
      ) {
        setShowDefinitionSelector(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, []);

  const filteredRows = useMemo(() => {
    const query = normalizeKey(searchText);

    return assignmentRows.filter((row) => {
      if (selectedScopeSubscriptionId !== 'all') {
        if (row.subscriptionId) {
          if (normalizeKey(row.subscriptionId) !== normalizeKey(selectedScopeSubscriptionId)) {
            return false;
          }
        } else {
          const selectedName = normalizeKey(selectedScopeOption?.name || '');
          const selectedId = normalizeKey(selectedScopeSubscriptionId);
          const rowScope = normalizeKey(row.scope);
          if (!rowScope.includes(selectedId) && !(selectedName && rowScope.includes(selectedName))) {
            return false;
          }
        }

      }

      if (definitionType !== 'all' && normalizeKey(row.type) !== definitionType) {
        return false;
      }

      if (!query) return true;
      return (
        normalizeKey(row.assignmentName).includes(query)
        || normalizeKey(row.scope).includes(query)
        || normalizeKey(row.type).includes(query)
      );
    });
  }, [assignmentRows, searchText, definitionType, selectedScopeSubscriptionId, selectedScopeOption]);

  const totalAssignments = filteredRows.length;
  const initiativeAssignments = filteredRows.filter((row) => row.type === 'Initiative').length;
  const policyAssignments = filteredRows.filter((row) => row.type === 'Policy').length;

  return (
    <div className="page-body">
      <div className="nav-page-header">
        <h2>Policy</h2>
        <p>Policy definitions and assignments for the selected scope</p>
      </div>

      <div className="single-panel-view policy-page-wrap">
        <div className="policy-top-tabs">
          <button
            type="button"
            className="policy-tab-btn"
            onClick={onOpenDefinition}
          >
            Definition
          </button>
          <button
            type="button"
            className="policy-tab-btn active"
          >
            Assignment
          </button>
        </div>

        <div className="policy-filter-row">
          <input
            className="policy-search-input"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Filter by name or ID..."
          />
          <div className="policy-scope-control" ref={scopeControlRef}>
            <button
              type="button"
              className="policy-chip policy-scope-btn"
              onClick={() => {
                setShowScopeSelector((prev) => !prev);
                setShowDefinitionSelector(false);
              }}
            >
              Scope : <strong>{selectedScopeOption?.label || scopeLabel}</strong>
            </button>

            {showScopeSelector && (
              <div className="policy-scope-dropdown">
                {scopeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`policy-scope-option ${selectedScopeSubscriptionId === option.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedScopeSubscriptionId(option.id);
                      setShowScopeSelector(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="policy-scope-control" ref={definitionControlRef}>
            <button
              type="button"
              className="policy-chip policy-scope-btn"
              onClick={() => {
                setShowDefinitionSelector((prev) => !prev);
                setShowScopeSelector(false);
              }}
            >
              Definition type : <strong>{selectedDefinitionTypeOption.label}</strong>
            </button>

            {showDefinitionSelector && (
              <div className="policy-scope-dropdown policy-definition-dropdown">
                {definitionTypeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`policy-scope-option ${definitionType === option.id ? 'active' : ''}`}
                    onClick={() => {
                      setDefinitionType(option.id);
                      setShowDefinitionSelector(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="policy-metrics-row">
          <div className="policy-metric-box">
            <div className="policy-metric-label">Total Assignments</div>
            <div className="policy-metric-value">{totalAssignments}</div>
          </div>
          <div className="policy-metric-box">
            <div className="policy-metric-label">Initiative Assignments</div>
            <div className="policy-metric-value">{initiativeAssignments}</div>
          </div>
          <div className="policy-metric-box">
            <div className="policy-metric-label">Policy Assignments</div>
            <div className="policy-metric-value">{policyAssignments}</div>
          </div>
        </div>

        <div className="policy-table-wrap">
          <table className="policy-table">
            <thead>
              <tr>
                <th>Assignment name</th>
                <th>Scope</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button
                      type="button"
                      className="policy-assignment-link"
                      onClick={() => onOpenAssignment(row)}
                    >
                      {row.assignmentName}
                    </button>
                  </td>
                  <td>{row.scope}</td>
                  <td>{row.type}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={3} className="policy-empty-row">No assignments available for this scope.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
