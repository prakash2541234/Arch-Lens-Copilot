import json
import logging
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import azure.functions as func
import requests
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import ClientSecretCredential

AZURE_MANAGEMENT_SCOPE = "https://management.azure.com/.default"
POLICY_DEFINITIONS_API_VERSION = "2023-04-01"
POLICY_SET_DEFINITIONS_API_VERSION = "2023-04-01"
POLICY_ASSIGNMENTS_API_VERSION = "2022-06-01"
SUBSCRIPTIONS_API_VERSION = "2022-12-01"
MAX_HTTP_RETRIES = 3
TRANSIENT_HTTP_STATUS_CODES = {408, 429, 500, 502, 503, 504}


class PolicyApiError(Exception):
	def __init__(self, status_code: int, public_message: str, internal_message: Optional[str] = None):
		super().__init__(public_message)
		self.status_code = status_code
		self.public_message = public_message
		self.internal_message = internal_message or public_message


def _json_response(payload: Dict[str, Any], status_code: int = 200) -> func.HttpResponse:
	return func.HttpResponse(
		json.dumps(payload, indent=2, default=str),
		status_code=status_code,
		mimetype="application/json",
	)


def _error_response(status_code: int, message: str) -> func.HttpResponse:
	return _json_response(
		{
			"status": "error",
			"message": message,
		},
		status_code=status_code,
	)


def _normalize_text(value: Any) -> str:
	return str(value or "").strip()


def _normalize_key(value: Any) -> str:
	return _normalize_text(value).lower()


def _to_display_value(value: Any) -> str:
	if isinstance(value, str):
		return json.dumps(value)
	if isinstance(value, (dict, list, bool, int, float)):
		return json.dumps(value)
	if value is None:
		return "-"
	return _normalize_text(value) or "-"


def _titleize_identifier(value: str) -> str:
	raw = _normalize_text(value)
	if not raw:
		return "-"
	separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
	separated = separated.replace("_", " ").replace("-", " ")
	return " ".join(word.capitalize() for word in separated.split())


def _normalize_policy_type(value: Any) -> str:
	text = _normalize_key(value)
	if text in {"builtin", "builtinpolicy", "built in"}:
		return "BuiltIn"
	if text == "custom":
		return "Custom"
	if text == "static":
		return "Static"
	return _normalize_text(value) or "BuiltIn"


def _build_credential() -> ClientSecretCredential:
	tenant_id = os.getenv("AZURE_TENANT_ID")
	client_id = os.getenv("AZURE_CLIENT_ID")
	client_secret = os.getenv("AZURE_CLIENT_SECRET")

	missing = [
		key for key, val in {
			"AZURE_TENANT_ID": tenant_id,
			"AZURE_CLIENT_ID": client_id,
			"AZURE_CLIENT_SECRET": client_secret,
		}.items() if not val
	]
	if missing:
		raise ValueError(f"Missing required environment variables: {', '.join(missing)}")

	return ClientSecretCredential(
		tenant_id=tenant_id,
		client_id=client_id,
		client_secret=client_secret,
	)


def _parse_subscriptions(req: func.HttpRequest) -> Tuple[Optional[List[str]], Optional[func.HttpResponse]]:
	try:
		body = req.get_json()
	except ValueError:
		return None, _error_response(400, "Invalid JSON request body")

	if not isinstance(body, dict):
		return None, _error_response(400, "Request body must be a JSON object")

	subscription_id = body.get("subscription_id")
	subscription_ids = body.get("subscription_ids")

	normalized: List[str] = []

	if isinstance(subscription_id, str) and subscription_id.strip():
		normalized.extend([segment.strip() for segment in subscription_id.split(",") if segment.strip()])

	if isinstance(subscription_ids, str) and subscription_ids.strip():
		normalized.extend([segment.strip() for segment in subscription_ids.split(",") if segment.strip()])
	elif isinstance(subscription_ids, list):
		normalized.extend([
			str(item).strip()
			for item in subscription_ids
			if isinstance(item, str) and item.strip()
		])

	deduped: List[str] = []
	seen = set()
	for item in normalized:
		key = _normalize_key(item)
		if not key or key in seen:
			continue
		seen.add(key)
		deduped.append(item)

	if not deduped:
		return None, _error_response(
			400,
			"Provide 'subscription_id' or 'subscription_ids' as a string, comma-separated string, or list of strings.",
		)

	return deduped, None


def _get_access_token(credential: ClientSecretCredential) -> str:
	token = credential.get_token(AZURE_MANAGEMENT_SCOPE)
	return token.token


