/**
 * Drift Detector - Compares current vs expected architecture
 * Returns bullet-point differences for scoped resources
 */

export function detectDrift(scopedCurrentArch, scopedExpectedArch) {
  const driftPoints = [];

  if (!scopedCurrentArch || !scopedExpectedArch) {
    return driftPoints;
  }

  const currentResources = extractResourceMap(scopedCurrentArch);
  const expectedResources = extractResourceMap(scopedExpectedArch);

  // Detect missing resources (in expected but not in current)
  Object.entries(expectedResources).forEach(([resourceId, resource]) => {
    if (!currentResources[resourceId]) {
      driftPoints.push({
        type: 'missing',
        severity: 'high',
        message: `Missing: ${resource.type} (${resource.name})`,
      });
    }
  });

  // Detect extra resources (in current but not in expected)
  Object.entries(currentResources).forEach(([resourceId, resource]) => {
    if (!expectedResources[resourceId]) {
      driftPoints.push({
        type: 'extra',
        severity: 'medium',
        message: `Extra: ${resource.type} (${resource.name})`,
      });
    }
  });

  // Detect modified resources (property changes)
  Object.entries(expectedResources).forEach(([resourceId, expectedResource]) => {
    const currentResource = currentResources[resourceId];
    if (currentResource) {
      const modifications = detectResourceModifications(currentResource, expectedResource);
      modifications.forEach((mod) => {
        driftPoints.push({
          type: 'modified',
          severity: 'low',
          message: `Modified: ${expectedResource.name} - ${mod}`,
        });
      });
    }
  });

  return driftPoints;
}

function extractResourceMap(archData) {
  const resourceMap = {};

  if (!archData) return resourceMap;

  // Handle different data structures
  let categories = {};
  
  if (archData.categories) {
    categories = archData.categories;
  } else if (archData.resources) {
    // If it's already a flat resource array
    archData.resources.forEach((resource) => {
      const resourceId = resource.id || resource.name || resource.data?.id;
      resourceMap[resourceId] = {
        name: resource.name || resource.data?.name || 'Unknown',
        type: resource.type || resource.data?.type || 'Unknown',
        id: resourceId,
        properties: resource.properties || resource.data?.properties || {},
      };
    });
    return resourceMap;
  }

  // Extract from categories
  Object.values(categories).forEach((category) => {
    Object.values(category).forEach((resources) => {
      if (Array.isArray(resources)) {
        resources.forEach((resource) => {
          const resourceId = typeof resource === 'string' ? resource : resource.id || resource.name;
          const resourceName = typeof resource === 'string' ? resource : resource.name || resource.id;
          resourceMap[resourceId] = {
            name: resourceName,
            type: typeof resource === 'string' ? 'resource' : resource.type || 'Unknown',
            id: resourceId,
            properties: typeof resource === 'object' && !Array.isArray(resource) ? resource.properties || {} : {},
          };
        });
      }
    });
  });

  return resourceMap;
}

function detectResourceModifications(current, expected) {
  const modifications = [];

  // Compare key properties
  const keysToCompare = ['status', 'provisioning_state', 'tags', 'sku', 'location'];

  keysToCompare.forEach((key) => {
    const currentVal = current.properties?.[key] || current[key];
    const expectedVal = expected.properties?.[key] || expected[key];

    if (currentVal !== expectedVal && expectedVal !== undefined) {
      modifications.push(`${key} changed from "${expectedVal}" to "${currentVal}"`);
    }
  });

  return modifications;
}

/**
 * Format drift points as bullet-point string for UI/OpenAI
 */
export function formatDriftBullets(driftPoints, maxPoints = 10) {
  if (!driftPoints || driftPoints.length === 0) {
    return '• No drift detected - Current and expected architectures match';
  }

  const sorted = driftPoints.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  const points = sorted.slice(0, maxPoints).map((point) => `• ${point.message}`);

  if (sorted.length > maxPoints) {
    points.push(`• ... and ${sorted.length - maxPoints} more differences`);
  }

  return points.join('\n');
}

/**
 * Build context payload for Azure OpenAI with scoped architecture
 */
export function buildDriftContextForOpenAI(scopeName, scopeType, driftBullets, scopedArch) {
  const driftText = String(driftBullets || '').trim();
  const normalizedDrift = driftText.toLowerCase();
  const driftNotReady = normalizedDrift.includes('drift data is not ready');
  const noArchitectureData = normalizedDrift.includes('no architecture data available');
  const hasNoDriftMarker = normalizedDrift.includes('no drift detected');
  const driftReady = Boolean(driftText) && !driftNotReady && !noArchitectureData;

  return {
    scope: {
      name: scopeName,
      type: scopeType, // 'subscription' | 'resourcegroup' | 'resource'
    },
    drift: {
      isReady: driftReady,
      hasDrift: driftReady && !hasNoDriftMarker,
      points: driftReady ? driftText : '',
    },
    architecture: {
      summary: summarizeArchitecture(scopedArch),
      resourceCount: countResources(scopedArch),
    },
  };
}

function summarizeArchitecture(arch) {
  if (!arch) return 'No architecture data';

  const categories = arch.categories || {};
  const summary = [];

  Object.entries(categories).forEach(([category, resources]) => {
    const count = Object.values(resources).flat().length;
    if (count > 0) {
      summary.push(`${category}: ${count}`);
    }
  });

  return summary.join(', ') || 'Empty scope';
}

function countResources(arch) {
  if (!arch) return 0;

  const categories = arch.categories || {};
  let count = 0;

  Object.values(categories).forEach((resources) => {
    Object.values(resources).forEach((items) => {
      if (Array.isArray(items)) {
        count += items.length;
      }
    });
  });

  return count;
}
