const AZURE_ICON_BASE = '/Azure_Public_Service_Icons/Icons';

export const AZURE_ICON_FILE_MAP = Object.freeze({
  subscription: `${AZURE_ICON_BASE}/general/10002-icon-service-Subscriptions.svg`,
  resourceGroup: `${AZURE_ICON_BASE}/general/10007-icon-service-Resource-Groups.svg`,
  virtualMachine: `${AZURE_ICON_BASE}/compute/10021-icon-service-Virtual-Machine.svg`,
  vmScaleSet: `${AZURE_ICON_BASE}/compute/10034-icon-service-VM-Scale-Sets.svg`,
  functionApp: `${AZURE_ICON_BASE}/compute/10029-icon-service-Function-Apps.svg`,
  webApp: `${AZURE_ICON_BASE}/compute/10035-icon-service-App-Services.svg`,
  appServicePlan: `${AZURE_ICON_BASE}/app services/00046-icon-service-App-Service-Plans.svg`,
  logicApp: `${AZURE_ICON_BASE}/integration/02631-icon-service-Logic-Apps.svg`,
  virtualNetwork: `${AZURE_ICON_BASE}/networking/10061-icon-service-Virtual-Networks.svg`,
  subnet: `${AZURE_ICON_BASE}/networking/02742-icon-service-Subnet.svg`,
  networkSecurityGroup: `${AZURE_ICON_BASE}/networking/10067-icon-service-Network-Security-Groups.svg`,
  privateEndpoint: `${AZURE_ICON_BASE}/other/02579-icon-service-Private-Endpoints.svg`,
  publicIp: `${AZURE_ICON_BASE}/networking/10069-icon-service-Public-IP-Addresses.svg`,
  networkInterface: `${AZURE_ICON_BASE}/networking/10080-icon-service-Network-Interfaces.svg`,
  routeTable: `${AZURE_ICON_BASE}/networking/10082-icon-service-Route-Tables.svg`,
  managedIdentity: `${AZURE_ICON_BASE}/identity/10227-icon-service-Managed-Identities.svg`,
  storageAccount: `${AZURE_ICON_BASE}/storage/10086-icon-service-Storage-Accounts.svg`,
  keyVault: `${AZURE_ICON_BASE}/security/10245-icon-service-Key-Vaults.svg`,
  applicationInsights: `${AZURE_ICON_BASE}/monitor/00012-icon-service-Application-Insights.svg`,
  logAnalytics: `${AZURE_ICON_BASE}/monitor/00009-icon-service-Log-Analytics-Workspaces.svg`,
  cognitiveServices: `${AZURE_ICON_BASE}/app services/10044-icon-service-Cognitive-Search.svg`,
});

