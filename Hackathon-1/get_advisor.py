import json
import logging
import os
import re
import traceback
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import azure.functions as func
import requests
from azure.identity import ClientSecretCredential
from azure.mgmt.resourcegraph import ResourceGraphClient
from azure.mgmt.resourcegraph.models import QueryRequest, QueryRequestOptions

AZURE_MANAGEMENT_RESOURCE = "https://management.azure.com/.default"
API_VERSION_ADVISOR = "2023-01-01"
API_VERSION_COST_MANAGEMENT = "2023-03-01"

PILLAR_KEYWORDS = {
    "Security": [
        "security", "identity", "auth", "defender", "nsg", "firewall", "encryption",
        "vulnerability", "public", "private endpoint", "key vault", "certificate",
    ],
    "Reliability": [
        "reliability", "availability", "backup", "restore", "redundancy", "zone", "dr", "disaster",
    ],
    "Performance Efficiency": [
        "performance", "latency", "throughput", "scale", "sku", "sizing", "compute",
    ],
    "Cost Optimization": [
        "cost", "saving", "reserved", "rightsiz", "idle", "unused", "waste", "budget",
    ],
    "Operational Excellence": [
        "operational", "monitor", "alert", "diagnostic", "governance", "policy", "automation",
    ],
}

WEIGHTS = {
    "critical": 100,
    "high": 60,
    "medium": 30,
    "low": 10,
}

CATEGORY_TO_PILLAR = {
    "security": "Security",
    "highavailability": "Reliability",
    "reliability": "Reliability",
    "performance": "Performance Efficiency",
    "performanceefficiency": "Performance Efficiency",
    "cost": "Cost Optimization",
    "costoptimization": "Cost Optimization",
    "operationalexcellence": "Operational Excellence",
    "operational": "Operational Excellence",
}


def _pillars_from_category(item: Dict[str, Any]) -> Optional[List[str]]:
    """Read the Advisor-native category field and map it to our pillar label."""
    properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
    raw = (
        item.get("category")
        or properties.get("category")
    )
    if not raw:
        return None
    mapped = CATEGORY_TO_PILLAR.get(str(raw).strip().lower().replace(" ", ""))
    return [mapped] if mapped else None


RESOURCE_TYPE_LABELS = {
    "microsoft.storage/storageaccounts": "Storage Accounts",
    "microsoft.web/sites": "App services",
    "microsoft.web/serverfarms": "App Service plans",
    "microsoft.operationalinsights/workspaces": "Log Analytics workspaces",
    "microsoft.compute/virtualmachines": "Virtual Machines",
    "microsoft.sql/servers/databases": "SQL Databases",
}


def _json_response(payload: Dict[str, Any], status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload, indent=2, default=str),
        status_code=status_code,
        mimetype="application/json",
    )


def _error_response(status_code: int, stage: str, message: str, exception: Optional[Exception] = None) -> func.HttpResponse:
    location = None
    traceback_text = None
    if exception is not None and exception.__traceback__ is not None:
        tb_line = traceback.extract_tb(exception.__traceback__)[-1]
        location = f"{tb_line.filename}:{tb_line.lineno} in {tb_line.name}"
        traceback_text = traceback.format_exc()

    payload = {
        "status": "error",
        "failure_stage": stage,
        "message": message,
        "location": location,
        "traceback": traceback_text,
    }
    logging.error(json.dumps(payload, indent=2, default=str))
    return _json_response(payload, status_code=status_code)


def _parse_subscriptions(req: func.HttpRequest) -> Tuple[Optional[List[str]], Optional[func.HttpResponse]]:
    stage = "request parsing"
    try:
        body = req.get_json()
    except ValueError as exc:
        return None, _error_response(400, stage, "Invalid JSON request body", exc)

    subscription_id = body.get("subscription_id") if isinstance(body, dict) else None
    subscription_ids = body.get("subscription_ids") if isinstance(body, dict) else None

    normalized: List[str] = []

    if isinstance(subscription_id, str) and subscription_id.strip():
        normalized.extend([part.strip() for part in subscription_id.split(",") if part.strip()])

    if isinstance(subscription_ids, str) and subscription_ids.strip():
        normalized.extend([part.strip() for part in subscription_ids.split(",") if part.strip()])
    elif isinstance(subscription_ids, list):
        normalized.extend([str(item).strip() for item in subscription_ids if str(item).strip()])

    deduped: List[str] = []
    seen = set()
    for item in normalized:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    if deduped:
        return deduped, None

    return None, _error_response(
        400,
        stage,
        "Provide 'subscription_id' or 'subscription_ids' as string, comma-separated string, or non-empty list",
    )


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


