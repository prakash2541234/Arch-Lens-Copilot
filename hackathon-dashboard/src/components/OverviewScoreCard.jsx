import React, { useMemo } from 'react';
import { RadialBarChart, RadialBar, ResponsiveContainer } from 'recharts';

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function lerp(a, b, t) {
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff;
  const ag = (ah >> 8) & 0xff;
  const ab = ah & 0xff;
  const br = (bh >> 16) & 0xff;
  const bg = (bh >> 8) & 0xff;
  const bb = bh & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const b2 = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, b2].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const DARK_RED = '#7f1d1d';
const RED = '#ef4444';
const YELLOW = '#f59e0b';
const GREEN = '#22c55e';

function getColor(value) {
  if (value < 25) return lerp(DARK_RED, RED, value / 25);
  if (value < 50) return lerp(RED, RED, (value - 25) / 25);
  if (value < 75) return lerp(RED, YELLOW, (value - 50) / 25);
  if (value < 90) return lerp(YELLOW, GREEN, (value - 75) / 15);
  return GREEN;
}

const PILLAR_KEYS = {
  security: ['security'],
  reliability: ['reliability'],
  performance: ['performanceEfficiency', 'performance_efficiency', 'performance'],
  cost: ['costOptimization', 'cost_optimization', 'cost'],
  operational: ['operationalExcellence', 'operational_excellence', 'operational'],
};

function readFirstKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const num = Number(obj[key]);
      if (Number.isFinite(num)) return num;
    }
  }
  return undefined;
}

function extractProvidedScores(data) {
  const directScoreSummary = data?.scoreSummary;
  const candidates = [
    directScoreSummary,
    data?.well_architected,
    data?.wellArchitected,
    data?.well_architected_score,
    data?.wellArchitectedScore,
    data?.data?.well_architected,
    data?.data?.wellArchitected,
    data?.data?.well_architected_score,
    data?.data?.wellArchitectedScore,
  ].filter(Boolean);

  for (const c of candidates) {
    const security = readFirstKey(c, PILLAR_KEYS.security);
    const reliability = readFirstKey(c, PILLAR_KEYS.reliability);
    const performance = readFirstKey(c, PILLAR_KEYS.performance);
    const cost = readFirstKey(c, PILLAR_KEYS.cost);
    const operational = readFirstKey(c, PILLAR_KEYS.operational);

    if ([security, reliability, performance, cost, operational].some((v) => Number.isFinite(v))) {
      const scoreItems = [
        { label: 'Cost score', value: clamp(Number.isFinite(cost) ? cost : 0), color: getColor(Number.isFinite(cost) ? cost : 0) },
        { label: 'Security score', value: clamp(Number.isFinite(security) ? security : 0), color: getColor(Number.isFinite(security) ? security : 0) },
        { label: 'Reliability score', value: clamp(Number.isFinite(reliability) ? reliability : 0), color: getColor(Number.isFinite(reliability) ? reliability : 0) },
        { label: 'Operational excellence score', value: clamp(Number.isFinite(operational) ? operational : 0), color: getColor(Number.isFinite(operational) ? operational : 0) },
        { label: 'Performance score', value: clamp(Number.isFinite(performance) ? performance : 0), color: getColor(Number.isFinite(performance) ? performance : 0) },
      ];

      const overallFromApi = readFirstKey(c, ['overall', 'overallScore', 'overall_score']);
      const overall = Number.isFinite(overallFromApi)
        ? clamp(overallFromApi)
        : clamp(scoreItems.reduce((sum, item) => sum + item.value, 0) / scoreItems.length);

      return { scoreItems, overall };
    }
  }

  return null;
}

function deriveScores(data) {
  const provided = extractProvidedScores(data);
  if (provided) return provided;

  const fallback = [
    { label: 'Cost score', value: 0, color: getColor(0) },
    { label: 'Security score', value: 0, color: getColor(0) },
    { label: 'Reliability score', value: 0, color: getColor(0) },
    { label: 'Operational excellence score', value: 0, color: getColor(0) },
    { label: 'Performance score', value: 0, color: getColor(0) },
  ];

  return { scoreItems: fallback, overall: 0 };
}

export default function OverviewScoreCard({ data, apiScoreSummary = null }) {
  const mergedData = useMemo(() => (
    apiScoreSummary ? { ...(data || {}), scoreSummary: apiScoreSummary } : data
  ), [data, apiScoreSummary]);

  const { scoreItems, overall } = useMemo(() => deriveScores(mergedData), [mergedData]);
  const overallColor = getColor(overall);
  const gaugeData = [{ value: overall, fill: overallColor }];

  return (
    <div className="score-panel">
      <h3>Well Architected Score</h3>

      <div className="overall-score">
        <div className="score-label">Well Architected Score</div>
        <ResponsiveContainer width="100%" height={110}>
          <RadialBarChart
            innerRadius="70%"
            outerRadius="100%"
            data={gaugeData}
            startAngle={180}
            endAngle={0}
          >
            <RadialBar dataKey="value" cornerRadius={6} background={{ fill: '#f3f4f6' }} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div style={{ marginTop: -30 }}>
          <span className="score-number" style={{ color: overallColor }}>{overall}</span>
          <span className="score-max"> / 100</span>
        </div>
      </div>
      <div className="score-items">
        {scoreItems.map(({ label, value, color }) => (
          <div className="score-item" key={label}>
            <span className="label">{label}</span>
            <div className="bar-wrap">
              <div className="bar-fill" style={{ width: `${value}%`, background: color }} />
            </div>
            <span className="value" style={{ color }}>{value}<span style={{ color: '#9ca3af', fontWeight: 400 }}> /100</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}