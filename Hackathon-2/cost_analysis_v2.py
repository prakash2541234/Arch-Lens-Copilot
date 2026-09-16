"""
Cost Analysis Function v2 — async, parallel, and bounded by a hard timeout.

Advisor is handled separately. This function collects only Cost Management data.
"""

import asyncio
import json
import logging
import os
import random
from typing import Dict, List, Optional, Tuple

import azure.functions as func
import httpx
from azure.identity import ClientSecretCredential


# ---------------------------------------------------------------------------
# Configuration (same env vars as original)
# ---------------------------------------------------------------------------

MAX_HTTP_RETRIES = max(0, int(os.environ.get("COST_API_MAX_RETRIES", "2")))
HTTP_TIMEOUT = max(5, int(os.environ.get("COST_HTTP_TIMEOUT", "45")))
GLOBAL_TIMEOUT = max(30, int(os.environ.get("COST_GLOBAL_TIMEOUT", "150")))

TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(value, default=0.0) -> float:
    try:
        if value is None:
            return float(default)
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _get_credential_from_env() -> ClientSecretCredential:
    tenant_id = os.environ.get("TENANT_ID") or os.environ.get("AZURE_TENANT_ID")
    client_id = os.environ.get("CLIENT_ID") or os.environ.get("AZURE_CLIENT_ID")
    client_secret = os.environ.get("CLIENT_SECRET") or os.environ.get("AZURE_CLIENT_SECRET")

    if not all([tenant_id, client_id, client_secret]):
        raise ValueError(
            "Missing required environment variables: TENANT_ID, CLIENT_ID, CLIENT_SECRET "
            "(or AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)"
        )

    return ClientSecretCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        client_secret=client_secret,
    )


def get_token() -> str:
    credential = _get_credential_from_env()
    token = credential.get_token("https://management.azure.com/.default")
    return token.token


def _resource_name_from_id(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if "/" not in raw:
        return raw
    parts = [part for part in raw.split("/") if part]
    if not parts:
        return raw
    return parts[-1]


# ---------------------------------------------------------------------------
# Async HTTP with retry
# ---------------------------------------------------------------------------

async def _retry_sleep_seconds(attempt: int, response: Optional[httpx.Response] = None) -> float:
    """Use short backoff because the function has a hard global time budget."""
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after is not None:
            try:
                retry_after_value = float(str(retry_after).strip())
                if retry_after_value > 0:
                    return min(retry_after_value + random.uniform(0.5, 1.5), 15.0)
            except (TypeError, ValueError):
                pass

    return min((2 ** attempt) * 2 + random.uniform(0.5, 2.0), 15.0)


async def async_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: Dict,
    json_body: Optional[Dict] = None,
) -> Dict:
    """Make an HTTP request with async retry logic."""
    for attempt in range(MAX_HTTP_RETRIES + 1):
        try:
            response = await client.request(
                method,
                url,
                headers=headers,
                json=json_body,
                timeout=HTTP_TIMEOUT,
            )
            # Small delay to be polite to the API
            await asyncio.sleep(0.15)
        except httpx.HTTPError as exc:
            if attempt < MAX_HTTP_RETRIES:
                sleep_time = await _retry_sleep_seconds(attempt)
                logging.warning(
                    "Request exception attempt %s/%s for %s %s. Retry in %.1fs: %s",
                    attempt + 1, MAX_HTTP_RETRIES + 1, method, url, sleep_time, str(exc),
                )
                await asyncio.sleep(sleep_time)
                continue
            raise Exception(f"API call failed: {str(exc)}") from exc

        if response.status_code < 400:
            try:
                return response.json()
            except ValueError:
                return {}

        if response.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_HTTP_RETRIES:
            sleep_time = await _retry_sleep_seconds(attempt, response)
            logging.warning(
                "HTTP %s attempt %s/%s for %s %s. Retry in %.1fs",
                response.status_code, attempt + 1, MAX_HTTP_RETRIES + 1,
                method, url, sleep_time,
            )
            await asyncio.sleep(sleep_time)
            continue

        raise Exception(f"API call failed: {response.status_code} - {response.text}")

    raise Exception(f"API call exhausted all {MAX_HTTP_RETRIES + 1} attempts for {method} {url}")


# ---------------------------------------------------------------------------
# Cost Management API (async)
# ---------------------------------------------------------------------------

