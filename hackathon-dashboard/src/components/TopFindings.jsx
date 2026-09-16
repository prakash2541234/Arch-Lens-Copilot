import React from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

function normalizeSeverity(value = 'medium') {
  const normalized = String(value || 'medium').trim().toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) return normalized;
  return 'medium';
}

function severityRank(value = 'medium') {
  const normalized = normalizeSeverity(value);
  if (normalized === 'critical') return 4;
  if (normalized === 'high') return 3;
  if (normalized === 'medium') return 2;
  return 1;
}

function normalizeFindingText(value = '') {
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

function normalizeAndDedupeApiFindings(rows) {
  if (!Array.isArray(rows)) return [];

  const grouped = new Map();

  rows.forEach((item) => {
    const text = normalizeFindingText(
      item?.text
      || item?.recommendation
      || item?.issue
      || item?.title
      || item?.finding
      || ''
    );
    if (!text) return;

    const severity = normalizeSeverity(item?.severity || item?.impact || 'medium');
    const key = text.toLowerCase();
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        text,
        severity,
      });
      return;
    }

    if (severityRank(severity) > severityRank(existing.severity)) {
      existing.severity = severity;
    }
  });

  return Array.from(grouped.values())
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function deriveFindings(data) {
  if (!data) return [];
  const findings = [];
  const subs = data.data?.subscriptions || {};

  Object.values(subs).forEach(sub => {
    const rgs = sub.resource_groups || {};
    Object.entries(rgs).forEach(([rgName, rg]) => {
      const cats = rg.categories || {};

      // Check for storage with no security
      const storages = cats.storage?.storage_accounts || [];
      const keyvaults = cats.security?.keyvaults || [];

      storages.forEach(sa => {
        findings.push({
          text: `Storage account allows public blob access`,
          severity: 'critical',
          resource: sa,
        });
      });

      // Check for compute with no NSG
      const vms = cats.compute?.virtual_machines || [];
      const nsgs = cats.networking?.network_security_groups || [];
      if (vms.length > 0 && nsgs.length === 0) {
        findings.push({
          text: `VM in ${rgName} has no Network Security Group`,
          severity: 'high',
          resource: rgName,
        });
      }

      // Function apps without App Insights
      const funcs = cats.app_services?.function_apps || [];
      const insights = cats.monitoring?.application_insights || [];
      funcs.forEach(fn => {
        if (insights.length === 0) {
          findings.push({
            text: `Function app missing Application Insights`,
            severity: 'medium',
            resource: fn,
          });
        }
      });

      // Missing keyvaults
      if ((cats.app_services?.function_apps?.length || 0) > 0 && keyvaults.length === 0) {
        findings.push({
          text: `No Key Vault configured in ${rgName}`,
          severity: 'high',
          resource: rgName,
        });
      }
    });
  });

  // Deduplicate by text and limit
  const seen = new Set();
  return findings.filter(f => {
    if (seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });
}

const severityIcon = {
  critical: <AlertCircle size={13} color="#dc2626" />,
  high: <AlertTriangle size={13} color="#d97706" />,
  medium: <Info size={13} color="#0284c7" />,
  low: <Info size={13} color="#64748b" />,
};

export default function TopFindings({ data, apiFindings = null }) {
  const findings = Array.isArray(apiFindings) && apiFindings.length
    ? normalizeAndDedupeApiFindings(apiFindings)
    : deriveFindings(data);

  return (
    <div className="bottom-panel">
      <div className="panel-header">
        <h3>Top Findings</h3>
      </div>
      <div className="bottom-panel-body">
        {findings.length === 0 ? (
          <div style={{ padding: '16px', color: '#9ca3af', fontSize: 12, textAlign: 'center' }}>
            No findings — run Discover to analyse
          </div>
        ) : (
          findings.map((f, i) => (
            <div className="finding-item" key={i}>
              {severityIcon[f.severity]}
              <span style={{ flex: 1 }}>{f.text}</span>
              <span className={`severity-badge ${f.severity}`}>
                {f.severity.charAt(0).toUpperCase() + f.severity.slice(1)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