def _parse_retry_after_seconds(value: Optional[str]) -> Optional[float]:
	if not value:
		return None
	text = _normalize_text(value)
	if not text:
		return None
	try:
		seconds = float(text)
		if seconds < 0:
			return None
		return min(seconds, 10.0)
	except ValueError:
		return None


def _request_with_retry(
	url: str,
	token: str,
	timeout_seconds: int = 45,
	allow_not_found: bool = False,
) -> requests.Response:
	headers = {
		"Authorization": f"Bearer {token}",
		"Content-Type": "application/json",
	}

	last_error: Optional[Exception] = None
	for attempt in range(MAX_HTTP_RETRIES + 1):
		try:
			response = requests.get(url, headers=headers, timeout=timeout_seconds)
		except requests.Timeout as exc:
			last_error = exc
			if attempt < MAX_HTTP_RETRIES:
				time.sleep(0.5 * (2 ** attempt))
				continue
			raise PolicyApiError(504, "Azure Policy API request timed out.", str(exc)) from exc
		except requests.ConnectionError as exc:
			last_error = exc
			if attempt < MAX_HTTP_RETRIES:
				time.sleep(0.5 * (2 ** attempt))
				continue
			raise PolicyApiError(503, "Unable to connect to Azure Policy API.", str(exc)) from exc
		except requests.RequestException as exc:
			raise PolicyApiError(502, "Network error while calling Azure Policy API.", str(exc)) from exc

		status_code = response.status_code
		if allow_not_found and status_code == 404:
			return response

		if status_code in TRANSIENT_HTTP_STATUS_CODES and attempt < MAX_HTTP_RETRIES:
			retry_after = _parse_retry_after_seconds(response.headers.get("Retry-After"))
			if retry_after is None:
				retry_after = 0.5 * (2 ** attempt)
			time.sleep(retry_after)
			continue

		if status_code >= 400:
			error_text = _normalize_text(response.text)
			raise PolicyApiError(
				status_code,
				f"Azure Policy API returned HTTP {status_code}.",
				error_text[:1500] if error_text else f"HTTP {status_code}",
			)

		return response

	if last_error:
		raise PolicyApiError(502, "Failed to call Azure Policy API after retries.", str(last_error)) from last_error

	raise PolicyApiError(502, "Failed to call Azure Policy API after retries.")


def _arm_get_paged(url: str, token: str) -> List[Dict[str, Any]]:
	items: List[Dict[str, Any]] = []
	next_url = url
	while next_url:
		response = _request_with_retry(next_url, token, timeout_seconds=45)
		try:
			payload = response.json() if response.content else {}
		except ValueError as exc:
			raise PolicyApiError(502, "Azure Policy API returned invalid JSON payload.", str(exc)) from exc
		values = payload.get("value") if isinstance(payload, dict) else None
		if isinstance(values, list):
			items.extend([item for item in values if isinstance(item, dict)])
		next_url = payload.get("nextLink") if isinstance(payload, dict) else None

	return items


def _arm_get_single(resource_id_or_url: str, api_version: str, token: str) -> Optional[Dict[str, Any]]:
	if not resource_id_or_url:
		return None

	if resource_id_or_url.lower().startswith("https://"):
		url = resource_id_or_url
		if "api-version=" not in url:
			separator = "&" if "?" in url else "?"
			url = f"{url}{separator}api-version={api_version}"
	else:
		url = f"https://management.azure.com{resource_id_or_url}?api-version={api_version}"

	response = _request_with_retry(url, token, timeout_seconds=45, allow_not_found=True)
	if response.status_code == 404:
		return None
	try:
		payload = response.json() if response.content else {}
	except ValueError as exc:
		raise PolicyApiError(502, "Azure Policy API returned invalid JSON payload.", str(exc)) from exc
	return payload if isinstance(payload, dict) else None


def _normalize_definition_item(item: Dict[str, Any], definition_type: str) -> Dict[str, Any]:
	properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
	metadata = properties.get("metadata") if isinstance(properties.get("metadata"), dict) else {}

	return {
		"name": _normalize_text(properties.get("displayName") or item.get("name") or "Unnamed"),
		"type": _normalize_policy_type(properties.get("policyType") or item.get("policyType") or "BuiltIn"),
		"definitionType": definition_type,
		"category": _normalize_text(metadata.get("category") or "Uncategorized"),
	}