async def _get_cost_with_groupings(
    client: httpx.AsyncClient,
    subscription_id: str,
    token: str,
    groupings: List[str],
) -> Dict:
    """Fetch cost data for specific grouping dimensions with pagination."""
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}"
        "/providers/Microsoft.CostManagement/query?api-version=2023-03-01"
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
            "aggregation": {
                "totalCost": {"name": "Cost", "function": "Sum"},
            },
            "grouping": [
                {"type": "Dimension", "name": g} for g in groupings
            ],
        },
    }

    # First page
    response_data = await async_request(client, "POST", url, headers=headers, json_body=body)

    all_rows = list(response_data.get("properties", {}).get("rows", []))
    columns = response_data.get("properties", {}).get("columns", [])

    next_link = (
        response_data.get("properties", {}).get("nextLink")
        or response_data.get("nextLink")
    )

    page = 0
    while next_link:
        page += 1
        logging.info(
            "CostManagement pagination: page %s for subscription %s (%s)",
            page + 1, subscription_id, ",".join(groupings),
        )
        page_data = await async_request(client, "GET", next_link, headers=headers)
        page_rows = page_data.get("properties", {}).get("rows", [])
        all_rows.extend(page_rows)
        next_link = (
            page_data.get("properties", {}).get("nextLink")
            or page_data.get("nextLink")
        )

    merged = dict(response_data)
    merged["properties"] = dict(response_data.get("properties", {}))
    merged["properties"]["rows"] = all_rows
    merged["properties"]["columns"] = columns
    return merged


# ---------------------------------------------------------------------------
# Dimension extraction (identical logic to original)
# ---------------------------------------------------------------------------

def extract_dimensions_from_unified_response(data: Dict) -> Dict:
    """Extract individual dimensions from a single API response."""
    dimensions = {
        "service": {},
        "resource": {},
        "resource_group": {},
        "charge_type": {},
        "location": {},
        "product": {},
        "resource_type": {},
        "meter": {},
        "meter_category": {},
        "meter_sub_category": {},
        "pricing_model": {},
        "frequency": {},
        "part_number": {},
        "invoice_id": {},
        "reservation": {},
        "publisher_type": {},
        "subscription_total": {},
    }

    props = data.get("properties", {})
    rows = props.get("rows", [])
    columns = props.get("columns", [])

    if not rows:
        return dimensions

    column_names = [str(col.get("name", "")) for col in columns]
    lower_column_names = [name.lower() for name in column_names]

    value_index = None
    for candidate in ["totalcost", "cost", "pretaxcost", "costinbillingcurrency"]:
        if candidate in lower_column_names:
            value_index = lower_column_names.index(candidate)
            break

    if value_index is None:
        value_index = len(rows[0]) - 1

    grouping_map = {
        "servicename": "service",
        "resource": "resource",
        "resourceid": "resource",
        "resourcegroupname": "resource_group",
        "chargetype": "charge_type",
        "resourcelocation": "location",
        "product": "product",
        "resourcetype": "resource_type",
        "meter": "meter",
        "metercategory": "meter_category",
        "metersubcategory": "meter_sub_category",
        "pricingmodel": "pricing_model",
        "frequency": "frequency",
        "partnumber": "part_number",
        "invoiceid": "invoice_id",
        "reservationid": "reservation",
        "publishertype": "publisher_type",
    }

    for row in rows:
        value = _safe_float(row[value_index], 0) if value_index < len(row) else 0.0

        for col_idx, col_name in enumerate(lower_column_names):
            if col_idx >= len(row):
                continue
            if col_name in grouping_map:
                dimension_key = grouping_map[col_name]
                row_value = row[col_idx]
                if row_value and row_value != "":
                    key = (
                        _resource_name_from_id(row_value)
                        if dimension_key == "resource"
                        else str(row_value)
                    )
                    dimensions[dimension_key][key] = (
                        dimensions[dimension_key].get(key, 0) + value
                    )

        dimensions["subscription_total"]["total"] = (
            dimensions["subscription_total"].get("total", 0) + value
        )

    return dimensions


# ---------------------------------------------------------------------------
# Main async orchestrator (single subscription)
# ---------------------------------------------------------------------------

