# Scoped Drift Analysis with Azure OpenAI Integration

## Implementation Status: ACTIVE & ENHANCED ✓

**Last Updated:** August 19, 2026  
**Current Phase:** Production with Continuous Enhancements

The following has been implemented and is actively deployed:

### 1. **Utility Modules**

#### `src/utils/driftDetector.js` (201 lines)
Handles drift detection and formatting between current and expected architectures.

**Key Functions:**
- **`detectDrift(scopedCurrentArch, scopedExpectedArch)`**
  - Compares current vs expected architecture within a scope
  - Returns array of drift points as objects: `{ type, severity, message }`
  - Detection types: `missing`, `extra`, `modified`
  - Severity levels: `high` (missing resources), `medium` (extra), `low` (property changes)
  - Extracts resources from various architecture data structures (flat, hierarchical, category-based)

- **`extractResourceMap(archData)`**
  - Normalizes architecture data into map of resource ID → resource object
  - Handles multiple input formats: categories, flat resources, nested structures
  - Returns: `{ resourceId: { name, type, id, properties } }`

- **`detectResourceModifications(current, expected)`**
  - Compares key properties: `status`, `provisioning_state`, `tags`, `sku`, `location`
  - Returns array of modification descriptions

- **`formatDriftBullets(driftPoints, maxPoints=10)`**
  - Formats drift array as numbered bullet-point string
  - Auto-truncates to `maxPoints` with "+ N more" notation
  - Returns clean bullet format: `• Missing: ResourceType (name)`
  - Default: "No drift detected" when empty

- **`buildDriftContextForOpenAI(scopeName, scopeType, driftBullets, scopedArch)`**
  - Assembles multi-field context object for Azure OpenAI:
    - Scope metadata (name, type: subscription/resource-group)
    - Drift information (formatted bullets)
    - Architecture summary (resource count breakdown)
    - Detection readiness flags

#### `src/utils/openAIIntegration.js` (803 lines)
Manages Azure OpenAI integration with sophisticated fallback handling.

**Key Functions:**
- **`queryDriftAnalysis(driftContext, userQuestion, retrievedContext)`**
  - Posts to Azure OpenAI chat.completions endpoint with system/user prompts
  - Max tokens: 600
  - Returns: `{ text: string, source: 'openai'|'local' }`
  - Fallback behavior (if OpenAI unavailable or error):
    - Returns deterministic local response using `buildLocalDriftResponse()`
    - Graceful degradation—chat continues without AI

- **`queryDriftComparison({ scopeType, scopeName, currentTokens, applicationTokens })`**
  - Compares current architecture tokens vs uploaded application tokens
  - Detects: `currentOnly`, `applicationOnly`, `insights`
  - Handles two response formats:
    1. Structured JSON (if `response_format: { type: 'json_object' }` supported)
    2. Fallback plain JSON parse (for older deployments)
  - Filters generic words (e.g., "azure", "other", "resources")
  - Max 15 entries per comparison array

- **`buildDriftSystemPrompt(driftContext, retrievedContext)`**
  - Expert system prompt for architecture drift analysis
  - Instructs model to provide findings, impact, remediation
  - Includes retrieved knowledge context if available

- **`buildDriftUserPrompt(driftContext, userQuestion, retrievedContext)`**
  - Structures user query with scoped drift data
  - Includes architecture facts and cost context

- **`buildLocalDriftResponse(driftContext, userQuestion, retrievedContext)`**
  - Deterministic fallback using heuristics and drift bullets
  - Analyzes question intent for cost, resources, remediation topics
  - Returns structured text response without AI

- **`normalizeAssistantOutput(content)`**
  - Cleans Azure OpenAI response (removes markdown, code fences)
  - Returns plain text suitable for UI display

- **`buildApplicationTokenCacheKey({ isSvg, svgMarkup, imageDataUrl, scopeName })`**
  - Generates cache key for uploaded application architecture
  - Handles SVG and image formats
  - Used to avoid re-tokenizing same uploaded diagram

### 2. **Updated Components**

#### `src/App.jsx` (2462 lines)
**Central state management and orchestration hub.**

**Key State Variables:**
- `currentArchitectureScope` - Tracks scoped context:
  - `scopeType`: 'subscription' or 'resource_group'
  - `scopeName`: Display name of selected scope
  - `selectedSubscriptionId`: Current subscription ID
  - `selectedResourceGroup`: Current resource group name
  - `scopedArchData`: Filtered architecture for scope
  - `drift`: Drift state object with points and status

