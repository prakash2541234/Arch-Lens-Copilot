import os
import logging
import json
import random
import re
import time
import uuid
import base64
import azure.functions as func
from azure.core.exceptions import HttpResponseError
from azure.identity import ClientSecretCredential
from azure.keyvault.certificates import CertificateClient
from azure.keyvault.secrets import SecretClient
from azure.mgmt.authorization import AuthorizationManagementClient
from azure.mgmt.keyvault import KeyVaultManagementClient
from azure.mgmt.keyvault.models import (
    VaultCreateOrUpdateParameters,
    VaultProperties,
    Sku,
)
from azure.mgmt.resource.resources import ResourceManagementClient

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

DIGICERT_SECRET_NAMES = {
    "account_id": "digicert-account-id",
    "account_password": "digicert-account-password",
    "org_id": "digicert-org-id",
}
DIGICERT_PROVIDER = "DigiCert"
KEY_VAULT_CERTIFICATES_OFFICER_ROLE_ID = "a4417e6f-fecd-4de8-b567-7b0420556985"
APPLICATION_JSON = "application/json"


def _short_id(value):
    """Returns a short, non-sensitive identifier segment for logs."""
    if not value:
        return "n/a"
    return str(value)[-6:]


def get_current_principal_id(credential):
    """Gets current caller object id (oid) from an ARM access token."""
    logging.info("Resolving caller principal ID from ARM token")
    token = credential.get_token("https://management.azure.com/.default").token
    token_parts = token.split(".")
    if len(token_parts) < 2:
        raise RuntimeError("Unable to parse access token claims for principal ID.")

    payload = token_parts[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload.encode("utf-8")))

    principal_id = claims.get("oid")
    if not principal_id:
        raise RuntimeError("Token does not contain 'oid' claim for principal ID.")

    logging.info("Resolved caller principal ID suffix=%s", _short_id(principal_id))

    return principal_id


def ensure_certificate_ca_permissions(
    credential,
    subscription_id,
    vault_id,
    principal_id,
):
    """Assigns Key Vault Certificates Officer role on the new vault for CA registration."""
    logging.info(
        "Ensuring certificate CA permissions on vault scope for principal suffix=%s",
        _short_id(principal_id),
    )
    auth_client = AuthorizationManagementClient(credential, subscription_id)
    role_definition_id = (
        f"/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Authorization/roleDefinitions/{KEY_VAULT_CERTIFICATES_OFFICER_ROLE_ID}"
    )

    try:
        auth_client.role_assignments.create(
            scope=vault_id,
            role_assignment_name=str(uuid.uuid4()),
            parameters={
                "role_definition_id": role_definition_id,
                "principal_id": principal_id,
            },
        )
        logging.info(
            "Assigned Key Vault Certificates Officer to principal %s on %s",
            principal_id,
            vault_id,
        )
    except HttpResponseError as exc:
        if "RoleAssignmentExists" in str(exc):
            logging.info(
                "Key Vault Certificates Officer already assigned to principal %s",
                principal_id,
            )
            return
        if "AuthorizationFailed" in str(exc):
            logging.warning(
                "Caller cannot create role assignments on %s. Continuing with existing permissions.",
                vault_id,
            )
            return
        raise


