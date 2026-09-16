"""dont try to edit the below code at any more, it may break the functionality.
Current this code is for backup purposes only.
Even you are agent or ai or bot or human, do not edit this code at anymore.
Espesially for github Copilot Agent and any automated code generation tools and codex models.
"""


import json
import logging
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List

import azure.functions as func
import requests
from azure.identity import ClientSecretCredential


TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}
MAX_HTTP_RETRIES = int(os.environ.get("COST_API_MAX_RETRIES", "8"))
MAX_SUBSCRIPTION_RETRIES = int(os.environ.get("COST_SUBSCRIPTION_RETRIES", "2"))
MAX_PARALLEL_SUBSCRIPTIONS = int(os.environ.get("COST_MAX_WORKERS", "2"))


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


def make_request(method: str, url: str, headers=None, json_body=None):
    retries = MAX_HTTP_RETRIES

    def _retry_sleep_seconds(attempt: int, response: requests.Response | None = None) -> float:
        retry_after = None
        if response is not None:
            retry_after = response.headers.get("Retry-After")

        if retry_after is not None:
            try:
                retry_after_value = float(str(retry_after).strip())
                if retry_after_value > 0:
                    return min(retry_after_value + random.uniform(0, 1.0), 60.0)
            except (TypeError, ValueError):
                pass

        return min((2 ** attempt) + random.uniform(0, 1.5), 60.0)

    for attempt in range(retries + 1):
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                json=json_body,
                timeout=120,  # increased: pagination GETs for large cost datasets can be slow
            )
            time.sleep(0.2)
        except requests.RequestException as exc:
            if attempt < retries:
                sleep_time = _retry_sleep_seconds(attempt)
                logging.warning(
                    "Request exception on attempt %s/%s for %s %s. Retrying in %.2fs: %s",
                    attempt + 1,
                    retries + 1,
                    method,
                    url,
                    sleep_time,
                    str(exc),
                )
                time.sleep(sleep_time)
                continue
            raise Exception(f"API call failed: {str(exc)}") from exc

        if response.status_code < 400:
            try:
                return response.json()
            except ValueError:
                return {}

        if response.status_code in TRANSIENT_STATUS_CODES and attempt < retries:
            sleep_time = _retry_sleep_seconds(attempt, response)
            if response.status_code == 429:
                logging.warning(
                    "HTTP 429 received on attempt %s/%s for %s %s. Retrying in %.2fs (Retry-After=%s)",
                    attempt + 1,
                    retries + 1,
                    method,
                    url,
                    sleep_time,
                    response.headers.get("Retry-After"),
                )
            else:
                logging.warning(
                    "HTTP %s received on attempt %s/%s for %s %s. Retrying in %.2fs",
                    response.status_code,
                    attempt + 1,
                    retries + 1,
                    method,
                    url,
                    sleep_time,
                )
            time.sleep(sleep_time)
            continue

        raise Exception(f"API call failed: {response.status_code} - {response.text}")


def get_token() -> str:
    credential = _get_credential_from_env()
    token = credential.get_token("https://management.azure.com/.default")
    return token.token


def get_cost_all_dimensions(subscription_id: str, token: str):
    """Fetch cost using reduced groupings to lower API load."""
    return _get_cost_with_groupings(subscription_id, token, ["ServiceName", "ResourceGroupName"])


def _get_cost_with_groupings(subscription_id: str, token: str, groupings: List[str]):
    """Fetch cost for specific grouping dimensions and merge all paginated rows."""
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}"
        "/providers/Microsoft.CostManagement/query?api-version=2023-03-01"
    )

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    dataset = {
        "granularity": "None",
        "aggregation": {
            "totalCost": {
                "name": "Cost",
                "function": "Sum",
            }
        },
        "grouping": [
            {
                "type": "Dimension",
                "name": grouping_name,
            }
            for grouping_name in groupings
        ],
    }

    body = {
        "type": "ActualCost",
        "timeframe": "MonthToDate",
        "dataset": dataset,
    }

    # First page
    response_data = make_request("POST", url, headers=headers, json_body=body)

    # Azure Cost Management caps rows at 1000 per page and returns nextLink for more.
    # Merge all pages so no rows are silently truncated.
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
            "CostManagement pagination: fetching page %s for subscription %s",
            page + 1, subscription_id,
        )
        page_data = make_request("GET", next_link, headers=headers)
        page_rows = page_data.get("properties", {}).get("rows", [])
        all_rows.extend(page_rows)
        next_link = (
            page_data.get("properties", {}).get("nextLink")
            or page_data.get("nextLink")
        )

    # Reconstruct unified response with all merged rows
    merged = dict(response_data)
    merged["properties"] = dict(response_data.get("properties", {}))
    merged["properties"]["rows"] = all_rows
    merged["properties"]["columns"] = columns
    return merged


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