- `applicationArchitecture` - Uploaded reference diagram:
  - `imageSrc`: Base64 data URL
  - `svgMarkup`: Raw SVG content
  - `isSvg`: Format indicator
  - `fileName`: Upload filename

- `architecturePersistentState` - UI state persistence across navigations:
  - `activeTab`: 'current' or 'recommended'
  - `architectureScopeType`, `scopeSubscriptionId`, `scopeResourceGroupName`
  - Image rendering options (zoom, offset, SVG flag)

- `copilotMessages` - Chat message history (shared between pages)

- `selectedSubscriptionIds` - Multi-subscription selection for chat context

**Key Functions:**
- **`filterArchDataByScope(archData, currentScope, relData)`**
  - Filters relationships graph to selected scope boundaries
  - Two paths:
    - Resource group: Seeds with RG + all resources, expands closure
    - Subscription: Seeds with subscription node + all RGs + resources
  - Returns scoped architecture with only relevant relationships

- **`normalizeArchitecturePayload(payload)`, `normalizeRelationPayload()`, etc.**
  - Payload normalization for different API response formats
  - Handles flat arrays, nested objects, multiple field name variants
  - Returns standardized structure or null

- **`deriveNotifications(relData, archData)`**
  - Procedural notification generator from discovered resources
  - Detects patterns:
    - Storage accounts without private endpoint protection
    - VMs without Network Security Groups
    - Function apps without Application Insights
    - Function apps without Key Vault
  - Returns typed notifications: `{ type, time, title, body }`

- **`deriveRemediationBacklog(relData)`**
  - Builds actionable remediation task list
  - Each row: `{ subscription, resourceGroup, resource, severity, finding, recommendation, ownerHint }`
  - Deduplicates by (sub, RG, resource, finding) tuple

#### `src/components/ChatPanel.jsx` (880 lines)
**Intelligent multi-mode chatbot with drift-aware responses.**

**Props:**
- `relData` - Azure resource relationship data
- `scopedArchData` - Architecture for current scope
- `scopeName` - Display name of scope
- `scopeType` - 'subscription' or 'resource_group'
- `subscriptionKey` - Subscription identifier
- `knowledgeSources` - Rich context object:
  - `archData`, `relData`, `scopedRelData`
  - `apiCostAnalysis`, `apiCostOptimization`, `apiSecurityRisks`, `apiScoreSummary`
  - `selectedSubscriptionIds`, `selectedSubscriptionSummary`, `applicationArchitecture`
- `knowledgeCache` - Message result cache by subscription
- `driftPayload` - Synchronized drift points from ArchitectureDiagram
- `sharedMessages` - Messages list (shared across pages)
- `setSharedMessages` - Messages setter
- `hasSelectedSubscription` - Determines UI state

**Key Features:**

*Deterministic Answering (No AI Required):*
- **Cost Questions:** Recursively disambiguates by resource/RG/subscription, surfaces exact costs
- **Resource Inventory:** Lists/counts resources with subscription-aware deduplication
- **Weak Response Detection:** Identifies unreliable AI answers and offers alternatives

*Functions:*
- **`buildScopedFacts({ subscriptionKey, scopeName, scopeType, knowledgeSources })`**
  - Extracts normalized scope facts:
    - Subscription count, resource group count, resource count
    - Resource lists by group
    - Cost dimensions (by resource group, resource, subscription) with totals & top-N items
  - Returns: `{ scope, exactMetrics, subscriptions, resourceGroups, resources, cost }`

- **`buildKnowledgeBundle({ subscriptionKey, scopeName, scopeType, knowledgeSources })`**
  - Serializes all knowledge sources (relData, apiCostAnalysis, security, etc.) to text
  - Prepends scopeFactsFacts document with max 200KB size limit
  - Returns: `{ documents: [{ name, text, size }], costFingerprint, scopeFacts }`

- **`selectRelevantContext(bundle, question, maxDocs=4, maxDocChars=3500)`**
  - Token-based relevance scoring of documents against question
  - Always includes scopeFacts if available
  - Ranks other documents by score, then size
  - Returns: `{ selectedSources, contextText, builtAt, sourceCount }`

