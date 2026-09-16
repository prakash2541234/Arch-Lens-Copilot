import React, { useMemo, useState } from 'react';

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeKey(value = '') {
  return normalizeText(value).toLowerCase();
}

function normalizeParameters(assignment) {
  const rows = Array.isArray(assignment?.raw?.parameters)
    ? assignment.raw.parameters
    : Array.isArray(assignment?.parameters)
      ? assignment.parameters
      : [];

  return rows
    .map((item, index) => {
      const parameterId = normalizeText(item?.parameterId || item?.id || item?.name || `parameter-${index + 1}`);
      const parameterName = normalizeText(item?.parameterName || item?.displayName || item?.name || parameterId);
      const parameterValue = normalizeText(item?.parameterValue || item?.value || '-');
      const referenceType = normalizeText(
        item?.referenceType
        || item?.parameterReferenceType
        || item?.parameterType
        || item?.source
        || 'Default value'
      );

      const referenceTypeLower = normalizeKey(referenceType);
      const category = /user/.test(referenceTypeLower)
        ? 'user-defined-parameters'
        : 'default-values';

      return {
        id: `${parameterId}-${index}`,
        parameterId,
        parameterName,
        parameterValue,
        referenceType,
        category,
      };
    })
    .filter((item) => item.parameterId || item.parameterName);
}

export default function PolicyAssignmentDetail({ assignment = null, onBack = () => {} }) {
  const [searchText, setSearchText] = useState('');
  const [selectedType, setSelectedType] = useState('all-types');

  const parameterRows = useMemo(() => normalizeParameters(assignment), [assignment]);
  const totalParameters = parameterRows.length;
  const userDefinedParameters = parameterRows.filter((row) => row.category === 'user-defined-parameters').length;
  const defaultValueParameters = parameterRows.filter((row) => row.category === 'default-values').length;

  const filteredRows = useMemo(() => {
    const query = normalizeKey(searchText);

    return parameterRows.filter((row) => {
      if (selectedType !== 'all-types' && row.category !== selectedType) {
        return false;
      }

      if (!query) return true;

      return (
        normalizeKey(row.parameterId).includes(query)
        || normalizeKey(row.parameterName).includes(query)
        || normalizeKey(row.parameterValue).includes(query)
        || normalizeKey(row.referenceType).includes(query)
      );
    });
  }, [parameterRows, searchText, selectedType]);

  return (
    <div className="page-body">
      <div className="nav-page-header">
        <h2>Policy Assignment Details</h2>
        <p>{assignment?.assignmentName || 'Assignment details'}</p>
      </div>

      <div className="single-panel-view policy-detail-wrap">
        <button type="button" className="policy-back-btn" onClick={onBack}>
          ← Back to Policy
        </button>

        <div className="policy-detail-card">
          <div className="policy-detail-card-header">
            <h3>Assignment summary</h3>
          </div>
          <div className="policy-detail-meta-grid">
            <div className="policy-detail-meta-item">
              <span className="policy-detail-meta-label">Assignment name</span>
              <span className="policy-detail-meta-value">{assignment?.assignmentName || '-'}</span>
            </div>
            <div className="policy-detail-meta-item">
              <span className="policy-detail-meta-label">Scope</span>
              <span className="policy-detail-meta-value">{assignment?.scope || '-'}</span>
            </div>
            <div className="policy-detail-meta-item">
              <span className="policy-detail-meta-label">Type</span>
              <span className="policy-detail-meta-value">{assignment?.type || '-'}</span>
            </div>
          </div>
          <div className="policy-detail-stat-row">
            <div className="policy-detail-stat">
              <span className="policy-detail-stat-label">Total parameters</span>
              <strong className="policy-detail-stat-value">{totalParameters}</strong>
            </div>
            <div className="policy-detail-stat">
              <span className="policy-detail-stat-label">User defined parameters</span>
              <strong className="policy-detail-stat-value">{userDefinedParameters}</strong>
            </div>
            <div className="policy-detail-stat">
              <span className="policy-detail-stat-label">Default values</span>
              <strong className="policy-detail-stat-value">{defaultValueParameters}</strong>
            </div>
          </div>
        </div>

        <div className="policy-filter-row policy-detail-filter-row">
          <input
            className="policy-search-input"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search by parameter name"
          />
          <select
            className="policy-detail-type-select"
            value={selectedType}
            onChange={(event) => setSelectedType(event.target.value)}
          >
            <option value="all-types">All types</option>
            <option value="user-defined-parameters">User Defined Parameters</option>
            <option value="default-values">Default values</option>
          </select>
        </div>

        <div className="policy-table-wrap">
          <table className="policy-table">
            <thead>
              <tr>
                <th>Parameter ID</th>
                <th>Parameter name</th>
                <th>Parameter value</th>
                <th>Policy assignment parameter reference type</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.parameterId}</td>
                  <td>{row.parameterName}</td>
                  <td>{row.parameterValue}</td>
                  <td>{row.referenceType}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={4} className="policy-empty-row">No parameters available for this assignment.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