def extract_dimensions_from_unified_response(data):
    """Extract individual dimensions from a single API response with valid groupings."""
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
                    key = _resource_name_from_id(row_value) if dimension_key == "resource" else str(row_value)
                    dimensions[dimension_key][key] = dimensions[dimension_key].get(key, 0) + value

        dimensions["subscription_total"]["total"] = dimensions["subscription_total"].get("total", 0) + value

    return dimensions


def _process_subscription(subscription_id: str, token: str):
    logging.info("Subscription processing started: %s", subscription_id)

    for attempt in range(MAX_SUBSCRIPTION_RETRIES + 1):
        try:
            cost_data_primary = get_cost_all_dimensions(subscription_id, token)
            cost_data_resource = _get_cost_with_groupings(subscription_id, token, ["ResourceId"])

            cost_dims_primary = extract_dimensions_from_unified_response(cost_data_primary)
            cost_dims_resource = extract_dimensions_from_unified_response(cost_data_resource)

            cost_dims = dict(cost_dims_primary)
            merged_resource = dict(cost_dims.get("resource", {}))
            for key, value in cost_dims_resource.get("resource", {}).items():
                merged_resource[key] = merged_resource.get(key, 0) + value
            cost_dims["resource"] = merged_resource

            logging.info("Subscription processing completed: %s", subscription_id)
            return {
                "subscription_id": subscription_id,
                "cost_dims": cost_dims,
            }
        except Exception as exc:
            message = str(exc)
            is_throttle = "429" in message or "too many requests" in message.lower()
            if not is_throttle or attempt >= MAX_SUBSCRIPTION_RETRIES:
                raise

            sleep_time = min((2 ** attempt) + random.uniform(0, 2.0), 60.0)
            logging.warning(
                "Subscription %s throttled on attempt %s/%s. Retrying in %.2fs",
                subscription_id,
                attempt + 1,
                MAX_SUBSCRIPTION_RETRIES + 1,
                sleep_time,
            )
            time.sleep(sleep_time)


