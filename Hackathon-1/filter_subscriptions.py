import json
import logging
import os
from typing import Dict, List
import re

import azure.functions as func
from azure.core.exceptions import AzureError
from azure.data.tables import TableServiceClient

FILTER_FIELDS = [
    "stla_environment",
    "stla_global_business",
    "stla_global_subfunction",
    "stla_region",
    "stla_application_name",
]


def _normalize_text(value) -> str:
    return str(value or "").strip()


def _canonical_region(value) -> str:
    return re.sub(r"[^a-z0-9]", "", _normalize_text(value).lower())


def _canonical_token(value) -> str:
    return re.sub(r"[\s_-]+", "", _normalize_text(value).lower())


def _field_value_matches(field: str, expected, actual) -> bool:
    expected_text = _normalize_text(expected)
    actual_text = _normalize_text(actual)
    if not expected_text:
        return True

    if field == "stla_region":
        return _canonical_region(expected_text) == _canonical_region(actual_text)

    if field in {"stla_environment", "stla_global_business", "stla_global_subfunction"}:
        return _canonical_token(expected_text) == _canonical_token(actual_text)

    return expected_text.lower() == actual_text.lower()


def fetch_subscriptions_from_table() -> List[Dict]:
    connection_string = os.environ["STORAGE_CONNECTION_STRING"]
    table_name = os.environ.get("SUBSCRIPTIONS_TABLE_NAME", "Subscriptions")

    service_client = TableServiceClient.from_connection_string(conn_str=connection_string)
    table_client = service_client.get_table_client(table_name=table_name)

    entities = table_client.query_entities(
        query_filter="PartitionKey eq 'subscriptions' or PartitionKey eq 'Subscriptions'",
        results_per_page=500,
    )

    subscriptions = []
    for page in entities.by_page():
        for entity in page:
            partition = _normalize_text(entity.get("PartitionKey"))
            if partition.lower() != "subscriptions":
                continue
            subscriptions.append(entity)

    return subscriptions


def filter_subscriptions(subscriptions: List[Dict], filters: Dict) -> List[Dict]:
    active_filters = {
        key: value
        for key, value in filters.items()
        if key in FILTER_FIELDS and _normalize_text(value)
    }

    if not active_filters:
        return subscriptions

    return [
        sub for sub in subscriptions
        if all(_field_value_matches(key, value, sub.get(key)) for key, value in active_filters.items())
    ]


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Filtering subscriptions from Azure Table Storage")

    try:
        payload = req.get_json()
    except ValueError:
        # If no payload or invalid JSON, treat as empty filter to return all subscriptions
        logging.info("No payload provided, returning all subscriptions")
        payload = {}

    try:
        if not isinstance(payload, dict):
            return func.HttpResponse(
                json.dumps({
                    "status": "BadRequest",
                    "message": "Request body must be a JSON object"
                }),
                status_code=400,
                mimetype="application/json"
            )

        subscriptions = fetch_subscriptions_from_table()
        matched = filter_subscriptions(subscriptions, payload)

        response = [
            {
                "subscriptionId": sub.get("RowKey", ""),
                "subscriptionName": sub.get("displayName", ""),
                "stla_region": sub.get("stla_region", ""),
                "stla_environment": sub.get("stla_environment", ""),
                "stla_global_business": sub.get("stla_global_business", ""),
                "stla_global_subfunction": sub.get("stla_global_subfunction", ""),
                "stla_application_name": sub.get("stla_application_name", ""),
            }
            for sub in matched
        ]

        return func.HttpResponse(
            json.dumps(response),
            status_code=200,
            mimetype="application/json"
        )

    except AzureError as exc:
        logging.exception("Azure Table Storage error while filtering subscriptions: %s", str(exc))
        return func.HttpResponse(
            json.dumps({
                "status": "Error",
                "message": "Failed to read from Table Storage",
                "details": str(exc),
            }),
            status_code=500,
            mimetype="application/json"
        )
    except Exception as exc:
        logging.exception("Unexpected error while filtering subscriptions: %s", str(exc))
        return func.HttpResponse(
            json.dumps({
                "status": "Error",
                "message": "Internal server error",
                "details": str(exc),
            }),
            status_code=500,
            mimetype="application/json"
        )
