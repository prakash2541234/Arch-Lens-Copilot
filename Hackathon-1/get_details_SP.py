import json
import logging
import os
import sys
import traceback

import azure.functions as func
from azure.identity import ClientSecretCredential
from azure.mgmt.resourcegraph import ResourceGraphClient
from azure.mgmt.resourcegraph.models import QueryRequest


def clean_resource(resource: dict) -> dict:
    """Return only the relevant fields for a resource."""
    return {
        "id":            resource.get("id"),
        "name":          resource.get("name"),
        "type":          resource.get("type"),
        "location":      resource.get("location"),
        "resourceGroup": resource.get("resourceGroup"),
        "subscriptionId":resource.get("subscriptionId"),
        "properties":    resource.get("properties"),
    }


def build_grouped_resource_tree(resources: list[dict]) -> dict:
    """Group resources by subscription and then by resource group."""
    grouped: dict[str, dict] = {}

    for resource in resources:
        subscription = resource.get("subscriptionId") or "unknown-subscription"
        resource_group = (resource.get("resourceGroup") or "no-resource-group").lower()

        if subscription not in grouped:
            grouped[subscription] = {"resource_groups": {}}

        rg_map = grouped[subscription]["resource_groups"]
        if resource_group not in rg_map:
            rg_map[resource_group] = {"resource_count": 0, "resources": []}

        rg_map[resource_group]["resources"].append(clean_resource(resource))
        rg_map[resource_group]["resource_count"] += 1

    # add per-subscription summary
    for sub_id, sub_data in grouped.items():
        sub_data["total_resource_groups"] = len(sub_data["resource_groups"])
        sub_data["total_resources"] = sum(
            rg["resource_count"] for rg in sub_data["resource_groups"].values()
        )

    return grouped


def build_error_response(status_code: int, stage: str, error_type: str, error_message: str, exception: Exception | None = None) -> func.HttpResponse:
    """Create a detailed error response showing where and why a failure happened."""
    location = None
    traceback_text = None

    if exception is not None:
        exc_traceback = exception.__traceback__
        if exc_traceback:
            tb_line = traceback.extract_tb(exc_traceback)[-1]
            location = f"{tb_line.filename}:{tb_line.lineno} in {tb_line.name}"
        traceback_text = traceback.format_exc()

    error_payload = {
        "status": "error",
        "failure_stage": stage,
        "error_type": error_type,
        "message": error_message,
        "reason": f"Failure occurred during '{stage}' because: {error_message}",
        "location": location or f"Unknown location during '{stage}'",
        "traceback": traceback_text,
    }

    logging.error(json.dumps(error_payload, indent=2, default=str))

    return func.HttpResponse(
        json.dumps(error_payload, indent=2, default=str),
        status_code=status_code,
        mimetype="application/json"
    )


def main(req: func.HttpRequest) -> func.HttpResponse:
    """Main function to handle subscription resource discovery."""
    logging.info("ArchLens - Resource Discovery Started")
    stage = "request parsing"

    try:
        body = req.get_json()
        subscription_id = body.get("subscription_id")
        subscription_ids = body.get("subscription_ids")

        subscriptions: list[str] = []

        if isinstance(subscription_id, str) and subscription_id.strip():
            subscriptions.extend([part.strip() for part in subscription_id.split(",") if part.strip()])

        if isinstance(subscription_ids, str) and subscription_ids.strip():
            subscriptions.extend([part.strip() for part in subscription_ids.split(",") if part.strip()])
        elif isinstance(subscription_ids, list):
            subscriptions.extend([
                str(item).strip()
                for item in subscription_ids
                if isinstance(item, str) and item.strip()
            ])

        deduped_subscriptions = []
        seen_subscriptions = set()
        for subscription in subscriptions:
            if subscription in seen_subscriptions:
                continue
            seen_subscriptions.add(subscription)
            deduped_subscriptions.append(subscription)

        subscriptions = deduped_subscriptions

        if not subscriptions:
            return build_error_response(
                status_code=400,
                stage=stage,
                error_type="MissingInput",
                error_message="Provide 'subscription_id' or 'subscription_ids' as string, comma-separated string, or list of strings"
            )

        # 🔐 Authentication (Service Principal)
        stage = "service principal configuration"
        tenant_id = os.getenv("AZURE_TENANT_ID")
        client_id = os.getenv("AZURE_CLIENT_ID")
        client_secret = os.getenv("AZURE_CLIENT_SECRET")

        missing_env_vars = [
            env_var
            for env_var, env_value in {
                "AZURE_TENANT_ID": tenant_id,
                "AZURE_CLIENT_ID": client_id,
                "AZURE_CLIENT_SECRET": client_secret,
            }.items()
            if not env_value
        ]

        if missing_env_vars:
            raise ValueError(
                "Missing required environment variables for service principal authentication: "
                + ", ".join(missing_env_vars)
            )

        stage = "service principal authentication"
        credential = ClientSecretCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret
        )

        # 📡 Resource Graph Client
        stage = "resource graph client creation"
        client = ResourceGraphClient(credential)

        # 🔍 Query (GET EVERYTHING)
        stage = "resource graph query preparation"
        query = """
        Resources
        | project id, name, type, location, resourceGroup, subscriptionId, properties
        """

        request = QueryRequest(subscriptions=subscriptions, query=query)

        stage = "resource graph query execution"
        response = client.resources(request)

        stage = "response processing"
        resources = list(response.data)
        grouped_data = build_grouped_resource_tree(resources)

        logging.info(f"Total resources fetched: {len(resources)}")

        response_payload = {
            "status": "success",
            "subscriptions_requested": subscriptions,
            "total_resources": len(resources),
            "data": grouped_data
        }

        return func.HttpResponse(
            json.dumps(response_payload, indent=2, default=str),
            status_code=200,
            mimetype="application/json"
        )

    except json.JSONDecodeError as e:
        return build_error_response(
            status_code=400,
            stage=stage,
            error_type="JSONDecodeError",
            error_message=f"Invalid JSON format: {str(e)}",
            exception=e
        )
    
    except ValueError as e:
        return build_error_response(
            status_code=400,
            stage=stage,
            error_type="ValueError",
            error_message=f"Validation failed: {str(e)}",
            exception=e
        )
    
    except PermissionError as e:
        return build_error_response(
            status_code=403,
            stage=stage,
            error_type="PermissionError",
            error_message=f"Authentication or authorization failed: {str(e)}",
            exception=e
        )
    
    except Exception as e:
        return build_error_response(
            status_code=500,
            stage=stage,
            error_type=type(e).__name__,
            error_message=str(e),
            exception=e
        )