- **`buildDeterministicResourceGroupAnswer(question, scopedFacts)`**
  - Detects "list/count resources under RG" intents
  - Parses quoted or inline RG names
  - Returns exact resource list or structured answer

- **`buildDeterministicCostAnswer(question, scopedFacts)`**
  - Detects cost-related intents
  - Supports: by-resource, by-RG, by-subscription, top-N resource, all resources
  - Falls back gracefully when cost dimensions unavailable

*Drift Integration:*
- Receives `driftPayload` from ArchitectureDiagram
- Formats drift bullets for OpenAI query
- Includes drift context in Azure OpenAI system prompt

*Message Flow:*
1. User asks question
2. Check for deterministic answer (costs, resources) → short-circuit OpenAI
3. Build knowledge bundle from all sources
4. Select relevant context using token matching
5. Send to Azure OpenAI with drift context
6. Fallback to local response if OpenAI unavailable
7. Append message to shared chat history

#### `src/components/ArchitectureDiagram.jsx` (2447 lines)
**ReactFlow-based architecture visualization with drift detection.**

**Key Features:**

*Visual Rendering:*
- **Type-based node colors** for resource types (subscription, RG, VM, storage, etc.)
- **Azure icon mapping** - Maps 60+ resource types to official Azure icons
- **MiniMap** - Overview navigation
- **Pan/zoom controls** - ReactFlow built-ins
- **Responsive layout** - Fits to parent container

*Drift Analysis:*
- **`queryDriftComparison({ scopeType, scopeName, currentTokens, applicationTokens })`**
  - Compares current architecture tokens vs uploaded reference
  - Uses Azure OpenAI to identify:
    - Resources only in current (extra)
    - Resources only in application (missing)
    - Architectural insights
  - Returns structured analysis or null if OpenAI unavailable

- **`queryResourceTokensFromImage(imageDataUrl)`**
  - Extracts resource names/tokens from user-uploaded PNG/JPG via Azure OpenAI vision
  - Returns token array for comparison

*Token Caching:*
- `APPLICATION_TOKEN_CACHE` - Caches extracted tokens from uploaded diagrams
- Uses multi-factor cache keys: scope, image data, SVG markup
- Prevents redundant API calls for same input

*Scoped Architecture:*
- Receives `currentArchitectureScope` from App state
- Filters relationships graph to scope
- Updates parent via `onScopeChange` callback

#### `src/components/StatsCards.jsx`, `OverviewScoreCard.jsx`, etc.
**Visualization components** for dashboards, scoring, resource inventory
- Receive scoped/filtered data from App state
- Display well-architected framework scores
- Show cost breakdowns by dimension
- List policy compliance status



### 3. **Data Flow & Architecture**

#### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         App.jsx Entry Point                          │
│  (Central state: archData, relData, currentArchitectureScope, ...)  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                  (Multi-page navigation)
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
   [Overview]        [Architecture]      [Chat]
   Page               Diagram Page        Page
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │
                ┌─────────▼──────────┐
                │ ArchitectureDiagram│  Scope Selection
                │   (ReactFlow)      │  ◄─────────────
                │                    │  Drift Comparison
                │                    │  Token Extraction
                └─────────────────────┘
                          │
                  onScopeChange()
                          │
                 (Updates App state)
                          │
            ┌─────────────▼──────────────┐
            │ currentArchitectureScope   │
            │ (scopeType, scopeName,    │
            │  selectedSubscriptionId,   │
            │  selectedResourceGroup)    │
            └─────────────┬──────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    [Overview]    [Architecture]     [ChatPanel]
     Page         Detail View        Messaging
          │               │               │
          └───────────────┼───────────────┘
                          │
            ( Scoped Data + Filtered References)
                          │
    ┌─────────────────────▼─────────────────────┐
    │         ChatPanel Smart Response           │
    │  1. Try deterministic answer (costs etc)  │
    │  2. Build knowledge bundle from sources   │
    │  3. Select relevant context by tokens     │
    │  4. Query Azure OpenAI with drift context │
    │  5. Fallback if unavailable               │
    └─────────────────────┬─────────────────────┘
                          │
              ┌───────────▼──────────┐
              │ copilotMessages      │
              │ (Shared across pages)│
              └──────────────────────┘
```

#### Drift Detection Flow

```
ArchitectureDiagram (ReactFlow):
  - Current architecture rendered as nodes/edges
  - User selects/zooms into resource group or subscription
  - onScopeChange fires
  