async def _run_cost_analysis(body: Dict) -> Tuple[Dict, int]:
    """Core async logic for a single subscription — returns (response_dict, status_code)."""

    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object")

    # --- Parse single subscription_id (accepts multiple input key names) ---
    subscription_id = (
        body.get("subscription_id")
        or body.get("subscriptionId")
        or body.get("subscription_ids")
        or body.get("subscriptions")
    )

    if isinstance(subscription_id, list):
        subscription_id = subscription_id[0] if subscription_id else None

    if not subscription_id or not str(subscription_id).strip():
        raise ValueError(
            "Provide 'subscription_id' or 'subscriptions' as a string or list"
        )

    subscription_id = str(subscription_id).strip()
    logging.info("Cost analysis started for subscription: %s", subscription_id)

    async def collect_cost_data():
        token = await asyncio.to_thread(get_token)
        timeout = httpx.Timeout(HTTP_TIMEOUT, connect=min(15, HTTP_TIMEOUT))
        async with httpx.AsyncClient(
            timeout=timeout,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
        ) as client:
            return await asyncio.gather(
                _get_cost_with_groupings(
                    client, subscription_id, token,
                    ["ServiceName", "ResourceGroupName"],
                ),
                _get_cost_with_groupings(
                    client, subscription_id, token,
                    ["ResourceId"],
                ),
                return_exceptions=True,
            )

    try:
        cost_data_primary, cost_data_resource = await asyncio.wait_for(
            collect_cost_data(),
            timeout=GLOBAL_TIMEOUT,
        )
    except asyncio.TimeoutError:
        logging.error("Global timeout (%ss) exceeded for subscription %s", GLOBAL_TIMEOUT, subscription_id)
        return {
            "error": f"Cost analysis timed out after {GLOBAL_TIMEOUT}s. Please retry in a few minutes.",
            "processing_summary": {
                "total_subscriptions": 1,
                "completed_subscriptions": 0,
                "failed_subscriptions": 1,
                "completed_subscription_ids": [],
                "failed_subscription_details": [
                    {"subscriptionId": subscription_id, "error": "Global timeout exceeded"}
                ],
            },
        }, 504

    warnings = []
    if isinstance(cost_data_resource, Exception):
        logging.warning("ResourceId cost call failed for %s: %s", subscription_id, str(cost_data_resource))
        warnings.append(f"Cost by ResourceId unavailable: {str(cost_data_resource)}")
        cost_data_resource = {"properties": {"rows": [], "columns": []}}

    if isinstance(cost_data_primary, Exception):
        logging.error("Primary cost call failed for %s: %s", subscription_id, str(cost_data_primary))
        return {
            "error": str(cost_data_primary),
            "processing_summary": {
                "total_subscriptions": 1,
                "completed_subscriptions": 0,
                "failed_subscriptions": 1,
                "completed_subscription_ids": [],
                "failed_subscription_details": [
                    {"subscriptionId": subscription_id, "error": str(cost_data_primary)}
                ],
            },
        }, 500

    # --- Merge dimensions ---
    cost_dims = extract_dimensions_from_unified_response(cost_data_primary)
    cost_dims_resource = extract_dimensions_from_unified_response(cost_data_resource)

    merged_resource = dict(cost_dims.get("resource", {}))
    for key, value in cost_dims_resource.get("resource", {}).items():
        merged_resource[key] = merged_resource.get(key, 0) + value
    cost_dims["resource"] = merged_resource

    sub_total = cost_dims.get("subscription_total", {}).get("total", 0)

    logging.info("Cost analysis completed for subscription: %s", subscription_id)

    # --- Build response (identical structure to original) ---
    dimension_config = [
        ("by_service", cost_dims.get("service", {})),
        ("by_resource_group", cost_dims.get("resource_group", {})),
        ("by_resource", cost_dims.get("resource", {})),
        ("by_subscription", {subscription_id: round(sub_total, 2)}),
        ("by_charge_type", cost_dims.get("charge_type", {})),
        ("by_location", cost_dims.get("location", {})),
        ("by_product", cost_dims.get("product", {})),
        ("by_resource_type", cost_dims.get("resource_type", {})),
        ("by_meter", cost_dims.get("meter", {})),
        ("by_meter_category", cost_dims.get("meter_category", {})),
        ("by_meter_sub_category", cost_dims.get("meter_sub_category", {})),
        ("by_pricing_model", cost_dims.get("pricing_model", {})),
        ("by_frequency", cost_dims.get("frequency", {})),
        ("by_part_number", cost_dims.get("part_number", {})),
        ("by_invoice_id", cost_dims.get("invoice_id", {})),
        ("by_reservation", cost_dims.get("reservation", {})),
        ("by_publisher_type", cost_dims.get("publisher_type", {})),
    ]

    response = {
        "cost_analysis": {
            "dimensions": [
                {
                    "dimensionKey": dim_key,
                    "data": [
                        {"name": k, "value": round(v, 2)}
                        for k, v in data_map.items()
                    ],
                }
                for dim_key, data_map in dimension_config
            ]
        },
        "warnings": warnings,
        "processing_summary": {
            "total_subscriptions": 1,
            "completed_subscriptions": 1,
            "failed_subscriptions": 0,
            "completed_subscription_ids": [subscription_id],
            "failed_subscription_details": [],
        },
    }

    return response, 200


# ---------------------------------------------------------------------------
# Azure Function entry point (synchronous — uses asyncio.run internally)
# ---------------------------------------------------------------------------

def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON input"}),
            status_code=400,
            mimetype="application/json",
        )

    try:
        response_data, status_code = asyncio.run(_run_cost_analysis(body))
        return func.HttpResponse(
            json.dumps(response_data),
            status_code=status_code,
            mimetype="application/json",
        )

    except ValueError as exc:
        return func.HttpResponse(
            json.dumps({"error": str(exc)}),
            status_code=400,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.exception("Error in cost analysis function: %s", str(exc))
        return func.HttpResponse(
            json.dumps({"error": str(exc)}),
            status_code=500,
            mimetype="application/json",
        )
