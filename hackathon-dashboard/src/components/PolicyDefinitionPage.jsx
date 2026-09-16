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

function flattenPolicyDefinitions(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {
      rows: Array.isArray(source)
        ? source
        : Array.isArray(source?.definitions)
          ? source.definitions
          : Array.isArray(source?.policyDefinitions)
            ? source.policyDefinitions
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
    && (Array.isArray(value?.definitions) || Array.isArray(value?.policyDefinitions))
  ));

  if (!groupedEntries.length) {
    return {
      rows: Array.isArray(source?.definitions)
        ? source.definitions
        : Array.isArray(source?.policyDefinitions)
          ? source.policyDefinitions
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
    const bucketRows = Array.isArray(value?.definitions)
      ? value.definitions
      : Array.isArray(value?.policyDefinitions)
        ? value.policyDefinitions
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

function toDefinitionType(value = '') {
  const raw = normalizeText(value);
  if (!raw) return 'Policy';
  if (/initiative/i.test(raw)) return 'Initiative';
  return 'Policy';
}

function toPolicyType(value = '') {
  const raw = normalizeText(value);
  if (!raw) return 'BuiltIn';
  if (/custom/i.test(raw)) return 'Custom';
  if (/static/i.test(raw)) return 'Static';
  if (/builtin|built in/i.test(raw)) return 'BuiltIn';
  return 'BuiltIn';
}

function normalizePolicyDefinitions(source) {
  const { rows, hasSubscriptionGrouping } = flattenPolicyDefinitions(source);

  const grouped = new Map();

  rows.forEach((item) => {
    const name = normalizeText(
      item?.name
      || item?.displayName
      || item?.definitionName
      || item?.assignmentName
      || item?.recommendation
      || item?.issue
      || item?.title
      || item?.finding
      || item?.text
    );

    if (!name) return;

    const type = normalizeText(item?.type || item?.policyType || item?.sourceType || 'BuiltIn');
    const definitionType = toDefinitionType(item?.definitionType || item?.assignmentType || item?.kind || item?.type);
    const category = normalizeText(item?.category || item?.policyCategory || item?.service || 'Regulatory Compliance');

    const subscriptionId = normalizeText(item?.subscriptionId || item?.subscription_id);
    const subscriptionName = normalizeText(item?.subscriptionName);

    const key = `${normalizeKey(name)}|${normalizeKey(type)}|${normalizeKey(definitionType)}|${normalizeKey(category)}|${normalizeKey(subscriptionId)}`;
    if (grouped.has(key)) return;

    grouped.set(key, {
      id: key,
      name,
      type: toPolicyType(type),
      definitionType,
      category,
      subscriptionId,
      subscriptionName,
      hasSubscriptionGrouping,
      raw: item,
    });
  });

  return Array.from(grouped.values());
}

export default function PolicyDefinitionPage({
  policySource = null,
  selectedSubscriptionSummary = [],
  selectedSubscriptionId = '',
  onOpenAssignmentPage = () => {},
}) {
  const [searchText, setSearchText] = useState('');
  const [definitionType, setDefinitionType] = useState('all');
  const [policyType, setPolicyType] = useState('all');
  const [showScopeSelector, setShowScopeSelector] = useState(false);
  const [showDefinitionSelector, setShowDefinitionSelector] = useState(false);
  const [showPolicyTypeSelector, setShowPolicyTypeSelector] = useState(false);
  const [selectedScopeSubscriptionId, setSelectedScopeSubscriptionId] = useState('all');
  const scopeControlRef = useRef(null);
  const definitionControlRef = useRef(null);
  const policyTypeControlRef = useRef(null);

  const definitionRows = useMemo(() => normalizePolicyDefinitions(policySource), [policySource]);

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
    { id: 'policy', label: 'Policy' },
    { id: 'initiative', label: 'Initiative' },
  ];
  const selectedDefinitionTypeOption = definitionTypeOptions.find((opt) => opt.id === definitionType) || definitionTypeOptions[0];

  const policyTypeOptions = [
    { id: 'all', label: 'All' },
    { id: 'custom', label: 'custom' },
    { id: 'builtin', label: 'built in' },
    { id: 'static', label: 'static' },
  ];
  const selectedPolicyTypeOption = policyTypeOptions.find((opt) => opt.id === policyType) || policyTypeOptions[0];

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (scopeControlRef.current && !scopeControlRef.current.contains(event.target)) {
        setShowScopeSelector(false);
      }
      if (definitionControlRef.current && !definitionControlRef.current.contains(event.target)) {
        setShowDefinitionSelector(false);
      }
      if (policyTypeControlRef.current && !policyTypeControlRef.current.contains(event.target)) {
        setShowPolicyTypeSelector(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const filteredRows = useMemo(() => {
    const query = normalizeKey(searchText);

    return definitionRows.filter((row) => {
      if (selectedScopeSubscriptionId !== 'all') {
        if (row.subscriptionId) {
          if (normalizeKey(row.subscriptionId) !== normalizeKey(selectedScopeSubscriptionId)) {
            return false;
          }
        } else {
          const selectedId = normalizeKey(selectedScopeSubscriptionId);
          const selectedName = normalizeKey(selectedScopeOption?.name || '');
          const rowText = normalizeKey(`${row.name} ${row.category} ${row.type} ${row.definitionType}`);
          if (!rowText.includes(selectedId) && !(selectedName && rowText.includes(selectedName))) {
            return false;
          }
        }

        if (row.hasSubscriptionGrouping && !row.subscriptionId) {
          return false;
        }
      }

      if (definitionType !== 'all' && normalizeKey(row.definitionType) !== definitionType) {
        return false;
      }

      if (policyType !== 'all' && normalizeKey(row.type) !== policyType) {
        return false;
      }

      if (!query) return true;
      return (
        normalizeKey(row.name).includes(query)
        || normalizeKey(row.type).includes(query)
        || normalizeKey(row.definitionType).includes(query)
        || normalizeKey(row.category).includes(query)
      );
    });
  }, [definitionRows, searchText, definitionType, policyType, selectedScopeSubscriptionId, selectedScopeOption]);

  return (
    <div className="page-body">
      <div className="nav-page-header">
        <h2>Policy</h2>
        <p>Policy definitions for the selected scope</p>
      </div>

      <div className="single-panel-view policy-page-wrap">
        <div className="policy-top-tabs">
          <button
            type="button"
            className="policy-tab-btn active"
          >
            Definition
          </button>
          <button
            type="button"
            className="policy-tab-btn"
            onClick={onOpenAssignmentPage}
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
                setShowPolicyTypeSelector(false);
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
                setShowPolicyTypeSelector(false);
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

          <div className="policy-scope-control" ref={policyTypeControlRef}>
            <button
              type="button"
              className="policy-chip policy-scope-btn"
              onClick={() => {
                setShowPolicyTypeSelector((prev) => !prev);
                setShowScopeSelector(false);
                setShowDefinitionSelector(false);
              }}
            >
              Policy type : <strong>{selectedPolicyTypeOption.label}</strong>
            </button>

            {showPolicyTypeSelector && (
              <div className="policy-scope-dropdown policy-definition-dropdown">
                {policyTypeOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`policy-scope-option ${policyType === option.id ? 'active' : ''}`}
                    onClick={() => {
                      setPolicyType(option.id);
                      setShowPolicyTypeSelector(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="policy-table-wrap">
          <table className="policy-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Defination type</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.type}</td>
                  <td>{row.definitionType}</td>
                  <td>{row.category}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={4} className="policy-empty-row">No definitions available for this scope.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