def _get_access_token(credential: ClientSecretCredential) -> str:
    token = credential.get_token(AZURE_MANAGEMENT_RESOURCE)
    return token.token


def _extract_resource_group(resource_id: str) -> str:
    if not resource_id:
        return ""
    match = re.search(r"/resourceGroups/([^/]+)", resource_id, re.IGNORECASE)
    return match.group(1) if match else ""


def _extract_subscription_id(resource_id: str) -> str:
    if not resource_id:
        return ""
    match = re.search(r"/subscriptions/([^/]+)", resource_id, re.IGNORECASE)
    return match.group(1) if match else ""


def _extract_resource_name(resource_id: str) -> str:
    if not resource_id:
        return ""
    parts = [part for part in resource_id.split("/") if part]
    return parts[-1] if parts else ""


def _extract_resource_type_from_id(resource_id: str) -> str:
    if not resource_id:
        return ""
    parts = [part for part in resource_id.split("/") if part]
    try:
        providers_index = next(index for index, part in enumerate(parts) if part.lower() == "providers")
    except StopIteration:
        return ""

    if len(parts) <= providers_index + 2:
        return ""

    namespace = parts[providers_index + 1]
    type_segments = parts[providers_index + 2::2]
    if not type_segments:
        return ""
    return f"{namespace}/{'/'.join(type_segments)}"


