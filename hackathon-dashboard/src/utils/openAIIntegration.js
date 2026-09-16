/**
 * Azure OpenAI Integration for Scoped Drift Analysis
 */

// Azure OpenAI config — read from runtime config.js (window._env_)
const RUNTIME_ENV = (typeof window !== 'undefined' && window._env_) || {};

const AZURE_OAI_ENDPOINT = RUNTIME_ENV.AZURE_OAI_ENDPOINT || '';
const AZURE_OAI_KEY = RUNTIME_ENV.AZURE_OAI_KEY || '';
const AZURE_OAI_DEPLOYMENT = RUNTIME_ENV.AZURE_OAI_DEPLOYMENT || '';

/**
 * Query Azure OpenAI with scoped drift context
 * Context includes: scope name, drift points, architecture summary, user question,
 * and retrieved subscription knowledge context
 */
export async function queryDriftAnalysis(driftContext, userQuestion, retrievedContext = null) {
  if (!AZURE_OAI_ENDPOINT || !AZURE_OAI_KEY) {
    console.warn('Azure OpenAI not configured. Returning fallback response.');
    return {
      text: buildLocalDriftResponse(driftContext, userQuestion, retrievedContext),
      source: 'local',
    };
  }

  try {
    const systemPrompt = buildDriftSystemPrompt(driftContext, retrievedContext);
    const userPrompt = buildDriftUserPrompt(driftContext, userQuestion, retrievedContext);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const normalizedEndpoint = AZURE_OAI_ENDPOINT.replace(/\/$/, '').replace(/\/openai\/v1$/i, '');
    const url = `${normalizedEndpoint}/openai/deployments/${AZURE_OAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OAI_KEY,
      },
      body: JSON.stringify({
        messages,
        max_completion_tokens: 600,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Azure OpenAI error:', errorData);
      return {
        text: buildLocalDriftResponse(driftContext, userQuestion, retrievedContext),
        source: 'local',
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    return {
      text: normalizeAssistantOutput(content) || buildLocalDriftResponse(driftContext, userQuestion, retrievedContext),
      source: 'openai',
    };
  } catch (error) {
    console.error('Error calling Azure OpenAI:', error);
    return {
      text: buildLocalDriftResponse(driftContext, userQuestion, retrievedContext),
      source: 'local',
    };
  }
}

export async function queryDriftComparison({ scopeType, scopeName, currentTokens, applicationTokens }) {
  if (!AZURE_OAI_ENDPOINT || !AZURE_OAI_KEY) {
    return null;
  }

  try {
    const messages = [
      {
        role: 'system',
        content: [
          'You are an Azure architecture drift comparator.',
          'Compare token lists and return strict JSON only.',
          'Do not include markdown fences or prose.',
          'Output schema:',
          '{"currentOnly": string[], "applicationOnly": string[], "insights": string[]}',
          'Rules:',
          '- currentOnly = items present only in current tokens',
          '- applicationOnly = items present only in application tokens',
          '- Exclude generic category words from currentOnly: other, resources, app, services, appservices, keyvaults, keyvault, storage, accounts, storageaccounts',
          '- Exclude generic brand word from applicationOnly: azure',
          '- insights must be short bullet-like strings without leading bullets',
          '- Keep original token text; do not invent resources',
          '- Max 15 entries per array'
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          scopeType,
          scopeName,
          currentTokens: Array.isArray(currentTokens) ? currentTokens.slice(0, 300) : [],
          applicationTokens: Array.isArray(applicationTokens) ? applicationTokens.slice(0, 300) : [],
        }),
      },
    ];

    const normalizedEndpoint = AZURE_OAI_ENDPOINT.replace(/\/$/, '').replace(/\/openai\/v1$/i, '');
    const url = `${normalizedEndpoint}/openai/deployments/${AZURE_OAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`;

    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OAI_KEY,
      },
      body: JSON.stringify({
        messages,
        max_completion_tokens: 700,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const firstError = await response.json();
      const errorCode = String(firstError?.error?.code || '').toLowerCase();
      const errorParam = String(firstError?.error?.param || '').toLowerCase();
      const supportsRetryWithoutFormat = errorCode.includes('unsupported') || errorParam.includes('response_format');

      if (supportsRetryWithoutFormat) {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OAI_KEY,
          },
          body: JSON.stringify({
            messages,
            max_completion_tokens: 700,
          }),
        });
      } else {
        console.error('Azure OpenAI drift-compare error:', firstError);
        return null;
      }
    }

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Azure OpenAI drift-compare error:', errorData);
      return null;
    }

    const data = await response.json();
    const content = String(data.choices?.[0]?.message?.content || '').trim();
    const parsed = parseDriftComparisonPayload(content);
    if (!parsed || typeof parsed !== 'object') return null;

    const currentOnly = Array.isArray(parsed.currentOnly)
      ? parsed.currentOnly.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 15)
      : [];
    const applicationOnly = Array.isArray(parsed.applicationOnly)
      ? parsed.applicationOnly.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 15)
      : [];
    const insights = Array.isArray(parsed.insights)
      ? parsed.insights.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8)
      : [];

    return {
      currentOnly,
      applicationOnly,
      insights,
      source: 'openai',
    };
  } catch (error) {
    console.error('Error calling Azure OpenAI drift comparison:', error);
    return null;
  }
}

/**
 * Ask Azure OpenAI to estimate the monthly cost and next-month forecast for a
 * list of Azure resources (typically the "current-only" drift differences).
 * Returns { items: [{ name, monthlyCost, currency }], total, forecast, currency, notes, source }
 * or null when OpenAI is unavailable so callers can fall back to a local heuristic.
 */
export async function queryResourceCostEstimate({ scopeType, scopeName, region, resources }) {
  const resourceList = Array.isArray(resources)
    ? resources.map((r) => String(r || '').trim()).filter(Boolean).slice(0, 40)
    : [];

  if (!resourceList.length) {
    return null;
  }

  if (!AZURE_OAI_ENDPOINT || !AZURE_OAI_KEY) {
    return buildLocalResourceCostEstimate(resourceList, 'Azure OpenAI not configured');
  }

  try {
    const messages = [
      {
        role: 'system',
        content: [
          'You are an Azure cloud cost estimation expert.',
          'Given a list of Azure resource names/identifiers, infer the most likely Azure service for each',
          'and estimate a realistic average MONTHLY cost in USD based on typical default SKUs and pay-as-you-go pricing.',
          'Also provide a next-month FORECAST that accounts for typical growth/usage trends.',
          'Return strict JSON only. No markdown fences, no prose.',
          'Output schema:',
          '{"items":[{"name":string,"service":string,"monthlyCost":number}],"forecast":number,"currency":"USD","notes":string[]}',
          'Rules:',
          '- monthlyCost is a non-negative number in USD (no currency symbols)',
          '- Infer service type from the name (e.g. "vm"=Virtual Machine, "st"/"storage"=Storage Account, "sql"=SQL DB, "appsvc"/"web"=App Service, "aks"=AKS, "kv"/"vault"=Key Vault, "vnet"/"subnet"=Networking, "openai"/"cognitive"=Azure OpenAI)',
          '- Pure container names (resource groups like "rg-*", subscriptions like "sub-*") have monthlyCost 0',
          '- forecast = estimated total for next month across all items (usually slightly above current total)',
          '- notes: max 3 short strings explaining key cost drivers or assumptions',
          '- Keep original resource name text in "name"',
          '- Do not invent resources not in the input list',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          scopeType: scopeType || 'subscription',
          scopeName: scopeName || '',
          region: region || 'eastus',
          resources: resourceList,
        }),
      },
    ];

    const normalizedEndpoint = AZURE_OAI_ENDPOINT.replace(/\/$/, '').replace(/\/openai\/v1$/i, '');
    const url = `${normalizedEndpoint}/openai/deployments/${AZURE_OAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`;

    const payload = {
      messages,
      max_completion_tokens: 900,
      response_format: { type: 'json_object' },
    };

    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OAI_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const firstError = await response.json().catch(() => ({}));
      const errorCode = String(firstError?.error?.code || '').toLowerCase();
      const errorParam = String(firstError?.error?.param || '').toLowerCase();
      const retryWithoutFormat = errorCode.includes('unsupported') || errorParam.includes('response_format');

      if (retryWithoutFormat) {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OAI_KEY,
          },
          body: JSON.stringify({ messages, max_completion_tokens: 900 }),
        });
      } else {
        console.error('Azure OpenAI cost-estimate error:', firstError);
        return buildLocalResourceCostEstimate(resourceList, 'Azure OpenAI HTTP error');
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Azure OpenAI cost-estimate error:', errorData);
      return buildLocalResourceCostEstimate(resourceList, 'Azure OpenAI HTTP error');
    }

    const data = await response.json();
    const content = String(data.choices?.[0]?.message?.content || '').trim();
    const parsed = parseJsonObjectFromText(content);
    if (!parsed || typeof parsed !== 'object') {
      return buildLocalResourceCostEstimate(resourceList, 'Invalid Azure OpenAI response payload');
    }

    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item) => ({
            name: String(item?.name || '').trim(),
            service: String(item?.service || '').trim(),
            monthlyCost: Math.max(0, Math.round(Number(item?.monthlyCost ?? item?.cost ?? 0))),
          }))
          .filter((item) => item.name)
      : [];

    if (!items.length) {
      return buildLocalResourceCostEstimate(resourceList, 'Empty Azure OpenAI cost items');
    }

    const total = items.reduce((sum, item) => sum + item.monthlyCost, 0);
    const forecastRaw = Number(parsed.forecast);
    const forecast = Number.isFinite(forecastRaw) && forecastRaw > 0
      ? Math.round(forecastRaw)
      : Math.round(total * 1.1);
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 3)
      : [];

    return {
      items,
      total,
      forecast,
      currency: String(parsed.currency || 'USD'),
      notes,
      source: 'openai',
    };
  } catch (error) {
    console.error('Error calling Azure OpenAI cost estimate:', error);
    return buildLocalResourceCostEstimate(resourceList, 'Network/API failure while calling Azure OpenAI');
  }
}

function buildLocalResourceCostEstimate(resourceList, reason = '') {
  const items = resourceList
    .map((resourceName) => {
      const inferred = inferResourceCostHeuristic(resourceName);
      return {
        name: resourceName,
        service: inferred.service,
        monthlyCost: inferred.monthlyCost,
      };
    })
    .filter((item) => item.name);

  if (!items.length) {
    return null;
  }

  const total = items.reduce((sum, item) => sum + Number(item.monthlyCost || 0), 0);
  const forecast = Math.max(0, Math.round(total * 1.08));

  const notes = [
    'Estimated locally using resource-name heuristics because live Azure OpenAI cost estimate was unavailable.',
    'Values are directional and should be validated against Cost Management exports.',
  ];

  if (reason) {
    notes.push(`Fallback reason: ${reason}`);
  }

  return {
    items,
    total,
    forecast,
    currency: 'USD',
    notes: notes.slice(0, 3),
    source: 'local',
  };
}

function inferResourceCostHeuristic(resourceName) {
  const raw = String(resourceName || '').trim();
  const name = raw.toLowerCase();

  if (!name) {
    return { service: 'Unknown', monthlyCost: 0 };
  }

  if (/^rg[-_]/.test(name) || /^sub[-_]/.test(name) || name.includes('resourcegroup')) {
    return { service: 'Container (Resource Group/Subscription)', monthlyCost: 0 };
  }

  if (/\b(vm|virtual[-_ ]?machine|aks|kubernetes|nodepool|appsvcplan|app[-_]?service[-_]?plan)\b/.test(name)) {
    return { service: 'Compute', monthlyCost: 120 };
  }

  if (/\b(sql|postgres|mysql|cosmos|mongo|maria|database|db)\b/.test(name)) {
    return { service: 'Database', monthlyCost: 95 };
  }

  if (/\b(storage|stg|blob|file|queue|table|disk)\b/.test(name)) {
    return { service: 'Storage', monthlyCost: 25 };
  }

  if (/\b(function|func|logic|web|api|appsvc|containerapp)\b/.test(name)) {
    return { service: 'App Service / Serverless', monthlyCost: 40 };
  }

  if (/\b(vnet|subnet|nsg|lb|gateway|firewall|dns|private[-_]?endpoint|nat)\b/.test(name)) {
    return { service: 'Networking', monthlyCost: 18 };
  }

  if (/\b(keyvault|kv|vault|security|defender|sentinel)\b/.test(name)) {
    return { service: 'Security', monthlyCost: 12 };
  }

  if (/\b(openai|cognitive|ai|ml|machinelearning)\b/.test(name)) {
    return { service: 'AI Service', monthlyCost: 80 };
  }

  return { service: 'General Azure Service', monthlyCost: 20 };
}

export async function queryResourceTokensFromImage({ imageDataUrl, scopeName }) {
  if (!AZURE_OAI_ENDPOINT || !AZURE_OAI_KEY || !imageDataUrl) {
    return [];
  }

  try {
    const messages = [
      {
        role: 'system',
        content: [
          'You are an Azure architecture diagram parser.',
          'Extract only likely Azure resource identifiers/names visible in the image.',
          'Return strict JSON only with schema: {"tokens": string[]}.',
          'Rules:',
          '- Keep tokens short and meaningful (service/resource names)',
          '- Exclude generic words (text, image, svg, not, cannot, display, azure, microsoft)',
          '- Exclude random IDs/hashes and connector labels',
          '- Lowercase output tokens',
          '- Max 120 tokens',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Scope: ${scopeName || 'subscription'}. Extract resource tokens from this architecture image.`,
          },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
            },
          },
        ],
      },
    ];

    const normalizedEndpoint = AZURE_OAI_ENDPOINT.replace(/\/$/, '').replace(/\/openai\/v1$/i, '');
    const url = `${normalizedEndpoint}/openai/deployments/${AZURE_OAI_DEPLOYMENT}/chat/completions?api-version=2024-02-01`;

    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OAI_KEY,
      },
      body: JSON.stringify({
        messages,
        max_completion_tokens: 800,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const firstError = await response.json().catch(() => ({}));
      const errorCode = String(firstError?.error?.code || '').toLowerCase();
      const errorParam = String(firstError?.error?.param || '').toLowerCase();
      const retryWithoutFormat = errorCode.includes('unsupported') || errorParam.includes('response_format');

      if (retryWithoutFormat) {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OAI_KEY,
          },
          body: JSON.stringify({
            messages,
            max_completion_tokens: 800,
          }),
        });
      } else {
        console.error('Azure OpenAI image-token error:', firstError);
        return [];
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Azure OpenAI image-token error:', errorData);
      return [];
    }

    const data = await response.json();
    const content = String(data.choices?.[0]?.message?.content || '').trim();
    const parsed = parseJsonObjectFromText(content);
    if (!parsed || !Array.isArray(parsed.tokens)) {
      return [];
    }

    const STOP_WORDS = new Set(['text', 'not', 'svg', 'cannot', 'display', 'image', 'azure', 'microsoft']);

    return parsed.tokens
      .map((token) => String(token || '').trim().toLowerCase())
      .filter((token) => token.length >= 3 && token.length <= 64)
      .filter((token) => /[a-z]/.test(token))
      .filter((token) => !STOP_WORDS.has(token))
      .filter((token) => !/^mx[-_]/.test(token))
      .filter((token) => !/^ge[-_]/.test(token))
      .filter((token) => !/^[a-f0-9]{12,}$/.test(token))
      .slice(0, 120);
  } catch (error) {
    console.error('Error calling Azure OpenAI image-token extraction:', error);
    return [];
  }
}

