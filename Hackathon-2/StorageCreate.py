import json
import logging
import os

import azure.functions as func
from azure.core.exceptions import HttpResponseError
from azure.identity import ClientSecretCredential
from azure.mgmt.storage import StorageManagementClient
from azure.mgmt.storage.models import Sku, StorageAccountCreateParameters

APPLICATION_JSON = "application/json"


def _response(status_code: int, body: dict) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(body, indent=2),
        status_code=status_code,
        mimetype=APPLICATION_JSON,
    )


def _validate_env() -> list:
    required = {
        "TENANT_ID": os.environ.get("TENANT_ID"),
        "APP_ID": os.environ.get("APP_ID"),
        "APP_SECRET": os.environ.get("APP_SECRET"),
    }
    return [key for key, value in required.items() if not value]


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Storage account create function triggered")

    correlation_id = (
        req.headers.get("x-correlation-id")
        or req.headers.get("x-ms-request-id")
    )

    try:
        req_body = req.get_json()
        correlation_id = req_body.get("correlation_id") or correlation_id
    except ValueError:
        return _response(
            400,
            {
                "status": "error",
                "message": "Invalid JSON body",
                "correlation_id": correlation_id,
            },
        )

    required_fields = ["subscription_id", "resource_group", "storage_account_name", "location"]
    missing_fields = [field for field in required_fields if not req_body.get(field)]
    if missing_fields:
        return _response(
            400,
            {
                "status": "error",
                "message": f"Missing required fields: {', '.join(missing_fields)}",
                "correlation_id": correlation_id,
                "details": {
                    "required_fields": required_fields,
                },
            },
        )

    missing_env = _validate_env()
    if missing_env:
        return _response(
            500,
            {
                "status": "error",
                "message": "Missing required environment variables",
                "correlation_id": correlation_id,
                "details": {
                    "missing_env_vars": missing_env,
                },
            },
        )

    subscription_id = req_body["subscription_id"]
    resource_group = req_body["resource_group"]
    storage_account_name = req_body["storage_account_name"].lower()
    location = req_body["location"]

    sku_name = req_body.get("sku", "Standard_LRS")
    kind = req_body.get("kind", "StorageV2")
    access_tier = req_body.get("access_tier", "Hot")
    tags = req_body.get("tags", {})

    try:
        credential = ClientSecretCredential(
            tenant_id=os.environ.get("TENANT_ID"),
            client_id=os.environ.get("APP_ID"),
            client_secret=os.environ.get("APP_SECRET"),
        )

        storage_client = StorageManagementClient(credential, subscription_id)

        parameters = StorageAccountCreateParameters(
            sku=Sku(name=sku_name),
            kind=kind,
            location=location,
            access_tier=access_tier,
            tags=tags,
        )

        poller = storage_client.storage_accounts.begin_create(
            resource_group_name=resource_group,
            account_name=storage_account_name,
            parameters=parameters,
        )
        result = poller.result()

        response = {
            "status": "success",
            "message": f"Storage account '{storage_account_name}' created successfully",
            "correlation_id": correlation_id,
            "details": {
                "subscription_id": subscription_id,
                "resource_group": resource_group,
                "storage_account_name": storage_account_name,
                "location": location,
                "sku": sku_name,
                "kind": kind,
                "access_tier": access_tier,
                "id": result.id,
                "primary_endpoints": result.primary_endpoints.as_dict() if result.primary_endpoints else None,
            },
        }

        return _response(200, response)

    except HttpResponseError as exc:
        logging.error("Storage creation failed: %s", str(exc), exc_info=True)
        return _response(
            500,
            {
                "status": "error",
                "message": "Failed to create storage account",
                "correlation_id": correlation_id,
                "details": {
                    "error": str(exc),
                },
            },
        )
    except Exception as exc:
        logging.error("Unexpected error during storage creation: %s", str(exc), exc_info=True)
        return _response(
            500,
            {
                "status": "error",
                "message": "Unexpected error while creating storage account",
                "correlation_id": correlation_id,
                "details": {
                    "error": str(exc),
                },
            },
        )