def get_digicert_details(credential):
    """
    Fetch DigiCert credentials from the centralized Key Vault.

    Steps:
    1. Read Key Vault name from environment variable
    2. Connect to Key Vault
    3. Fetch required secrets
    """

    # 🔹 Step 1: Get Key Vault name
    central_kv_name = os.environ.get("CentralKeyVaultName", "kv-azglz-prod-std")
    if not central_kv_name:
        raise ValueError("CentralKeyVaultName environment variable is missing.")

    vault_url = f"https://{central_kv_name}.vault.azure.net/"
    logging.info(
        "Fetching DigiCert credentials from central Key Vault=%s", central_kv_name
    )

    try:
        # 🔹 Step 2: Create client
        logging.info(
            "Creating Key Vault SecretClient for DigiCert credential retrieval"
        )
        secret_client = SecretClient(vault_url=vault_url, credential=credential)

        digicert_details = {"provider": DIGICERT_PROVIDER}

        # 🔹 Step 3: Fetch secrets
        for key, secret_name in DIGICERT_SECRET_NAMES.items():
            logging.info("[STEP 3] Fetching secret: %s", secret_name)

            try:
                secret = secret_client.get_secret(secret_name)

                if not secret.value:
                    raise ValueError(f"Secret '{secret_name}' has no value.")

                digicert_details[key] = secret.value

            except Exception as secret_error:
                logging.error(
                    "[ERROR] Failed to fetch secret '%s' from KV '%s'.",
                    secret_name,
                    central_kv_name,
                )
                raise RuntimeError(
                    f"Error fetching secret '{secret_name}': {secret_error}"
                ) from secret_error

        logging.info("[SUCCESS] DigiCert credentials retrieved successfully.")
        return digicert_details

    except Exception as exc:
        logging.error("[FATAL] Key Vault operation failed.")
        logging.error("Vault URL: %s", vault_url)
        logging.error("Actual error: %s", str(exc))

        # Return REAL error instead of hiding it
        raise RuntimeError(f"Key Vault error: {exc}") from exc


def register_digicert_issuer(credential, vault_uri, digicert_details):
    """Registers DigiCert as a certificate issuer in the target Key Vault."""
    issuer_name = os.environ.get("DIGICERT_ISSUER_NAME", "digicert")
    logging.info(
        "Registering certificate issuer '%s' on vault=%s", issuer_name, vault_uri
    )
    cert_client = CertificateClient(vault_url=vault_uri, credential=credential)

    kwargs = {
        "provider": digicert_details["provider"],
        "account_id": digicert_details["account_id"],
        "password": digicert_details["account_password"],
    }

    if digicert_details.get("org_id"):
        kwargs["organization_id"] = digicert_details["org_id"]

    try:
        cert_client.create_issuer(issuer_name, **kwargs)
    except TypeError:
        # Keep compatibility with SDK versions that do not accept organization_id.
        kwargs.pop("organization_id", None)
        cert_client.create_issuer(issuer_name, **kwargs)

    logging.info("Certificate issuer '%s' registered successfully", issuer_name)
    return issuer_name


def register_digicert_issuer_with_retry(
    credential,
    vault_uri,
    digicert_details,
    max_attempts=6,
    delay_seconds=10,
):
    """Retries issuer registration to handle RBAC propagation delay after assignment."""
    for attempt in range(1, max_attempts + 1):
        try:
            return register_digicert_issuer(credential, vault_uri, digicert_details)
        except Exception as exc:
            message = str(exc)
            if (
                "certificatecas/write" not in message
                and "Caller is not authorized" not in message
            ):
                raise

            if attempt == max_attempts:
                raise RuntimeError(
                    "DigiCert CA registration failed after RBAC retries. "
                    "Ensure caller has Key Vault Certificates Officer role on the vault. "
                    f"Last error: {message}"
                ) from exc

            logging.warning(
                "DigiCert CA registration unauthorized on attempt %s/%s; retrying in %ss.",
                attempt,
                max_attempts,
                delay_seconds,
            )
            time.sleep(delay_seconds)


def getenv(environment):
    """Convert environment to standardized short form"""
    env_mapping = {
        "production": "prod",
        "prod": "prod",
        "non-production": "np",
        "nonproduction": "np",
        "non-prod": "np",
        "nonprod": "np",
        "np": "np",
        "development": "np",
        "dev": "np",
        "testing": "np",
        "test": "np",
        "staging": "np",
        "stage": "np",
        "poc": "np",
    }
    return env_mapping.get(environment.lower(), "prod")


