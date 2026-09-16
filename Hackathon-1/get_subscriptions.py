import logging
import json
import os
import azure.functions as func
from azure.identity import ClientSecretCredential
from azure.data.tables import TableServiceClient, UpdateMode
import requests

REQUEST_TIMEOUT_SECONDS = 30

def get_access_token():
    tenant_id = os.environ["AZURE_TENANT_ID"]
    client_id = os.environ["AZURE_CLIENT_ID"]
    client_secret = os.environ["AZURE_CLIENT_SECRET"]
    credential = ClientSecretCredential(tenant_id=tenant_id, client_id=client_id, client_secret=client_secret)
    token = credential.get_token("https://management.azure.com/.default")
    return token.token


def store_subscriptions_in_table(subscriptions: list):
    connection_string = os.environ["STORAGE_CONNECTION_STRING"]
    table_name = os.environ.get("SUBSCRIPTIONS_TABLE_NAME", "Subscriptions")

    service_client = TableServiceClient.from_connection_string(conn_str=connection_string)
    service_client.create_table_if_not_exists(table_name)
    table_client = service_client.get_table_client(table_name)

    for sub in subscriptions:
        entity = {
            "PartitionKey": "subscriptions",
            "RowKey": sub["subscriptionId"],
            "displayName": sub["displayName"],
            "stla_environment": sub["stla_environment"],
            "stla_global_business": sub["stla_global_business"],
            "stla_global_subfunction": sub["stla_global_subfunction"],
            "stla_region": sub["stla_region"],
            "stla_application_name": sub["stla_application_name"],
            "tags": json.dumps(sub["tags"])
        }
        table_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)

    logging.info(f"Stored {len(subscriptions)} subscriptions in table '{table_name}'")


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Fetching all subscriptions")

    try:
        token = get_access_token()

        url = "https://management.azure.com/subscriptions?api-version=2020-01-01"

        headers = {
            "Authorization": f"Bearer {token}"
        }

        subscriptions = []

        while url:
            response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)

            if response.status_code != 200:
                return func.HttpResponse(
                    json.dumps({
                        "status": "Failed",
                        "error": response.text
                    }),
                    status_code=500,
                    mimetype="application/json"
                )

            data = response.json()

            for sub in data.get("value", []):
                tags = sub.get("tags") or {}
                subscriptions.append({
                    "subscriptionId": sub.get("subscriptionId", ""),
                    "displayName": sub.get("displayName", ""),
                    "stla_environment": tags.get("stla_environment", ""),
                    "stla_global_business": tags.get("stla_global_business", ""),
                    "stla_global_subfunction": tags.get("stla_global_subfunction", ""),
                    "stla_region": tags.get("stla_region", ""),
                    "stla_application_name": tags.get("stla_application_name", ""),
                    "tags": tags
                })

            url = data.get("nextLink")

        store_subscriptions_in_table(subscriptions)

        return func.HttpResponse(
            json.dumps({
                "status": "Success",
                "count": len(subscriptions),
                "subscriptions": subscriptions
            }),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        return func.HttpResponse(
            json.dumps({
                "status": "Error",
                "message": str(e)
            }),
            status_code=500,
            mimetype="application/json"
        )