/*
 * Build system prompt with architecture analysis context
 */       
function buildDriftSystemPrompt(driftContext, retrievedContext = null) {
  const { scope, architecture } = driftContext;
  const intent = detectQuestionIntent(driftContext?.question);
  if (isGreetingMessage(driftContext?.question)) {
    return `You are Arch-Lens Copilot, a friendly Azure architecture assistant.

Behavior:
- If the user sends a greeting, respond warmly and naturally.
- Ask one short follow-up question to guide the user.
- Offer help areas: architecture drift, cost analysis, and security analysis.
- Keep tone conversational and concise.
- Do not force bullet points unless the user asks for bullets.`;
  }

  return `You are an Azure Infrastructure Expert that can help with security analysis, cost analysis, and drift analysis.

Current Scope: ${scope.type} "${scope.name}"
Resource Summary: ${architecture.summary}
Total Resources in Scope: ${architecture.resourceCount}

User Intent: ${intent}

Instructions:
- If user intent is "drift", focus on drift comparison and remediation.
- If user intent is "security", provide security-risk assessment and mitigation steps from available scope data.
- If user intent is "cost", provide cost and optimization guidance from available scope data.
- If drift data is not ready, mention that ONLY when user intent is "drift".
- Do not block security/cost guidance just because drift data is unavailable.
- Ground your answer primarily in the provided "Retrieved Scope Context".
- If a source named "scopeFacts" is present, treat it as deterministic facts from scoped data.
- When "scopeFacts.exactMetrics" provides counts (resourceGroupCount/resourceCount/subscriptionCount), use those exact numbers directly.
- For per-resource-group questions, use "scopeFacts.resourceCountsByGroup", "scopeFacts.resourcesByGroup", and "scopeFacts.resourceGroupsDetailed" as the source of truth.
- If the requested resource group exists in those fields, return exact counts and exact resource names from those fields.
- When "scopeFacts.cost" provides dimension totals or top costs, report those exact values and do not use wording like "at least" for those values.
- If a needed fact is missing in provided context, explicitly say that instead of inventing numbers.
- Include only the data explicitly requested by the user when that data exists in context.
- If the requested data is unavailable, state that briefly and do not add unrelated details, assumptions, or recommendations.
- Do not add extra context (such as other resources, architecture notes, or remediation steps) unless the user asked for it.
- Mention key source names from context when giving important conclusions.

Response style:
- Be conversational and helpful, like a real assistant.
- Use natural paragraphs by default.
- Use bullets only when the user asks for a list.
- Keep responses concise and business-friendly.
- Stay focused on the current scope.

Retrieved Context Metadata:
- Source count: ${Number(retrievedContext?.sourceCount || 0)}
- Selected sources: ${(Array.isArray(retrievedContext?.selectedSources) && retrievedContext.selectedSources.length)
  ? retrievedContext.selectedSources.join(', ')
  : 'none'}`;
}