def _collect_definition_parameters(definition: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
	if not isinstance(definition, dict):
		return {}

	properties = definition.get("properties") if isinstance(definition.get("properties"), dict) else {}
	parameters = properties.get("parameters") if isinstance(properties.get("parameters"), dict) else {}
	result: Dict[str, Dict[str, Any]] = {}

	for parameter_id, parameter_body in parameters.items():
		if not isinstance(parameter_body, dict):
			continue
		metadata = parameter_body.get("metadata") if isinstance(parameter_body.get("metadata"), dict) else {}
		result[_normalize_key(parameter_id)] = {
			"parameterId": _normalize_text(parameter_id),
			"parameterName": _normalize_text(
				metadata.get("displayName")
				or metadata.get("description")
				or parameter_id
			) or _titleize_identifier(str(parameter_id)),
			"defaultValue": parameter_body.get("defaultValue"),
		}

	return result


def _build_assignment_parameters(
	assignment_item: Dict[str, Any],
	definition_parameters: Dict[str, Dict[str, Any]],
) -> List[Dict[str, str]]:
	properties = assignment_item.get("properties") if isinstance(assignment_item.get("properties"), dict) else {}
	assignment_parameters = properties.get("parameters") if isinstance(properties.get("parameters"), dict) else {}

	rows: List[Dict[str, str]] = []
	included = set()

	for parameter_id, parameter_body in assignment_parameters.items():
		parameter_key = _normalize_key(parameter_id)
		definition_meta = definition_parameters.get(parameter_key, {})
		value = parameter_body.get("value") if isinstance(parameter_body, dict) else parameter_body

		rows.append(
			{
				"parameterId": _normalize_text(parameter_id),
				"parameterName": _normalize_text(definition_meta.get("parameterName") or parameter_id),
				"parameterValue": _to_display_value(value),
				"referenceType": "User defined parameter",
			}
		)
		included.add(parameter_key)

	for parameter_key, definition_meta in definition_parameters.items():
		if parameter_key in included:
			continue
		default_value = definition_meta.get("defaultValue")
		if default_value is None:
			continue
		rows.append(
			{
				"parameterId": _normalize_text(definition_meta.get("parameterId")),
				"parameterName": _normalize_text(definition_meta.get("parameterName")),
				"parameterValue": _to_display_value(default_value),
				"referenceType": "Default value",
			}
		)

	return rows


def _build_assignment_item(
	assignment_item: Dict[str, Any],
	definitions_by_id: Dict[str, Dict[str, Any]],
	token: str,
) -> Dict[str, Any]:
	properties = assignment_item.get("properties") if isinstance(assignment_item.get("properties"), dict) else {}
	policy_definition_id = _normalize_text(properties.get("policyDefinitionId"))
	lower_definition_id = _normalize_key(policy_definition_id)
	is_initiative = "/policysetdefinitions/" in lower_definition_id
	definition_type_label = "Initiative" if is_initiative else "Policy"

	referenced_definition = definitions_by_id.get(lower_definition_id)
	if referenced_definition is None and policy_definition_id:
		api_version = POLICY_SET_DEFINITIONS_API_VERSION if is_initiative else POLICY_DEFINITIONS_API_VERSION
		referenced_definition = _arm_get_single(policy_definition_id, api_version, token)
		if referenced_definition:
			definitions_by_id[lower_definition_id] = referenced_definition

	definition_parameters = _collect_definition_parameters(referenced_definition)
	parameters = _build_assignment_parameters(assignment_item, definition_parameters)

	assignment_name = _normalize_text(
		properties.get("displayName")
		or assignment_item.get("name")
		or "Unnamed assignment"
	)

	scope = _normalize_text(properties.get("scope") or assignment_item.get("id") or "")

	return {
		"assignmentName": assignment_name,
		"scope": scope,
		"type": definition_type_label,
		"parameters": parameters,
	}


def _fetch_subscription_display_name(subscription_id: str, token: str) -> str:
	url = (
		f"https://management.azure.com/subscriptions/{subscription_id}"
		f"?api-version={SUBSCRIPTIONS_API_VERSION}"
	)
	response = _request_with_retry(url, token, timeout_seconds=30)
	try:
		payload = response.json() if response.content else {}
	except ValueError as exc:
		raise PolicyApiError(502, "Azure Subscription API returned invalid JSON payload.", str(exc)) from exc

	if not isinstance(payload, dict):
		return subscription_id

	return _normalize_text(
		payload.get("displayName")
		or payload.get("subscriptionName")
		or payload.get("name")
		or subscription_id
	) or subscription_id


def _build_subscription_bucket_key(subscription_name: str, subscription_id: str) -> str:
	name = _normalize_text(subscription_name) or subscription_id
	identifier = _normalize_text(subscription_id)
	return f"{name}({identifier})"


def _fetch_subscription_policy_data(subscription_id: str, token: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
	base_url = f"https://management.azure.com/subscriptions/{subscription_id}/providers/Microsoft.Authorization"

	policy_definitions = _arm_get_paged(
		f"{base_url}/policyDefinitions?api-version={POLICY_DEFINITIONS_API_VERSION}",
		token,
	)
	policy_set_definitions = _arm_get_paged(
		f"{base_url}/policySetDefinitions?api-version={POLICY_SET_DEFINITIONS_API_VERSION}",
		token,
	)
	policy_assignments = _arm_get_paged(
		f"{base_url}/policyAssignments?api-version={POLICY_ASSIGNMENTS_API_VERSION}",
		token,
	)

	return policy_definitions, policy_set_definitions, policy_assignments


def main(req: func.HttpRequest) -> func.HttpResponse:
	subscriptions, parse_error = _parse_subscriptions(req)
	if parse_error:
		return parse_error

	assert subscriptions is not None

	try:
		credential = _build_credential()
		token = _get_access_token(credential)
	except ValueError as exc:
		logging.exception("Policy API credential configuration error")
		return _error_response(500, f"Credential configuration error: {exc}")
	except ClientAuthenticationError as exc:
		logging.exception("Policy API authentication failed")
		return _error_response(401, f"Authentication failed: {exc}")
	except Exception as exc:
		logging.exception("Failed to create Azure credential")
		return _error_response(500, f"Authentication failed: {exc}")

	grouped_policy_data: Dict[str, Dict[str, Any]] = {}
	failed_subscriptions: List[Dict[str, Any]] = []

	for subscription_id in subscriptions:
		try:
			subscription_name = _fetch_subscription_display_name(subscription_id, token)
			policy_definitions, policy_set_definitions, policy_assignments = _fetch_subscription_policy_data(subscription_id, token)

			definition_rows: List[Dict[str, Any]] = []
			assignment_rows: List[Dict[str, Any]] = []
			definition_dedupe = set()
			assignment_dedupe = set()
			definitions_by_id: Dict[str, Dict[str, Any]] = {}

			for definition_item in policy_definitions:
				definition_id = _normalize_text(definition_item.get("id"))
				if definition_id:
					definitions_by_id[_normalize_key(definition_id)] = definition_item

				row = _normalize_definition_item(definition_item, "Policy")
				dedupe_key = (
					_normalize_key(row["name"]),
					_normalize_key(row["type"]),
					_normalize_key(row["definitionType"]),
					_normalize_key(row["category"]),
				)
				if dedupe_key in definition_dedupe:
					continue
				definition_dedupe.add(dedupe_key)
				definition_rows.append(row)

			for initiative_item in policy_set_definitions:
				initiative_id = _normalize_text(initiative_item.get("id"))
				if initiative_id:
					definitions_by_id[_normalize_key(initiative_id)] = initiative_item

				row = _normalize_definition_item(initiative_item, "Initiative")
				dedupe_key = (
					_normalize_key(row["name"]),
					_normalize_key(row["type"]),
					_normalize_key(row["definitionType"]),
					_normalize_key(row["category"]),
				)
				if dedupe_key in definition_dedupe:
					continue
				definition_dedupe.add(dedupe_key)
				definition_rows.append(row)

			for assignment_item in policy_assignments:
				row = _build_assignment_item(assignment_item, definitions_by_id, token)
				dedupe_key = (
					_normalize_key(row["assignmentName"]),
					_normalize_key(row["scope"]),
					_normalize_key(row["type"]),
				)
				if dedupe_key in assignment_dedupe:
					continue
				assignment_dedupe.add(dedupe_key)
				assignment_rows.append(row)

			subscription_key = _build_subscription_bucket_key(subscription_name, subscription_id)
			grouped_policy_data[subscription_key] = {
				"definitions": definition_rows,
				"assignments": assignment_rows,
			}
		except PolicyApiError as exc:
			logging.exception("Policy data collection failed for subscription %s", subscription_id)
			failed_subscriptions.append(
				{
					"subscriptionId": subscription_id,
					"statusCode": exc.status_code,
					"message": exc.public_message,
				}
			)
			continue
		except Exception as exc:
			logging.exception("Unexpected failure while collecting policy data for subscription %s", subscription_id)
			failed_subscriptions.append(
				{
					"subscriptionId": subscription_id,
					"statusCode": 500,
					"message": f"Unexpected error: {exc}",
				}
			)
			continue

	if failed_subscriptions and not grouped_policy_data:
		primary_status = failed_subscriptions[0].get("statusCode") or 500
		return _json_response(
			{
				"status": "error",
				"message": "Failed to collect policy information for all subscriptions.",
				"subscriptions": {},
				"failedSubscriptions": failed_subscriptions,
			},
			status_code=primary_status,
		)

	if failed_subscriptions:
		response = {
			"status": "partial_success",
			"subscriptions": grouped_policy_data,
			"failedSubscriptions": failed_subscriptions,
		}
		return _json_response(response, status_code=200)

	return _json_response(grouped_policy_data, status_code=200)