def _titleize_identifier(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "Resources"
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
    separated = separated.replace("_", " ").replace("-", " ")
    return " ".join(part.capitalize() for part in separated.split())


def _format_resource_type_label(resource_type: str, resource_id: str) -> str:
    resolved_type = str(resource_type or "").strip() or _extract_resource_type_from_id(resource_id)
    if not resolved_type:
        return "Resources"

    normalized = resolved_type.lower()
    if normalized in RESOURCE_TYPE_LABELS:
        return RESOURCE_TYPE_LABELS[normalized]

    type_tail = resolved_type.split("/")[-1]
    return _titleize_identifier(type_tail)


def _pick_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            candidate = value.get("value") or value.get("name") or value.get("displayName")
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return ""


def _extract_count_value(*values: Any) -> Optional[int]:
    for value in values:
        if value is None:
            continue

        if isinstance(value, (int, float)):
            number = int(value)
            if number >= 0:
                return number
            continue

        text = str(value).strip()
        if not text:
            continue
        if text.isdigit():
            return int(text)

        match = re.search(r"(\d+)", text)
        if match:
            return int(match.group(1))

    return None


def _normalize_severity(value: Optional[str]) -> str:
    text = str(value or "medium").strip().lower()
    if text in {"critical", "high", "medium", "low"}:
        return text
    if text in {"error", "severe"}:
        return "high"
    if text in {"warning"}:
        return "medium"
    return "low"


def _infer_pillars(text: str) -> List[str]:
    lowered = text.lower()
    matched: List[str] = []
    for pillar, keywords in PILLAR_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            matched.append(pillar)
    return matched if matched else ["Operational Excellence"]


def _recommendation_title(item: Dict[str, Any]) -> str:
    properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
    short_description = item.get("shortDescription") or properties.get("shortDescription") or {}
    return (
        short_description.get("problem")
        or short_description.get("solution")
        or properties.get("shortDescription", {}).get("problem")
        or item.get("name")
        or "Advisor recommendation"
    )


def _recommendation_description(item: Dict[str, Any]) -> str:
    properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
    short_description = item.get("shortDescription") or properties.get("shortDescription") or {}
    return (
        short_description.get("solution")
        or short_description.get("problem")
        or properties.get("description")
        or item.get("description")
        or ""
    )


def _build_recommendation_row(item: Dict[str, Any]) -> Dict[str, Any]:
    properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
    resource_metadata = item.get("resourceMetadata") or properties.get("resourceMetadata") or {}
    extended_properties = item.get("extendedProperties") or properties.get("extendedProperties") or {}

    resource_id = resource_metadata.get("resourceId") or item.get("resourceId") or properties.get("resourceId") or ""
    subscription_id = resource_metadata.get("resourceSubscriptionId") or _extract_subscription_id(resource_id)
    resource_group = item.get("resourceGroup") or resource_metadata.get("resourceGroup") or _extract_resource_group(resource_id)

    category = _pick_text(item.get("category"), properties.get("category"))

    title = _recommendation_title(item)
    description = _recommendation_description(item)
    combined_text = " - ".join([part for part in [title, description] if part])

    severity = _normalize_severity(_pick_text(
        item.get("impact"),
        properties.get("impact"),
        item.get("risk"),
        properties.get("risk"),
        extended_properties.get("Risk"),
        extended_properties.get("risk"),
        item.get("severity"),
        properties.get("severity"),
    ))

    raw_resource_type = (
        resource_metadata.get("resourceType")
        or item.get("resourceType")
        or properties.get("resourceType")
        or _extract_resource_type_from_id(resource_id)
    )

    resource_type = _format_resource_type_label(raw_resource_type, resource_id)

    active_resources = _extract_count_value(
        item.get("activeResources"),
        item.get("active_resources"),
        item.get("resourceCount"),
        item.get("resource_count"),
        properties.get("activeResources"),
        properties.get("resourceCount"),
        extended_properties.get("activeResources"),
        extended_properties.get("impactedResources"),
        extended_properties.get("affectedResources"),
    )
    total_resources = _extract_count_value(
        item.get("totalResources"),
        item.get("total_resources"),
        properties.get("totalResources"),
        properties.get("totalResourceCount"),
        extended_properties.get("totalResources"),
        extended_properties.get("totalResourceCount"),
    )

    impacted_pillars = _pillars_from_category(item) or _infer_pillars(combined_text)

    resource_name = _extract_resource_name(resource_id)
    return {
        "recommendation": title,
        "issue": title,
        "reason": description,
        "text": combined_text,
        "severity": severity,
        "resource": resource_name,
        "resourceName": resource_name,
        "resourceId": resource_id,
        "resourceType": resource_type,
        "resourceGroup": resource_group,
        "subscriptionId": subscription_id,
        "category": category,
        "activeResources": active_resources if active_resources is not None else (1 if resource_name else 0),
        "totalResources": total_resources,
        "impactedPillars": impacted_pillars,
    }


def _fetch_advisor_from_resource_graph(credential: ClientSecretCredential, subscriptions: List[str], page_size: int = 1000) -> List[Dict[str, Any]]:
    client = ResourceGraphClient(credential)

    query = """
    advisorresources
    | where type =~ 'microsoft.advisor/recommendations'
    | project id, name, type, subscriptionId, resourceGroup, properties
    """

    all_rows: List[Dict[str, Any]] = []
    skip = 0

    while True:
        options = QueryRequestOptions(result_format="objectArray", top=page_size, skip=skip)
        request = QueryRequest(subscriptions=subscriptions, query=query, options=options)
        response = client.resources(request)

        rows = list(response.data) if response and response.data is not None else []
        if rows:
            all_rows.extend([row for row in rows if isinstance(row, dict)])

        if len(rows) < page_size:
            break
        skip += page_size

    return all_rows


def _call_subscription_advisor(subscription_id: str, token: str, timeout_sec: int = 60) -> List[Dict[str, Any]]:
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Advisor/recommendations"
        f"?api-version={API_VERSION_ADVISOR}&$top=200"
    )

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    all_rows: List[Dict[str, Any]] = []
    next_link: Optional[str] = url

    while next_link:
        request_url = next_link
        if request_url.startswith("/"):
            request_url = f"https://management.azure.com{request_url}"

        response = requests.get(request_url, headers=headers, timeout=timeout_sec)
        response.raise_for_status()

        payload = response.json() if response.content else {}

        values = payload.get("value") if isinstance(payload, dict) else []
        if isinstance(values, list):
            all_rows.extend([row for row in values if isinstance(row, dict)])

        next_link = payload.get("nextLink") if isinstance(payload, dict) else None

    return all_rows