/**
 * Build user prompt with detected drift and question
 */
function buildDriftUserPrompt(driftContext, userQuestion, retrievedContext = null) {
  const { scope, drift } = driftContext;
  const question = String(userQuestion || '').trim();
  const intent = detectQuestionIntent(question);
  const driftReady = Boolean(drift?.isReady);

  if (isGreetingMessage(question)) {
    return `User message: ${question}

Respond as a friendly assistant greeting. Mention you can help with:
- Architecture drift analysis
- Cost analysis
- Security analysis

Ask what the user wants to check first for the current scope (${scope.type} "${scope.name}").`;
  }

  let prompt = `Analysis Request for ${scope.type} "${scope.name}":\n\n`;
  prompt += `Detected user intent: ${intent}\n\n`;

  if (intent === 'drift' && driftReady && drift.hasDrift) {
    prompt += `Detected Drift Points:\n${drift.points}\n\n`;
  } else if (intent === 'drift' && driftReady && !drift.hasDrift) {
    prompt += `Status: No drift detected - Architecture is as expected\n\n`;
  } else if (intent === 'drift' && !driftReady) {
    prompt += `Status: Drift data is not ready for this scope yet.\n\n`;
  } else {
    prompt += `Use available scope summary/resource context to answer, even if drift data is not ready.\n\n`;
  }

  if (question) {
    prompt += `User Question: ${question}\n\n`;
    const contextText = String(retrievedContext?.contextText || '').trim();
    if (contextText) {
      prompt += `Retrieved Scope Context (prioritized JSON excerpts):\n${contextText}\n\n`;
    }
    prompt += `Please answer clearly in conversational style. Use only the requested data available in retrieved context. If requested data is unavailable, say that briefly and stop without adding unrelated details.`;
  } else {
    prompt += `Please provide concise findings, impact, and remediation next steps.`;
  }

  return prompt;
}