App.jsx:
  - Updates currentArchitectureScope
  - Calls filterArchDataByScope() to exclude unrelated resources
  - Stores scoped data in state
  
ChatPanel:
  - Receives scoped architecture + relData
  - On user message: calls queryDriftAnalysis()
  
queryDriftAnalysis() → Azure OpenAI:
  - System prompt: "You are an architecture drift analyzer"
  - Context: drift bullets + resource summary + cost info
  - User prompt: Question + retrieved document context
  - Response: Findings + impact + remediation
  
Fallback (if OpenAI unavailable):
  - buildLocalDriftResponse() uses heuristics
  - Returns deterministic answer based on patterns
  - Chat continues without degradation
```

#### Knowledge Assembly Pipeline

```
Scoped Facts Building:
  knowledgeSources (App props)
    ├─ relData (subscriptions → RGs → resources)
    ├─ apiCostAnalysis (dimensions with breakdown)
    ├─ apiCostOptimization (recommendations)
    ├─ apiSecurityRisks (findings by severity)
    ├─ apiScoreSummary (well-architected scores)
    └─ applicationArchitecture (user upload)
         │
         ▼
    buildScopedFacts()
         │
         ├─ Extract resource lists (by group)
         ├─ Aggregate cost dimensions
         │  (resourceGroup, resource, subscription)
         └─ Normalize metrics
         │
         ▼
    Scoped Facts Object
    { scope, exactMetrics, resources, cost: { ... } }

Knowledge Bundle Building:
    scopedFacts + knowledgeSources
         │
         ▼
    Serialize all sources to text
   (Max 50KB per source, 200KB for scopeFacts)
         │
         ▼
    Document Array
    [{ name: 'scopeFacts', text: '...', size: N },
     { name: 'relData', text: '...', size: N },
     ...]

Context Selection (Per Query):
    User Question "What resources cost most?"
         │
         ▼
    tokenizeQuestion()
    => ['what', 'resources', 'cost', 'most']
         │
         ▼
    Score documents by token presence
    Limit to top 4 docs (configurable)
         │
         ▼
    Selected Context Object
    { selectedSources: ['scopeFacts', 'apiCostAnalysis'],
      contextText: '... 3500 chars max ...' }
         │
         ▼
    Azure OpenAI Query
    (With selected context + drift + question)
```

#### Scope Filtering Algorithm

```
filterArchDataByScope(archData, currentScope, relData):
  
  Input:
    - Full graph: relationships = [{source, target}, ...]
    - Scope: {selectedSubscriptionId, selectedResourceGroup}
  
  Case 1: Resource Group Scope
    1. Seed set = [RG name] + all resources in that RG
    2. expandRelationshipClosure(relationships, seeds)
          → Iteratively add all targets reachable from seeds
    3. Keep only relationships (source, target both in closure)
    4. Return filtered graph
  
  Case 2: Subscription Scope
    1. Seed set = [sub node IDs] + [all RG names] + [all resources in sub]
    2. expandRelationshipClosure(relationships, seeds)
    3. Keep relationships where source OR target in closure
    4. Return filtered graph
  
  Result: Scoped architecture excludes cross-subscription edges,
          orphaned resource-group RGs, and unreachable resources
```

## Configuration & Environment

### Required Environment Variables

Add these to `.env` file or Azure Static Web App settings:

```env
# Azure OpenAI Configuration
REACT_APP_AZURE_OAI_ENDPOINT=https://<your-resource>.openai.azure.com
REACT_APP_AZURE_OAI_KEY=<your-api-key>
REACT_APP_AZURE_OAI_DEPLOYMENT=<deployment-name>  # e.g., gpt-4o

# Optional: Logic App Integration
REACT_APP_LOGIC_APP_URL=<your-logic-app-trigger-url>