function startsWithAny(value = '', prefixes = []) {
  const normalized = String(value || '').toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

function resolveIconByNamePrefix(lower = '') {
  if (startsWithAny(lower, ['sub-'])) return AZURE_ICON_FILE_MAP.subscription;
  if (startsWithAny(lower, ['rg-'])) return AZURE_ICON_FILE_MAP.resourceGroup;
  if (startsWithAny(lower, ['fun-', 'fn-'])) return AZURE_ICON_FILE_MAP.functionApp;
  if (startsWithAny(lower, ['vnet-'])) return AZURE_ICON_FILE_MAP.virtualNetwork;
  if (startsWithAny(lower, ['snet-', 'subnet-'])) return AZURE_ICON_FILE_MAP.subnet;
  if (startsWithAny(lower, ['asp-'])) return AZURE_ICON_FILE_MAP.appServicePlan;
  if (startsWithAny(lower, ['lapp'])) return AZURE_ICON_FILE_MAP.logicApp;
  if (startsWithAny(lower, ['law'])) return AZURE_ICON_FILE_MAP.logAnalytics;
  if (startsWithAny(lower, ['mi-', 'mi_'])) return AZURE_ICON_FILE_MAP.managedIdentity;
  if (startsWithAny(lower, ['nsg-'])) return AZURE_ICON_FILE_MAP.networkSecurityGroup;
  if (startsWithAny(lower, ['rt-'])) return AZURE_ICON_FILE_MAP.routeTable;

  if (startsWithAny(lower, ['pe-'])) {
    if (lower.includes('.nic')) return AZURE_ICON_FILE_MAP.networkInterface;
    return AZURE_ICON_FILE_MAP.privateEndpoint;
  }

  return '';
}

export function getAzureIconPathByLabel(label = '') {
  const lower = String(label || '').toLowerCase();
  const armTypeMatch = lower.match(/providers\/([^/]+\/[a-z0-9]+)/i);
  const armType = armTypeMatch?.[1] || '';

  const prefixIcon = resolveIconByNamePrefix(lower);
  if (prefixIcon) return prefixIcon;

  if (armType.includes('microsoft.keyvault/vaults')) return AZURE_ICON_FILE_MAP.keyVault;
  if (armType.includes('microsoft.storage/storageaccounts')) return AZURE_ICON_FILE_MAP.storageAccount;
  if (armType.includes('microsoft.network/privateendpoints')) return AZURE_ICON_FILE_MAP.privateEndpoint;
  if (armType.includes('microsoft.network/virtualnetworks/subnets')) return AZURE_ICON_FILE_MAP.subnet;
  if (armType.includes('microsoft.network/virtualnetworks')) return AZURE_ICON_FILE_MAP.virtualNetwork;
  if (armType.includes('microsoft.network/networksecuritygroups')) return AZURE_ICON_FILE_MAP.networkSecurityGroup;
  if (armType.includes('microsoft.network/routetables')) return AZURE_ICON_FILE_MAP.routeTable;
  if (armType.includes('microsoft.network/publicipaddresses')) return AZURE_ICON_FILE_MAP.publicIp;
  if (armType.includes('microsoft.network/networkinterfaces')) return AZURE_ICON_FILE_MAP.networkInterface;
  if (armType.includes('microsoft.managedidentity/userassignedidentities')) return AZURE_ICON_FILE_MAP.managedIdentity;
  if (armType.includes('microsoft.insights/components')) return AZURE_ICON_FILE_MAP.applicationInsights;
  if (armType.includes('microsoft.operationalinsights/workspaces')) return AZURE_ICON_FILE_MAP.logAnalytics;
  if (armType.includes('microsoft.cognitiveservices/accounts')) return AZURE_ICON_FILE_MAP.cognitiveServices;
  if (armType.includes('microsoft.compute/virtualmachinescalesets')) return AZURE_ICON_FILE_MAP.vmScaleSet;
  if (armType.includes('microsoft.compute/virtualmachines')) return AZURE_ICON_FILE_MAP.virtualMachine;
  if (armType.includes('microsoft.web/sites')) return AZURE_ICON_FILE_MAP.webApp;
  if (armType.includes('microsoft.web/serverfarms')) return AZURE_ICON_FILE_MAP.appServicePlan;
  if (armType.includes('microsoft.logic/workflows')) return AZURE_ICON_FILE_MAP.logicApp;

  if (lower.includes('::group::key-vaults') || lower.includes('key vaults') || lower.includes('key vault') || lower.includes('keyvault') || lower.includes('kv-')) return AZURE_ICON_FILE_MAP.keyVault;
  if (lower.includes('::group::storage') || lower.includes('storage accounts') || lower.includes('storage account') || /(^|[^a-z0-9])st[a-z0-9]{4,}($|[^a-z0-9])/.test(lower)) return AZURE_ICON_FILE_MAP.storageAccount;
  if (lower.includes('::group::networking')) return AZURE_ICON_FILE_MAP.virtualNetwork;

  if (lower.includes('virtual machine') && lower.includes('scale')) return AZURE_ICON_FILE_MAP.vmScaleSet;
  if (lower.includes('virtual machine') || lower.includes('vm-')) return AZURE_ICON_FILE_MAP.virtualMachine;
  if (lower.includes('function') || lower.includes('func-') || lower.includes('fun-') || lower.includes('fn-')) return AZURE_ICON_FILE_MAP.functionApp;
  if (lower.includes('web app') || lower.includes('web-') || lower.includes('webapp')) return AZURE_ICON_FILE_MAP.webApp;
  if (lower.includes('app service plan') || lower.includes('asp-')) return AZURE_ICON_FILE_MAP.appServicePlan;
  if (lower.includes('logic app') || lower.includes('logic-') || lower.includes('lapp')) return AZURE_ICON_FILE_MAP.logicApp;
  if (lower.includes('virtual network') || lower.includes('vnet')) return AZURE_ICON_FILE_MAP.virtualNetwork;
  if (lower.includes('subnet') || lower.includes('snet')) return AZURE_ICON_FILE_MAP.subnet;
  if (lower.includes('network security group') || lower.includes('nsg')) return AZURE_ICON_FILE_MAP.networkSecurityGroup;
  if (lower.includes('private endpoint') || lower.includes('pe-')) {
    if (lower.includes('.nic')) return AZURE_ICON_FILE_MAP.networkInterface;
    return AZURE_ICON_FILE_MAP.privateEndpoint;
  }
  if (lower.includes('route table') || lower.includes('rt-')) return AZURE_ICON_FILE_MAP.routeTable;
  if (lower.includes('managed identity') || /(^|[^a-z0-9])mi[-_]/.test(lower)) return AZURE_ICON_FILE_MAP.managedIdentity;
  if (lower.includes('public ip') || lower.includes('pip-')) return AZURE_ICON_FILE_MAP.publicIp;
  if (lower.includes('network interface') || lower.includes('nic-')) return AZURE_ICON_FILE_MAP.networkInterface;
  if (lower.includes('storage') || lower.includes('/storageaccounts')) return AZURE_ICON_FILE_MAP.storageAccount;
  if (lower.includes('application insight') || lower.includes('appi-')) return AZURE_ICON_FILE_MAP.applicationInsights;
  if (lower.includes('log analytics') || lower.includes('loganalytic') || lower.includes('law-') || startsWithAny(lower, ['law'])) return AZURE_ICON_FILE_MAP.logAnalytics;
  if (lower.includes('openai') || lower.includes('aoai') || lower.includes('cognitive')) return AZURE_ICON_FILE_MAP.cognitiveServices;
  if (lower.includes('resource group') || lower.includes('/resourcegroups/') || lower.includes('rg-')) return AZURE_ICON_FILE_MAP.resourceGroup;
  if (lower.includes('subscription') || lower.includes('/subscriptions/')) return AZURE_ICON_FILE_MAP.subscription;

  return '';
}
