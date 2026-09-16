# Hackathon Dashboard

Azure architecture dashboard that discovers subscription resources via a Logic App and visualizes:
- architecture relationships graph
- inventory and statistics
- findings and remediation backlog

## Setup

Create a `.env` file in the project root and configure:

`REACT_APP_LOGIC_APP_URL=<your_logic_app_http_trigger_url>`

Then run:

- `npm install`
- `npm start`

## Logic App API Contract

The dashboard no longer depends on local `build/architecture.json` or `build/relation_maping_output.json` as runtime inputs.
All discovery data is expected from the Logic App response.

### Request sent by dashboard

Method: `POST`  
Headers: `Content-Type: application/json`

Body:

```json
{
	"subscriptionId": "<subscription-guid>",
	"subscription_id": "<subscription-guid>",
	"region": "East US"
}
```

### Response requirements

The response must contain both payload types:

1) **Architecture payload** (graph)
- accepted shape:

```json
{
	"relationships": [
		{ "source": "...", "target": "...", "relationship": "contains" }
	]
}
```

2) **Relation mapping payload** (subscription/resource categorization)
- accepted shapes:

```json
{
	"data": {
		"subscriptions": {
			"<subscription-guid>": {
				"resource_groups": {}
			}
		}
	}
}
```

or

```json
{
	"subscriptions": {
		"<subscription-guid>": {
			"resource_groups": {}
		}
	}
}
```

### Flexible field placement

The app parser is tolerant to nested and stringified JSON and will discover payloads by shape, even if wrapped in intermediate fields.
Examples of wrapper fields that are commonly used and supported include:
- `architecture`
- `architecture_json`
- `architecture_data`
- `relation_mapping`
- `relation_maping_output`
- `relation_mapping_output`

## Available Scripts

- `npm start` — run development server
- `npm run build` — create production build
- `npm test` — run tests