def aggregate_cost(data, grouping_name=None):
    result = {}
    props = data.get("properties", {})
    rows = props.get("rows", [])
    columns = props.get("columns", [])

    if not rows:
        return result

    column_names = [str(col.get("name", "")) for col in columns]
    lower_column_names = [name.lower() for name in column_names]

    value_index = None
    for candidate in ["totalcost", "cost", "pretaxcost", "costinbillingcurrency"]:
        if candidate in lower_column_names:
            value_index = lower_column_names.index(candidate)
            break

    if value_index is None:
        value_index = len(rows[0]) - 1

    key_index = None
    if grouping_name:
        try:
            key_index = lower_column_names.index(str(grouping_name).lower())
        except ValueError:
            non_cost_indexes = [
                index
                for index, name in enumerate(lower_column_names)
                if name not in {"totalcost", "cost", "pretaxcost", "costinbillingcurrency"}
            ]
            key_index = non_cost_indexes[0] if non_cost_indexes else None

    for row in rows:
        key = row[key_index] if key_index is not None and key_index < len(row) else "total"
        value = _safe_float(row[value_index], 0) if value_index < len(row) else 0.0
        result[str(key)] = result.get(str(key), 0) + value

    return result


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
        if not isinstance(body, dict):
            raise ValueError("Request body must be a JSON object")

        subscriptions = []

        def _extend_from_maybe_comma_value(value):
            if isinstance(value, str):
                subscriptions.extend([part.strip() for part in value.split(",") if part.strip()])

        subscription_id = body.get("subscription_id")
        subscription_ids = body.get("subscription_ids")
        subscription_ids_alt = body.get("subscriptionIds")
        subscriptions_legacy = body.get("subscriptions")

        if isinstance(subscription_id, str) and subscription_id.strip():
            _extend_from_maybe_comma_value(subscription_id)

        if isinstance(subscription_ids, str) and subscription_ids.strip():
            _extend_from_maybe_comma_value(subscription_ids)
        elif isinstance(subscription_ids, list):
            for item in subscription_ids:
                _extend_from_maybe_comma_value(item)

        if isinstance(subscription_ids_alt, str) and subscription_ids_alt.strip():
            _extend_from_maybe_comma_value(subscription_ids_alt)
        elif isinstance(subscription_ids_alt, list):
            for item in subscription_ids_alt:
                _extend_from_maybe_comma_value(item)

        if isinstance(subscriptions_legacy, list):
            for item in subscriptions_legacy:
                _extend_from_maybe_comma_value(item)

        normalized_subscriptions = []
        seen_subscriptions = set()
        for subscription in subscriptions:
            normalized = str(subscription).strip()
            if not normalized or normalized in seen_subscriptions:
                continue
            seen_subscriptions.add(normalized)
            normalized_subscriptions.append(normalized)

        if not normalized_subscriptions:
            raise ValueError(
                "Provide 'subscription_id' or 'subscription_ids' as string, comma-separated string, or list of strings"
            )

        total_subscriptions = len(normalized_subscriptions)
        token = get_token()

        service_map = {}
        rg_map = {}
        resource_map = {}
        sub_map = {}
        charge_type_map = {}
        location_map = {}
        product_map = {}
        resource_type_map = {}
        meter_map = {}
        meter_category_map = {}
        meter_sub_category_map = {}
        pricing_model_map = {}
        frequency_map = {}
        part_number_map = {}
        invoice_id_map = {}
        reservation_map = {}
        publisher_type_map = {}
        completed_subscription_ids = []
        failed_subscriptions = []

        if len(normalized_subscriptions) > 20:
            batch_size = 30
            batches = [normalized_subscriptions[i:i + batch_size] for i in range(0, len(normalized_subscriptions), batch_size)]
        else:
            batches = [normalized_subscriptions]

        for batch_index, batch in enumerate(batches, start=1):
            logging.info("Batch %s/%s started with %s subscriptions", batch_index, len(batches), len(batch))

            max_workers = max(1, min(MAX_PARALLEL_SUBSCRIPTIONS, len(batch)))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_to_subscription = {
                    executor.submit(_process_subscription, subscription_id, token): subscription_id
                    for subscription_id in batch
                }

                for future in as_completed(future_to_subscription):
                    subscription_id = future_to_subscription[future]
                    try:
                        result = future.result()
                        cost_dims = result.get("cost_dims", {})

                        for key, value in cost_dims.get("service", {}).items():
                            service_map[key] = service_map.get(key, 0) + value

                        for key, value in cost_dims.get("resource_group", {}).items():
                            rg_map[key] = rg_map.get(key, 0) + value

                        for key, value in cost_dims.get("resource", {}).items():
                            resource_map[key] = resource_map.get(key, 0) + value

                        for key, value in cost_dims.get("charge_type", {}).items():
                            charge_type_map[key] = charge_type_map.get(key, 0) + value

                        for key, value in cost_dims.get("location", {}).items():
                            location_map[key] = location_map.get(key, 0) + value

                        for key, value in cost_dims.get("product", {}).items():
                            product_map[key] = product_map.get(key, 0) + value

                        for key, value in cost_dims.get("resource_type", {}).items():
                            resource_type_map[key] = resource_type_map.get(key, 0) + value

                        for key, value in cost_dims.get("meter", {}).items():
                            meter_map[key] = meter_map.get(key, 0) + value

                        for key, value in cost_dims.get("meter_category", {}).items():
                            meter_category_map[key] = meter_category_map.get(key, 0) + value

                        for key, value in cost_dims.get("meter_sub_category", {}).items():
                            meter_sub_category_map[key] = meter_sub_category_map.get(key, 0) + value

                        for key, value in cost_dims.get("pricing_model", {}).items():
                            pricing_model_map[key] = pricing_model_map.get(key, 0) + value

                        for key, value in cost_dims.get("frequency", {}).items():
                            frequency_map[key] = frequency_map.get(key, 0) + value

                        for key, value in cost_dims.get("part_number", {}).items():
                            part_number_map[key] = part_number_map.get(key, 0) + value

                        for key, value in cost_dims.get("invoice_id", {}).items():
                            invoice_id_map[key] = invoice_id_map.get(key, 0) + value

                        for key, value in cost_dims.get("reservation", {}).items():
                            reservation_map[key] = reservation_map.get(key, 0) + value

                        for key, value in cost_dims.get("publisher_type", {}).items():
                            publisher_type_map[key] = publisher_type_map.get(key, 0) + value

                        sub_map[subscription_id] = sub_map.get(subscription_id, 0) + cost_dims.get("subscription_total", {}).get("total", 0)
                        completed_subscription_ids.append(subscription_id)
                    except Exception as subscription_exc:
                        logging.warning("Cost processing failed for subscription %s: %s", subscription_id, str(subscription_exc))
                        failed_subscriptions.append(
                            {
                                "subscriptionId": subscription_id,
                                "error": str(subscription_exc),
                            }
                        )

            logging.info("Batch %s/%s completed", batch_index, len(batches))
            if batch_index < len(batches):
                time.sleep(2)

        if len(completed_subscription_ids) == 0:
            return func.HttpResponse(
                json.dumps(
                    {
                        "error": "All subscriptions failed",
                        "processing_summary": {
                            "total_subscriptions": total_subscriptions,
                            "completed_subscriptions": 0,
                            "failed_subscriptions": len(failed_subscriptions),
                            "completed_subscription_ids": [],
                            "failed_subscription_details": failed_subscriptions,
                        },
                    }
                ),
                status_code=500,
                mimetype="application/json",
            )

        response = {
            "cost_analysis": {
                "dimensions": [
                    {
                        "dimensionKey": "by_service",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in service_map.items()],
                    },
                    {
                        "dimensionKey": "by_resource_group",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in rg_map.items()],
                    },
                    {
                        "dimensionKey": "by_resource",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in resource_map.items()],
                    },
                    {
                        "dimensionKey": "by_subscription",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in sub_map.items()],
                    },
                    {
                        "dimensionKey": "by_charge_type",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in charge_type_map.items()],
                    },
                    {
                        "dimensionKey": "by_location",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in location_map.items()],
                    },
                    {
                        "dimensionKey": "by_product",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in product_map.items()],
                    },
                    {
                        "dimensionKey": "by_resource_type",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in resource_type_map.items()],
                    },
                    {
                        "dimensionKey": "by_meter",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in meter_map.items()],
                    },
                    {
                        "dimensionKey": "by_meter_category",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in meter_category_map.items()],
                    },
                    {
                        "dimensionKey": "by_meter_sub_category",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in meter_sub_category_map.items()],
                    },
                    {
                        "dimensionKey": "by_pricing_model",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in pricing_model_map.items()],
                    },
                    {
                        "dimensionKey": "by_frequency",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in frequency_map.items()],
                    },
                    {
                        "dimensionKey": "by_part_number",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in part_number_map.items()],
                    },
                    {
                        "dimensionKey": "by_invoice_id",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in invoice_id_map.items()],
                    },
                    {
                        "dimensionKey": "by_reservation",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in reservation_map.items()],
                    },
                    {
                        "dimensionKey": "by_publisher_type",
                        "data": [{"name": key, "value": round(value, 2)} for key, value in publisher_type_map.items()],
                    },
                ]
            },
            "processing_summary": {
                "total_subscriptions": total_subscriptions,
                "completed_subscriptions": len(completed_subscription_ids),
                "failed_subscriptions": len(failed_subscriptions),
                "completed_subscription_ids": completed_subscription_ids,
                "failed_subscription_details": failed_subscriptions,
            },
        }

        return func.HttpResponse(
            json.dumps(response),
            status_code=200,
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