/**
 * Fallback response when Azure OpenAI is unavailable
 */
function buildLocalDriftResponse(driftContext, userQuestion, retrievedContext = null) {
  const { scope, drift, architecture } = driftContext;
  const question = String(userQuestion || '').trim();
  const intent = detectQuestionIntent(question);
  const driftReady = Boolean(drift?.isReady);

  if (isGreetingMessage(question)) {
    return `Hi! I can help you with architecture drift, cost analysis, and security analysis for ${scope.type} "${scope.name}". What would you like to check first?`;
  }

  const lines = [`Scoped analysis for ${scope.type} "${scope.name}" is ready.`];

  if (intent === 'security') {
    lines.push('I can assess likely security risks from the current scope context and recommend remediation.');
    lines.push(`Scope summary: ${architecture.summary}.`);
    lines.push('Review identity access, public exposure, encryption, and logging coverage for these scoped resources.');
    lines.push('If you want, I can prioritize the top risks and provide step-by-step fixes.');
    lines.push('Note: This is based on available scope context and not a full Defender/Policy export.');
    return lines.slice(0, 8).join('\n');
  }

  if (intent === 'cost') {
    lines.push('I can provide cost insights and optimization actions from the current scoped resource context.');
    lines.push(`Scope summary: ${architecture.summary}.`);
    lines.push('Focus on idle compute, overprovisioned SKUs, unattached disks, and underused premium tiers.');
    lines.push('If you share target constraints, I can suggest prioritized cost actions with impact estimates.');
    return lines.slice(0, 8).join('\n');
  }

  if (intent === 'drift' && !driftReady) {
    lines.push('Drift data is not ready yet, so I cannot perform a drift comparison right now.');
    lines.push(`Scope summary: ${architecture.summary}.`);
    lines.push('Run discovery and load the expected architecture, then ask for drift comparison again.');
    return lines.slice(0, 8).join('\n');
  }

  if (driftReady && drift.hasDrift) {
    lines.push('Drift is detected between current and expected architecture.');
    lines.push(`Scope summary: ${architecture.summary}.`);
    lines.push(`Impact: ${architecture.resourceCount} resources in this scope may be affected.`);
    lines.push('Suggested next steps: review recent manual changes, then reconcile IaC templates with current resource state.');
  } else {
    lines.push('No drift is currently detected in the selected scope.');
    lines.push(`Scope summary: ${architecture.summary}.`);
    lines.push(`Impact: ${architecture.resourceCount} resources appear aligned with expected architecture.`);
    lines.push('Next step: continue periodic drift checks to maintain compliance and stability.');
  }

  if (question) {
    const selectedSources = Array.isArray(retrievedContext?.selectedSources)
      ? retrievedContext.selectedSources.filter(Boolean).join(', ')
      : '';
    if (selectedSources) {
      lines.push(`Context sources considered: ${selectedSources}.`);
    }
    lines.push('Note: Azure OpenAI is currently unavailable, so this response is generated from local scope data.');
  }

  return lines.slice(0, 8).join('\n');
}