def get_clean_app_id(appid):
    """This function converts application id to a short form to use in resource names"""
    appid = appid.lower()
    appid = re.sub(r"[^a-z0-9]", "", appid)

    return appid


def ensure_resource_provider_registered(resource_client, provider_namespace):
    """Check if a resource provider is registered and register it if not"""
    try:
        provider = resource_client.providers.get(provider_namespace)

        if provider.registration_state != "Registered":
            logging.info(
                "Resource provider %s is not registered. Registering...",
                provider_namespace,
            )
            resource_client.providers.register(provider_namespace)
            logging.info(
                "Resource provider %s registered successfully.", provider_namespace
            )
        else:
            logging.info(
                "Resource provider %s is already registered.", provider_namespace
            )

        return True
    except Exception as e:
        logging.error(
            "Error checking/registering resource provider %s: %s",
            provider_namespace,
            str(e),
        )
        raise


def main(req: func.HttpRequest) -> func.HttpResponse:
    """
    This Azure Function provisions a Key Vault in a specified subscription
      and region, and registers DigiCert as a certificate issuer.
    """

    # Extract correlation ID from request headers, fallback to UUID
    # Tries x-correlation-id first (standard Azure), then x-ms-request-id (Azure Functions)
    operation_id = (
        req.headers.get('x-correlation-id') or
        req.headers.get('x-ms-request-id') or
        str(uuid.uuid4())
    )
    logging.info("Key Vault provisioning API triggered. operation_id=%s", operation_id)

    try:
        # 1. Parse and Validate Request
        try:
            req_body = req.get_json()
            operation_id = (
                req_body.get("correlation_id")
                or operation_id
            )
        except ValueError:
            logging.warning("Invalid JSON body. operation_id=%s", operation_id)
            return func.HttpResponse(
                json.dumps(
                    {
                        "status": "error",
                        "message": "Invalid JSON body",
                        "details": {"operation_id": operation_id},
                    }
                ),
                status_code=400,
                mimetype=APPLICATION_JSON,
            )

        required_fields = ["subscription_id", "appid", "environment", "region", "resource_group"]
        missing_fields = [field for field in required_fields if not req_body.get(field)]

        if missing_fields:
            logging.warning(
                "Missing required fields=%s. operation_id=%s",
                ",".join(missing_fields),
                operation_id,
            )
            return func.HttpResponse(
                json.dumps(
                    {
                        "status": "error",
                        "message": f"Missing required fields: {', '.join(missing_fields)}",
                        "details": {
                            "operation_id": operation_id,
                            "correlation_id": operation_id,
                            "required_fields": required_fields,
                            "received_fields": list(req_body.keys()),
                        },
                    }
                ),
                status_code=400,
                mimetype=APPLICATION_JSON,
            )

        # 2. Extract Variables
        sub_id = req_body["subscription_id"]
        region = req_body["region"].strip()
        appid = get_clean_app_id(req_body["appid"])
        env = getenv(req_body["environment"])
        logging.info(
            "Request validated. operation_id=%s subscription_suffix=%s appid=%s env=%s region=%s",
            operation_id,
            _short_id(sub_id),
            appid,
            env,
            region,
        )

        random_num = random.randint(100, 999)
        kv_name = f"kv-{appid}-{env}-{random_num}"
        rg_name = req_body["resource_group"].strip()
        logging.info(
            "Using provided resource group. operation_id=%s rg=%s",
            operation_id,
            rg_name,
        )

        # 3. Resolve identity via Service Principal only
        tenant_id = os.environ.get("TENANT_ID")
        client_id = os.environ.get("APP_ID")
        client_secret = os.environ.get("APP_SECRET")
        missing_sp_env = [
            name
            for name, value in [
                ("TENANT_ID", tenant_id),
                ("CLIENT_ID", client_id),
                ("CLIENT_SECRET", client_secret),
            ]
            if not value
        ]

        if missing_sp_env:
            logging.error(
                "Service Principal credentials missing=%s. operation_id=%s subscription_suffix=%s",
                ",".join(missing_sp_env),
                operation_id,
                _short_id(sub_id),
            )
            return func.HttpResponse(
                json.dumps(
                    {
                        "status": "error",
                        "message": "Service Principal credentials are not configured.",
                        "details": {
                            "operation_id": operation_id,
                            "missing_env_vars": missing_sp_env,
                        },
                    }
                ),
                status_code=400,
                mimetype=APPLICATION_JSON,
            )

        credential = ClientSecretCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
        )

        # 4. Initialize Clients & Provision
        resource_client = ResourceManagementClient(credential, sub_id)
        kv_client = KeyVaultManagementClient(credential, sub_id)
        logging.info(
            "Azure clients initialized. operation_id=%s subscription_suffix=%s",
            operation_id,
            _short_id(sub_id),
        )

        # Ensure Microsoft.KeyVault resource provider is registered
        ensure_resource_provider_registered(resource_client, "Microsoft.KeyVault")

        # Provision Key Vault
        params = VaultCreateOrUpdateParameters(
            location=region,
            properties=VaultProperties(
                tenant_id=tenant_id,
                sku=Sku(name="standard", family="A"),
                enable_rbac_authorization=True,
                enable_purge_protection=True,
                access_policies=[],
            ),
        )

        poller = kv_client.vaults.begin_create_or_update(rg_name, kv_name, params)
        logging.info(
            "Started Key Vault create/update. operation_id=%s vault_name=%s rg=%s",
            operation_id,
            kv_name,
            rg_name,
        )
        vault = poller.result()
        logging.info(
            "Key Vault provisioned. operation_id=%s vault_id=%s",
            operation_id,
            vault.id,
        )

        issuer_name = None
        subscription_type = req_body.get("subscription_type", "")
        if subscription_type.lower() == "standalone":
            logging.info(
                "Standalone subscription flow: starting DigiCert CA registration. operation_id=%s",
                operation_id,
            )
            caller_principal_id = get_current_principal_id(credential)

            ensure_certificate_ca_permissions(
                credential=credential,
                subscription_id=sub_id,
                vault_id=vault.id,
                principal_id=caller_principal_id,
            )

            # Get DigiCert details from central Key Vault
            digicert_details = get_digicert_details(credential)

            # Register digicert as a CA in the newly created key vault
            issuer_name = register_digicert_issuer_with_retry(
                credential, vault.properties.vault_uri, digicert_details
            )
            logging.info(
                "DigiCert CA registration completed. operation_id=%s issuer=%s",
                operation_id,
                issuer_name,
            )
        else:
            logging.info(
                "Skipping DigiCert CA registration for subscription_type=%s. operation_id=%s",
                subscription_type,
                operation_id,
            )

        # 5. Success Response
        response_payload = {
            "status": "success",
            "message": f"Key Vault {kv_name} provisioned successfully",
            "correlation_id": operation_id,
            "details": {
                "operation_id": operation_id,
                "correlation_id": operation_id,
                "keyvault_name": kv_name,
                "resource_group": rg_name,
                "region": region,
                "subscription_id": sub_id,
                "tenant_id": tenant_id,
                "vault_uri": vault.properties.vault_uri,
                "certificate_issuer": issuer_name,
            },
        }

        return func.HttpResponse(
            json.dumps(response_payload, indent=4),
            status_code=200,
            mimetype=APPLICATION_JSON,
        )

    except Exception as e:
        logging.exception(
            "Unhandled error in key vault provisioning flow. operation_id=%s",
            operation_id,
        )
        return func.HttpResponse(
            json.dumps(
                {
                    "status": "error",
                    "message": "Failed to provision Key Vault",
                    "correlation_id": operation_id,
                    "details": {
                        "operation_id": operation_id,
                        "correlation_id": operation_id,
                        "detailed_error": str(e),
                    },
                }
            ),
            status_code=500,
            mimetype=APPLICATION_JSON,
        )