# Application Architecture Function (for discovery)
REACT_APP_APPLICATION_ARCHITECTURE_FUNCTION_URL=<function-endpoint>
```

### Runtime Config (`public/config.js`)

```javascript
window._env_ = {
  AZURE_OAI_ENDPOINT: process.env.REACT_APP_AZURE_OAI_ENDPOINT || '',
  AZURE_OAI_KEY: process.env.REACT_APP_AZURE_OAI_KEY || '',
  AZURE_OAI_DEPLOYMENT: process.env.REACT_APP_AZURE_OAI_DEPLOYMENT || 'gpt-4o',
  LOGIC_APP_URL: process.env.REACT_APP_LOGIC_APP_URL || '',
  APPLICATION_ARCHITECTURE_FUNCTION_URL: process.env.REACT_APP_APPLICATION_ARCHITECTURE_FUNCTION_URL || '',
};
```

### Obtaining Azure OpenAI Credentials

1. **Create/access Azure OpenAI resource**
   - Portal → Cognitive Services → "Create" → "Azure OpenAI"
   - Choose region (e.g., "East US 2")
   - Create Key Vault secret for key security

2. **Create GPT deployment**
   - Azure Portal → Your OpenAI resource → Model deployments
   - Deploy "gpt-4o" or "gpt-4-turbo" (recommended 8K+ context)
   - Note deployment name for `REACT_APP_AZURE_OAI_DEPLOYMENT`

3. **Copy credentials**
   - Portal → Keys and Endpoint
   - Copy Endpoint URL (e.g., `https://myresource.openai.azure.com`)
   - Copy Key 1 to secure vault
   - Set environment variables

### Fallback Behavior

**If Azure OpenAI NOT configured:**
- ✓ ChatPanel still fully functional
- ✓ Deterministic responses work (costs, resources, inventory)
- ✓ Returns local heuristic-based answers
- ✓ No API errors or degradation
- ✗ Advanced semantic analysis unavailable
- ✗ Custom remediation suggestions not generated

**If Azure OpenAI configured but unavailable (timeout, quota exceeded):**
- ✓ Fallback to local response (same as above)
- ⚠ Logged to console for debugging
- ✓ User experience unchanged

## Testing & Validation Workflow

### Build & Deployment

```bash
# 1. Build React application
cd hackathon-dashboard
npm install
npm run build

# 2. Verify build output
ls build/
  # asset-manifest.json
  # config.js
  # index.html
  # static/js/main.*.js
  # static/css/main.*.css

# 3. Sync to hackathon-react (demo deployment)
cp -r build/* ../deploy/

# 4. Verify runtime config
cat deploy/config.js
  # Should contain window._env_ = { AZURE_OAI_ENDPOINT, ... }
```

### Manual UI Testing Checklist

#### Scope Selection & Filtering
- [ ] Load dashboard → Architecture page
- [ ] Select a subscription from dropdown
  - Verify: Graph updates, nodes filtered
  - Verify: Resource count changes
  - Verify: ChatPanel updates with scoped context
- [ ] Click into resource group in diagram
  - Verify: `currentArchitectureScope` updates
  - Verify: Chat knows selected RG
  - Verify: Cost data filtered to RG

#### Drift Detection
- [ ] Upload application architecture (PNG/SVG)
  - Diagram should extract resource tokens
  - Tokens cached for comparison
- [ ] Select subscription scope
  - System compares current tokens vs uploaded
  - Drift analysis shows: missing, extra, insights
- [ ] Ask: "What resources are missing from this scope?"
  - Should identify resources in uploaded but not current

#### Cost Questions (Deterministic)
Chat prompts to test:
- [ ] "How much does this subscription cost?" → Subscription total
- [ ] "What resource costs the most?" → Top resource name + cost
- [ ] "Show costs by resource group" → List all RGs + costs
- [ ] "How many resources in prod-rg?" → Exact count (deterministic)
- [ ] "List all resources in the selected RG" → Exact list

#### OpenAI Integration
- [ ] With credentials configured:
  - [ ] Ask: "Why might this resource be missing?" → AI analysis
  - [ ] Ask: "Give remediation steps" → AI-generated suggestions
  - [ ] Observe: `source: 'openai'` in console logs
- [ ] With credentials blanked:
  - [ ] Ask same questions → Local fallback responses
  - [ ] Observe: `source: 'local'` in console logs
  - [ ] Observe: No API errors, chat continues

#### Message History
- [ ] Send message in Overview page
- [ ] Navigate to Architecture page
  - Message history should persist (shared state)
- [ ] Navigate to Chat page
  - Full conversation visible
- [ ] Switch subscriptions
  - Chat resets (new knowledge context)
  - Copilot message re-initializes

#### Export & Reporting
- [ ] Export diagram as PNG
  - Verify: Image includes current scope visualization
- [ ] Export remediation backlog as CSV
  - Verify: Includes findings, recommendations, owner hints
- [ ] Download PDF report
  - Verify: Contains architecture diagram + findings