function normalizeAssistantOutput(content) {
  const raw = String(content || '').trim();
  if (!raw) return '';

  return raw
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isGreetingMessage(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  return /^(hi|hii|hiii|hello|hey|hai|hola|good\s*(morning|afternoon|evening)|greetings)\b[\s!,.?]*$/i.test(text);
}

function detectQuestionIntent(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return 'general';

  const driftPattern = /\b(drift|compare|difference|mismatch|deviation|expected\s+architecture|actual\s+architecture|current\s+only|application\s+only)\b/i;
  const securityPattern = /\b(security|risk|vulnerability|defender|policy|mfa|rbac|identity|access|nsg|firewall|encryption|compliance)\b/i;
  const costPattern = /\b(cost|pricing|spend|budget|optimization|savings|forecast|billing|estimate)\b/i;

  if (driftPattern.test(text)) return 'drift';
  if (securityPattern.test(text)) return 'security';
  if (costPattern.test(text)) return 'cost';
  return 'general';
}

function parseJsonObjectFromText(text) {
  const value = String(text || '').trim();
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    const fencedMatch = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1]);
      } catch {
      }
    }

    const firstBrace = value.indexOf('{');
    const lastBrace = value.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const slice = value.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(slice);
      } catch {
      }
    }
  }

  return null;
}

