// Runtime configuration — replace these values on the server
// without needing to rebuild the React app.
// On Azure App Service, update this file or use a startup script to inject the real values.
window._env_ = {
  WEBPUBSUB_NEGOTIATE_URL: "https://test-000-baevdkcdh2cjcbgb.centralindia-01.azurewebsites.net/api/negotiate",
  // Data workflow URL (used by Discover / data retrieval)
  LOGIC_APP_URL: "",
  // Mail/SRE trigger URL (single workflow endpoint)
  TRIGGER_URL: "",

  // Filter subscriptions API (used by Header)
  FILTER_SUBSCRIPTIONS_URL: "",

  // Function App API (used to auto-load application architecture by scope name)
  APPLICATION_ARCHITECTURE_FUNCTION_URL: "",

  // Azure OpenAI configuration (used by drift analysis & cost estimation)
  AZURE_OAI_ENDPOINT: "https://archlens-resource.openai.azure.com/openai/v1",
  AZURE_OAI_KEY: "",
  AZURE_OAI_DEPLOYMENT: "gpt-5.6-terra"
};