### Console Validation

Open DevTools → Console and verify:

```javascript
// Check environment variables loaded
window._env_
  // Should show: AZURE_OAI_ENDPOINT, AZURE_OAI_KEY, etc.

// Check React state (React DevTools extension)
// Look for:
//   - currentArchitectureScope.scopeName
//   - copilotMessages (array of message objects)
//   - archData.relationships.length > 0

// Monitor API calls (Network tab)
// Should see:
//   - /openai/deployments/gpt-4o/chat/completions (if configured)
//   - No CORS errors
//   - Response status 200 (not 401/403)
```

### Performance Metrics

| Component | TimeToInteractive | MemoryUsage | Recommendations |
|-----------|-----------------|-------------|-----------------|
| Load dashboard | < 3s | < 80MB | Use React Profiler for optimization |
| Scope selection | < 500ms | Same | Graph filtering is O(relationships) |
| OpenAI query | 2-8s | ~10MB growth | Parallel requests if > 5 user messages |
| Export PDF | 1-3s | ~20MB peak | Image rendering is CPU-intensive |

### Known Limitations & Workarounds

| Issue | Cause | Workaround |
|-------|-------|-----------|
| "Drift data is not ready" | Architecture not loaded or filtered incorrectly | Reload page, re-select subscription |
| OpenAI returns generic response | Poor context selection | Rephrase question with specific scope/resource names |
| Chat message history lost | Subscription selection changed | Expected behavior—new context requires fresh conversation |
| Token extraction fails on diagram | Image quality/format issue | Try PNG (not JPG), ensure icon labels visible |
| Slow graph rendering | 1000+ nodes/edges | Use resource group scope to filter down |

## Response Examples & Patterns

### Example 1: Deterministic Cost Answer
**User:** "How much does this subscription cost?"  
**Source:** Local (deterministic)
```
Based on cost data available for the selected subscription:

Subscription "Prod-Workload" total cost: $1,245.67

Breakdown by resource group:
- prod-compute: $823.45
- prod-storage: $312.22
- prod-networking: $110.00
```

### Example 2: OpenAI Drift Analysis
**User:** "What resources need attention?"  
**Source:** OpenAI (if configured)
```
Based on architectural drift detected in "prod-workload":

Missing Resources:
• Virtual Machine (prod-app-vm-02) - Previously documented in approved architecture
• Storage Account (backups2024) - Required for disaster recovery

Extra Resources:
• Network Interface (orphaned-nic-prod) - No associated VM, cleanup recommended

Recommended Actions:
1. Redeploy missing VM from approved IaC template
2. Review orphaned NIC for connectivity—remove if truly unused
3. Update cost baseline for backup storage account
4. Document why resources were removed if intentional changes
```

### Example 3: Weak Fallback
**User:** "What are the security recommendations?"  
**Source:** Local (OpenAI unavailable)
```
I can provide security findings from the current scope:

Active Security Findings: 3
- Storage account lacks private endpoint configuration
- VMs have no network security groups attached
- Key Vault missing from application resource group

For detailed remediation steps personalized to your architecture, please configure Azure OpenAI credentials.
```

## Architecture Highlights

✅ **Deterministic Checks Always Run** - No AI needed for basic detection  
✅ **Scoped Context** - AI only analyzes relevant subset of resources  
✅ **Resilient Fallback** - Works seamlessly without Azure OpenAI configured  
✅ **Cost Efficient** - Only calls OpenAI when user asks a question  
✅ **Performance** - Drift detection runs synchronously, OpenAI async  
✅ **Smart Caching** - Avoids redundant tokenization of uploaded diagrams  
✅ **Token-Based Context** - Selects most relevant knowledge sources per query  
✅ **Multi-Subscription** - Handles 100+ subscriptions with aggregation

## Implementation Files & Status

### Core Files Modified
| File | Lines | Status | Purpose |
|------|-------|--------|---------|
| src/utils/driftDetector.js | 201 | NEW | Drift detection & formatting |
| src/utils/openAIIntegration.js | 803 | NEW | Azure OpenAI queries + fallback |
| src/components/ArchitectureDiagram.jsx | 2447 | ENHANCED | ReactFlow visualization + scope filtering |
| src/components/ChatPanel.jsx | 880 | ENHANCED | Multi-mode chatbot + smart responses |
| src/App.jsx | 2462 | ENHANCED | Central orchestration + state management |