function parseDriftComparisonPayload(content) {
  const fromJson = parseJsonObjectFromText(content);
  if (fromJson && typeof fromJson === 'object') {
    return fromJson;
  }

  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const currentOnly = [];
  const applicationOnly = [];
  const insights = [];

  lines.forEach((line) => {
    const normalized = line.replace(/^[-*•]\s*/, '').trim();
    const currentMatch = normalized.match(/^current[- ]only\s*[:-]\s*(.+)$/i);
    const appMatch = normalized.match(/^application[- ]only\s*[:-]\s*(.+)$/i);
    const insightMatch = normalized.match(/^insight\s*[:-]\s*(.+)$/i);

    if (currentMatch?.[1]) {
      currentOnly.push(currentMatch[1].trim());
      return;
    }
    if (appMatch?.[1]) {
      applicationOnly.push(appMatch[1].trim());
      return;
    }
    if (insightMatch?.[1]) {
      insights.push(insightMatch[1].trim());
    }
  });

  if (!currentOnly.length && !applicationOnly.length && !insights.length) {
    return null;
  }

  return {
    currentOnly,
    applicationOnly,
    insights,
  };
}

/**
 * Validate Azure OpenAI configuration
 */
export function isAzureOpenAIConfigured() {
  return !!(AZURE_OAI_ENDPOINT && AZURE_OAI_KEY && AZURE_OAI_DEPLOYMENT);
}

/**
 * Get configuration status for debugging
 */
export function getOpenAIConfigStatus() {
  return {
    endpoint: AZURE_OAI_ENDPOINT ? '✓ Configured' : '✗ Missing',
    key: AZURE_OAI_KEY ? '✓ Configured' : '✗ Missing',
    deployment: AZURE_OAI_DEPLOYMENT ? AZURE_OAI_DEPLOYMENT : '✗ Missing',
    configured: isAzureOpenAIConfigured(),
  };
}