def _get_cost_with_groupings(subscription_id: str, token: str, groupings: List[str]) -> Dict[str, Any]:
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}"
        f"/providers/Microsoft.CostManagement/query?api-version={API_VERSION_COST_MANAGEMENT}"
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = {
        "type": "ActualCost",
        "timeframe": "MonthToDate",
        "dataset": {
            "granularity": "None",
            "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}},
            "grouping": [{"type": "Dimension", "name": name} for name in groupings],
        },
    }

    response = requests.post(url, headers=headers, json=body, timeout=120)
    response.raise_for_status()
    payload = response.json() if response.content else {}
    properties = payload.get("properties", {})
    rows = list(properties.get("rows", []))
    columns = properties.get("columns", [])
    next_link = properties.get("nextLink") or payload.get("nextLink")

    while next_link:
        page_response = requests.get(next_link, headers=headers, timeout=120)
        page_response.raise_for_status()
        page_payload = page_response.json() if page_response.content else {}
        page_properties = page_payload.get("properties", {})
        rows.extend(page_properties.get("rows", []))
        next_link = page_properties.get("nextLink") or page_payload.get("nextLink")

    return {"columns": columns, "rows": rows}


def _extract_cost_dimensions(cost_responses: List[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
    dimensions: Dict[str, Dict[str, float]] = defaultdict(dict)
    grouping_map = {
        "servicename": "service",
        "resourceid": "resource",
        "resourcegroupname": "resource_group",
    }

    for response in cost_responses:
        columns = response.get("columns", [])
        rows = response.get("rows", [])
        column_names = [str(column.get("name", "")).lower() for column in columns]
        cost_index = next(
            (column_names.index(name) for name in ("totalcost", "cost", "pretaxcost") if name in column_names),
            len(rows[0]) - 1 if rows else None,
        )
        if cost_index is None:
            continue

        for row in rows:
            try:
                amount = float(row[cost_index])
            except (IndexError, TypeError, ValueError):
                continue

            for index, column_name in enumerate(column_names):
                dimension_name = grouping_map.get(column_name)
                if not dimension_name or index >= len(row) or row[index] in (None, ""):
                    continue
                value = str(row[index])
                if dimension_name == "resource":
                    value = _extract_resource_name(value)
                dimensions[dimension_name][value] = dimensions[dimension_name].get(value, 0) + amount

    return dimensions


def _build_cost_optimization_rows(raw_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    seen_titles = set()
    for item in raw_items:
        properties = item.get("properties") if isinstance(item.get("properties"), dict) else {}
        if str(properties.get("category", item.get("category", ""))).lower() != "cost":
            continue

        extended = properties.get("extendedProperties") or item.get("extendedProperties") or {}
        short_description = properties.get("shortDescription") or item.get("shortDescription") or {}
        title = short_description.get("solution") or short_description.get("problem") or item.get("name") or "Advisor recommendation"
        if title in seen_titles:
            continue
        seen_titles.add(title)

        annual_savings = extended.get("annualSavingsAmount")
        monthly_savings = (
            float(annual_savings) / 12
            if annual_savings is not None
            else float(extended.get("savingsAmount", 0) or 0)
        )
        rows.append({
            "title": title,
            "detail": short_description.get("problem", ""),
            "impact": str(properties.get("impact", "")).capitalize(),
            "fromState": extended.get("currentSku") or "Current state not provided",
            "toState": extended.get("targetSku") or "Target state not provided",
            "benefit": (properties.get("remediation") or {}).get("description", ""),
            "estimatedSavingsMonthly": round(monthly_savings, 2),
        })
    return rows


def _compute_score_summary(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    if not rows:
        return {
            "overall": 100,
            "security": 100,
            "reliability": 100,
            "performanceEfficiency": 100,
            "costOptimization": 100,
            "operationalExcellence": 100,
        }

    pillar_points = defaultdict(int)
    pillar_counts = defaultdict(int)

    for row in rows:
        severity = _normalize_severity(row.get("severity"))
        weight = WEIGHTS.get(severity, 10)
        pillars = row.get("impactedPillars") or ["Operational Excellence"]
        for pillar in pillars:
            key = pillar.strip().lower()
            pillar_points[key] += weight
            pillar_counts[key] += 1

    def score_for(keywords: List[str]) -> int:
        total_points = 0
        total_count = 0
        for keyword in keywords:
            total_points += pillar_points.get(keyword, 0)
            total_count += pillar_counts.get(keyword, 0)

        if total_count == 0:
            return 100

        max_points = total_count * WEIGHTS["critical"]
        ratio = total_points / max_points if max_points else 0
        return max(0, min(100, round(100 - (ratio * 100))))

    security = score_for(["security"])
    reliability = score_for(["reliability"])
    performance = score_for(["performance efficiency"])
    cost = score_for(["cost optimization"])
    operational = score_for(["operational excellence"])

    overall = round((security + reliability + performance + cost + operational) / 5)

    return {
        "overall": overall,
        "security": security,
        "reliability": reliability,
        "performanceEfficiency": performance,
        "costOptimization": cost,
        "operationalExcellence": operational,
    }


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Advisor data fetch started")

    subscriptions, parse_error = _parse_subscriptions(req)
    if parse_error:
        return parse_error

    try:
        credential = _build_credential()
        token = _get_access_token(credential)
    except Exception as exc:
        return _error_response(400, "authentication", str(exc), exc)

    try:
        recommendation_items: List[Dict[str, Any]] = []
        cost_responses: List[Dict[str, Any]] = []
        cost_failures: List[Dict[str, str]] = []
        completed_cost_subscriptions: List[str] = []
        fetch_source = "advisor_rest"

        try:
            for subscription_id in subscriptions or []:
                raw_items = _call_subscription_advisor(subscription_id=subscription_id, token=token)
                recommendation_items.extend(raw_items)

                try:
                    cost_responses.extend([
                        _get_cost_with_groupings(subscription_id, token, ["ServiceName", "ResourceGroupName"]),
                        _get_cost_with_groupings(subscription_id, token, ["ResourceId"]),
                    ])
                    completed_cost_subscriptions.append(subscription_id)
                except requests.RequestException as cost_exc:
                    logging.warning("Cost Management API failed for subscription %s: %s", subscription_id, str(cost_exc))
                    cost_failures.append({"subscriptionId": subscription_id, "error": str(cost_exc)})
        except requests.HTTPError as exc:
            logging.warning(
                "Advisor REST pagination/call failed, switching to full Resource Graph fetch. Error: %s",
                str(exc),
            )
            recommendation_items = _fetch_advisor_from_resource_graph(credential, subscriptions or [])
            fetch_source = "resource_graph"
            cost_responses = []
            cost_failures = []
            completed_cost_subscriptions = []

            for subscription_id in subscriptions or []:
                try:
                    cost_responses.extend([
                        _get_cost_with_groupings(subscription_id, token, ["ServiceName", "ResourceGroupName"]),
                        _get_cost_with_groupings(subscription_id, token, ["ResourceId"]),
                    ])
                    completed_cost_subscriptions.append(subscription_id)
                except requests.RequestException as cost_exc:
                    logging.warning("Cost Management API failed for subscription %s: %s", subscription_id, str(cost_exc))
                    cost_failures.append({"subscriptionId": subscription_id, "error": str(cost_exc)})

        recommendations = [_build_recommendation_row(item) for item in recommendation_items]

        score_summary = _compute_score_summary(recommendations)
        cost_dimensions = _extract_cost_dimensions(cost_responses)
        cost_dimension_payload = [
            {
                "dimensionKey": f"by_{dimension_name}",
                "data": [
                    {"name": name, "value": round(value, 2)}
                    for name, value in sorted(values.items(), key=lambda entry: entry[1], reverse=True)
                ],
            }
            for dimension_name, values in cost_dimensions.items()
        ]

        payload = {
            "status": "success",
            "subscriptions_requested": subscriptions,
            "source": fetch_source,
            "scoreSummary": score_summary,
            "recommendations": recommendations,
            "total_recommendations": len(recommendations),
            "cost_analysis": {
                "dimensions": cost_dimension_payload,
                "timeframe": "MonthToDate",
            },
            "cost_optimization": {
                "recommendations": _build_cost_optimization_rows(recommendation_items),
            },
            "processing_summary": {
                "total_subscriptions": len(subscriptions or []),
                "completed_cost_subscriptions": completed_cost_subscriptions,
                "failed_cost_subscriptions": cost_failures,
            },
        }
        return _json_response(payload, status_code=200)

    except requests.HTTPError as exc:
        return _error_response(502, "advisor api call", f"Azure Advisor API error: {str(exc)}", exc)
    except Exception as exc:
        return _error_response(500, "advisor processing", str(exc), exc)