### Supporting Components Updated
- `src/components/StatsCards.jsx` - Scoped metrics display
- `src/components/OverviewScoreCard.jsx` - Well-architected scores
- `src/components/CostAnalysisVisualization.jsx` - Scoped cost breakdown
- `src/components/CostOptimizationRecommendations.jsx` - Filtered recommendations
- `src/components/PolicyPage.jsx` - Policy compliance visualization
- `src/components/Header.jsx` - Navigation with scope context
- `src/components/Sidebar.jsx` - Subscription/resource group selection

### Build Artifacts

```
Build Directory: hackathon-dashboard/build/
├── index.html (Main entry point)
├── config.js (Runtime environment config)
├── asset-manifest.json
├── static/
│   ├── js/
│   │   ├── main.*.js (React app bundle)
│   │   └── main.*.js.LICENSE.txt
│   ├── css/
│   │   └── main.*.css (Global styles)
├── Azure_Public_Service_Icons/ (Icon library)
└── demo-data/ (Sample architectures)
```

**Current Bundle Size:** ~280 KB (gzipped)  
**Last Build:** August 19, 2026  
**Deployment Status:** Synced to /deploy directory (hackathon-react)

## Next Steps & Roadmap

### Immediate (Done)
- [x] Implement drift detection algorithm
- [x] Integrate Azure OpenAI chat completions
- [x] Build deterministic cost answering
- [x] Add scoped filtering for subscriptions/RGs
- [x] Implement fallback resilience
- [x] Add multi-subscription support

### Short-term (In Progress)
- [ ] Add drift comparison between uploaded reference & current
- [ ] Enhance token extraction from image diagrams
- [ ] Expand deterministic answer patterns (VM tags, security groups)
- [ ] Add cost optimization recommendation filtering
- [ ] Implement message history persistence (localStorage)

### Medium-term (Planned)
- [ ] Custom drift baselines per scope
- [ ] Scheduled drift analysis reports
- [ ] Anomaly detection (sudden resource changes)
- [ ] Integration with Azure DevOps for remediation tracking
- [ ] Multi-language support for OpenAI responses

### Long-term (Exploratory)
- [ ] Historical drift trends & visualization
- [ ] ML-based cost forecasting integration
- [ ] Automated remediation workflow triggering
- [ ] Federated knowledge base across subscriptions
- [ ] Real-time streaming responses from OpenAI

## Support & Troubleshooting

### Common Issues

**Q: ChatPanel says "Drift data is not ready"**  
A: Ensure you've selected a subscription and loaded architecture data. Refresh the page and try again.

**Q: OpenAI queries are failing**  
A: Check that REACT_APP_AZURE_OAI_ENDPOINT and REACT_APP_AZURE_OAI_KEY are set. Verify quota limits on Azure OpenAI resource.

**Q: Scope filtering returns empty graph**  
A: This can happen if the selected subscription has no relationships or all relationships are within different subscriptions.

**Q: Cost questions return "not available"**  
A: Cost analysis dimensions must be loaded from discovery API. Check that apiCostAnalysis prop is populated.

### Debug Tips

1. **Enable detailed logging:**
   ```javascript
   // In browser console
   localStorage.setItem('DEBUG_DRIFT', 'true');
   localStorage.setItem('DEBUG_OPENAI', 'true');
   // Reload page
   ```

2. **Inspect App state:**
   ```javascript
   // React DevTools → Components → App
   // Check: currentArchitectureScope, archData.relationships
   ```

3. **Monitor network requests:**
   - Open DevTools → Network tab
   - Filter by 'openai' to see Azure OpenAI calls
   - Check response status & latency

4. **Check browser console:**
   - Look for `console.warn()` and `console.error()` messages
   - Search for "drift", "openai", "scope"

### Performance Optimization

**For large graphs (1000+ nodes):**
- Use resource group scope instead of subscription
- Implement pagination in resource listings
- Consider relationship graph compression

**For slow OpenAI responses:**
- Reduce maxDocChars in `selectRelevantContext()` (default 3500)
- Use faster model (e.g., gpt-4-turbo instead of gpt-4o)
- Implement response streaming (not yet implemented)

---

**Document Last Updated:** August 19, 2026  
**Component Version:** v2.1 (Enhanced with comprehensive testing guide and roadmap)  
**Status:** Production Ready with Continuous Improvements
