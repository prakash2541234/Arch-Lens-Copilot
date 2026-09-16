"""azure function app to create a Service Principal
the function app create a app registration, 
creates a associated sp as well as assigns owners to the SP
along with this the function app also enter the original 
request and details of provisioned SP in azglz cosmosdb
"""

import logging
import json
import os
import random
import re
import string
import uuid
import contextvars
import asyncio
import aiohttp
import requests
import azure.functions as func
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

# Configuration
COSMOS_ENDPOINT = os.getenv("COSMOS_SQL_ENDPOINT", "https://cdbazglznp001.documents.azure.com:443/")
DATABASE_NAME = os.getenv("COSMOS_SQL_DATABASE", "azglz-platform-np-datadepot")
INPUT_CONTAINER = os.getenv("COSMOS_SQL_CONTAINER_SPREQUEST", "sp_requests")
OUTPUT_CONTAINER = os.getenv("COSMOS_SQL_CONTAINER_SP", "service_principals")
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0"
ManagedIdentityID = os.getenv("ManagedIdentityClientID")
ManagedIdentityID_AppReg = os.getenv("ManagedIdentityClientID_AppReg")
DM_LOGIC_APP_CALLBACK_URL = os.getenv(
    "DM_LOGIC_APP_CALLBACK_URL",
    ""
)
DM_LOGIC_APP_TIMEOUT_SECONDS = int(os.getenv("DM_LOGIC_APP_TIMEOUT_SECONDS", "10"))
SP_GAMI_AAD_GROUP_OBJECT_ID = os.getenv("SP_GAMI_AAD_GROUP_OBJECT_ID", "0ae27f47-bd89-4ea9-9122-c3bd37bc4b58")

CORRELATION_ID_CTX = contextvars.ContextVar("correlation_id", default="-")


class CorrelationIdFilter(logging.Filter):
    """Inject and prefix correlation id in every log record."""
    def filter(self, record):
        corr_id = CORRELATION_ID_CTX.get("-")
        record.correlation_id = corr_id
        if isinstance(record.msg, str) and "[corr_id=" not in record.msg:
            record.msg = f"[corr_id={corr_id}] {record.msg}"
        return True


def _ensure_correlation_logging_filter():
    """Attach correlation-id log filter once at root logger."""
    root_logger = logging.getLogger()
    if not any(isinstance(log_filter, CorrelationIdFilter) for log_filter in root_logger.filters):
        root_logger.addFilter(CorrelationIdFilter())


def _resolve_correlation_id(req: func.HttpRequest, req_body: dict = None) -> str:
    """Resolve correlation id from headers/body or generate one."""
    req_body = req_body or {}
    request_params = req_body.get("request_parameters", {}) if isinstance(req_body, dict) else {}

    candidates = [
        req.headers.get("x-correlation-id"),
        req.headers.get("x-ms-client-request-id"),
        req_body.get("correlation_id") if isinstance(req_body, dict) else None,
        request_params.get("correlation_id") if isinstance(request_params, dict) else None,
    ]

    for candidate in candidates:
        if candidate and str(candidate).strip():
            return str(candidate).strip()

    return str(uuid.uuid4())

def _create_cosmos_client():
    """Create Cosmos DB client with managed identity support"""
    if not COSMOS_ENDPOINT:
        raise RuntimeError('COSMOSDB_ENDPOINT not configured')
    # Use managed identity for Cosmos DB
    try:
        if ManagedIdentityID:
            logging.info('Using ManagedIdentityCredential for Cosmos DB')
            cred = ManagedIdentityCredential(client_id=ManagedIdentityID)
        else:
            cred = DefaultAzureCredential()
        logging.info('Using DefaultAzureCredential for Cosmos DB')
        return CosmosClient(COSMOS_ENDPOINT, credential=cred)
    except Exception as e:
        raise RuntimeError(f'Failed to create Cosmos client: {e}')

def get_clean_app_id(appid):
    """This function converts application id to a short form to use in subscription name"""
    appid = appid.lower()
    appid = re.sub(r'[^a-z0-9\-]', '', appid)

    return appid

async def get_graph_token(mi_id=None, scope=None):
    """
    Acquire Microsoft Graph token using managed identity.
    
    In Azure Functions, DefaultAzureCredential will automatically use:
    1. ManagedIdentityCredential (for system-assigned or user-assigned managed identity)
    2. EnvironmentCredential (if environment variables are set)
    3. AzureCliCredential (fallback for local testing)
    """
    try:
        if mi_id:
            logging.info('Acquiring token using Managed Identity - %s', mi_id)
            cred = ManagedIdentityCredential(client_id=mi_id)
        else:
            logging.info('Acquiring token using environment credentials')
            cred = DefaultAzureCredential()

        if not scope:
            scope = GRAPH_SCOPE

        token = await asyncio.to_thread(cred.get_token, scope)
        logging.info('Successfully acquired Microsoft Graph token')
        return token.token
    except Exception as e:
        logging.error('Failed to acquire Microsoft Graph token for %s Error %s', mi_id, e)
        raise RuntimeError(f'Failed to acquire Microsoft Graph token: {e}')

async def resolve_user_object_id(session, token, email):
    """Resolve user email to Azure AD object ID"""
    url = f"{GRAPH_ENDPOINT}/users/{email}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async with session.get(url, headers=headers) as resp:
        if resp.status == 200:
            data = await resp.json()
            return data.get('id')
        else:
            error_text = await resp.text()
            logging.warning("Direct lookup failed for user %s (status %d): %s", email, resp.status, error_text)

        # Try query if direct lookup fails
        query_url = f"{GRAPH_ENDPOINT}/users?$filter=userPrincipalName eq '{email}' or mail eq '{email}'"
        async with session.get(query_url, headers=headers) as qresp:
            if qresp.status == 200:
                logging.info("Querying for user %s was successful", email)
                qdata = await qresp.json()
                v = qdata.get('value')
                if v:
                    return v[0].get('id')
            else:
                error_text = await qresp.text()
                logging.error("Failed to query user %s (status %d): %s", email, qresp.status, error_text)
                logging.error("Query URL used: %s", query_url)
                logging.error("Managed Identity ID: %s", ManagedIdentityID_AppReg)
    return None

async def create_application_and_sp(token, human_display):
    """Create Azure AD application and service principal"""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    app_payload = {
        "displayName": human_display,
        "signInAudience": "AzureADMyOrg"
    }

    async with aiohttp.ClientSession() as session:
        # Create application
        async with session.post(f"{GRAPH_ENDPOINT}/applications", headers=headers, json=app_payload) as resp:
            resp.raise_for_status()
            app = await resp.json()

    app_object_id = app.get('id')
    app_id = app.get('appId')
    logging.info("App creation response: %s", app)
    logging.info("App object id: %s, app id: %s", app_object_id, app_id)

    # Retry loop for eventual consistency
    sp_payload = {"appId": app_id}
    max_attempts = 5
    delay = 2
    for attempt in range(1, max_attempts + 1):
        logging.info("Attempt %d: Creating service principal with payload: %s", attempt, sp_payload)
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{GRAPH_ENDPOINT}/servicePrincipals", headers=headers, json=sp_payload) as spresp:
                sp_text = await spresp.text()
                logging.info("Service Principal creation response status: %d, body: %s", spresp.status, sp_text)
                if spresp.status == 201 or spresp.status == 200:
                    sp = json.loads(sp_text)
                    sp_object_id = sp.get('id')
                    return app_id, app_object_id, sp_object_id
                elif spresp.status == 400 and 'does not reference a valid application object' in sp_text:
                    if attempt < max_attempts:
                        logging.warning("App not yet replicated. Waiting %d seconds before retrying...", delay)
                        await asyncio.sleep(delay)
                        delay *= 2  # Exponential backoff
                    else:
                        logging.error("Max attempts reached. Service Principal creation failed due to app not replicated.")
                        spresp.raise_for_status()
                else:
                    spresp.raise_for_status()
    # If we exit the loop, raise error
    raise RuntimeError("Failed to create service principal after multiple attempts.")


async def add_owners(token, app_object_id, sp_object_id, sp_owners):
    """Add owners to application and service principal"""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    owner_ids = []

    async with aiohttp.ClientSession() as session:
        for owner in sp_owners:
            if not owner:  # Skip empty strings
                continue
            
            logging.info("Resolving owner: %s", owner)
            oid = await resolve_user_object_id(session, token, owner)
            logging.info("Resolved owner %s to object ID: %s", owner, oid)
            if oid:
                owner_ids.append(oid)
                ref = {"@odata.id": f"https://graph.microsoft.com/v1.0/directoryObjects/{oid}"}

                # Add to application
                try:
                    await session.post(f"{GRAPH_ENDPOINT}/applications/{app_object_id}/owners/$ref",
                                     headers=headers, json=ref)
                except Exception as e:
                    logging.warning("Failed to add owner %s to application: %s", owner, e)
                # Add to service principal
                try:
                    await session.post(f"{GRAPH_ENDPOINT}/servicePrincipals/{sp_object_id}/owners/$ref",
                                     headers=headers, json=ref)
                except Exception as e:
                    logging.warning("Failed to add owner %s to SP: %s", owner, e)

    return owner_ids


async def add_sp_to_aad_group(token, sp_object_id, group_object_id):
    """Add a service principal to an Entra ID group using Graph REST."""
    if not sp_object_id:
        raise ValueError("service principal object id is required")

    if not group_object_id:
        logging.info("SP target AAD group is not configured. Skipping group membership.")
        return False

    url = f"{GRAPH_ENDPOINT}/groups/{group_object_id}/members/$ref"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {"@odata.id": f"https://graph.microsoft.com/v1.0/directoryObjects/{sp_object_id}"}

    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=payload) as resp:
            response_text = await resp.text()

            if resp.status in (200, 201, 204):
                logging.info(
                    "Successfully added SP %s to AAD group %s",
                    sp_object_id,
                    group_object_id
                )
                return True

            # Idempotent behavior: Graph returns a conflict-style message if membership already exists.
            if resp.status in (400, 409) and "already exist" in response_text.lower():
                logging.info(
                    "SP %s is already a member of AAD group %s",
                    sp_object_id,
                    group_object_id
                )
                return True

            raise RuntimeError(
                f"Failed adding SP to AAD group. status={resp.status}, body={response_text}"
            )


async def create_service_principal_async(payload):
    """Main service principal creation logic"""
    sp_params = payload.get('sp_parameters', {})
    req_params = payload.get('request_parameters', {})

    application_id = get_clean_app_id(sp_params.get('application_id', ''))
    environment = sp_params.get('environment')
    subscription_id = sp_params.get('subscription_id')
    subscription_role = sp_params.get('subscription_role')
    sp_owners = sp_params.get('sp_owners', [])

    ritm_number = req_params.get('ritm_number')
    catalog_task_sysid = req_params.get('catalog_task_sysid')
    log_context = f"ritm={ritm_number}, catalog_task_sysid={catalog_task_sysid}"

    # Generate display name
    random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=5))
    sp_display_name = f"sp-azf-{application_id}-{environment}-{random_suffix}"

    logging.info(
        "[SP_CREATE][START] %s, display_name=%s, subscription_id=%s, role=%s",
        log_context,
        sp_display_name,
        subscription_id,
        subscription_role
    )

    # Acquire Graph token and create app+sp
    logging.info("[SP_CREATE][STEP 1/4] Acquire Graph token and create application/SP")
    token = await get_graph_token(mi_id=ManagedIdentityID_AppReg)
    app_id, app_object_id, sp_object_id = await create_application_and_sp(token, sp_display_name)
    logging.info(
        "[SP_CREATE][STEP 1/4][DONE] app_id=%s, app_object_id=%s, sp_object_id=%s",
        app_id,
        app_object_id,
        sp_object_id
    )

    # Add owners
    logging.info("[SP_CREATE][STEP 2/4] Add owners to app and service principal")
    owner_ids = await add_owners(token, app_object_id, sp_object_id, sp_owners)
    logging.info("[SP_CREATE][STEP 2/4][DONE] owner_count_requested=%d, owner_count_resolved=%d", len(sp_owners), len(owner_ids))

    request_doc_id = payload.get('id') or ritm_number or str(uuid.uuid4())
    logging.info("[SP_CREATE][INFO] request_doc_id=%s", request_doc_id)

    # Prepare SP document
    sp_document = {
        "id": sp_display_name,
        "appreg_object_id": app_object_id,
        "service_principal_id": sp_object_id,
        "display_name": sp_display_name,
        "environment": environment,
        "subscription_id": subscription_id,
        "subscription_role": subscription_role,
        "owners": sp_owners,
        # "owner_object_ids": owner_ids,
        "catalog_task_sysid": catalog_task_sysid
    }

    # Save to Cosmos DB
    logging.info("[SP_CREATE][STEP 3/4] Persist request and service principal details to Cosmos DB")
    client = _create_cosmos_client()
    db = client.get_database_client(DATABASE_NAME)

    # Save request to input container
    sp_request_container = db.get_container_client(INPUT_CONTAINER)
    request_document = {
        "id": catalog_task_sysid,
        "sp_parameters": sp_params,
        "request_parameters": req_params,
    }

    try:
        sp_request_container.upsert_item(request_document)
        logging.info("[SP_CREATE][STEP 3/4][DONE] Saved request to container=%s", INPUT_CONTAINER)
    except Exception as e:
        logging.warning("[SP_CREATE][STEP 3/4][WARN] Failed to save to container=%s: %s", INPUT_CONTAINER, e)

    # Save result to output container
    service_principal_container = db.get_container_client(OUTPUT_CONTAINER)

    # Check if SP already exists
    existing_query = "SELECT * FROM c WHERE c.service_principal_id = @spid"
    existing_params = [{"name": "@spid", "value": sp_object_id}]
    existing_items = list(service_principal_container.query_items(
        query=existing_query,
        parameters=existing_params,
        enable_cross_partition_query=True
    ))

    if existing_items:
        existing = existing_items[0]
        existing_id = existing.get('id')
        existing_pk = existing.get('service_principal_id') or sp_object_id
        service_principal_container.replace_item(item=existing_id, body=sp_document, partition_key=existing_pk)
        logging.info("[SP_CREATE][STEP 4/4][DONE] Replaced existing SP in container=%s", OUTPUT_CONTAINER)
    else:
        service_principal_container.upsert_item(sp_document)
        logging.info("[SP_CREATE][STEP 4/4][DONE] Created new SP in container=%s", OUTPUT_CONTAINER)

    logging.info("[SP_CREATE][COMPLETE] %s, sp_display_name=%s, sp_object_id=%s", log_context, sp_display_name, sp_object_id)

    return sp_document


async def assign_sub_role(subscription_id, role_name, sp_object_id):
    """Assign role to service principal on subscription"""
    try:
        role_name = (role_name or "").strip()
        if not role_name:
            return {
                "status": "skipped",
                "message": "Role assignment skipped because subscription_role is missing."
            }

        logging.info("Assigning role '%s' to SP on subscription %s", role_name, subscription_id)
        arm_token = await get_graph_token(mi_id=ManagedIdentityID_AppReg, scope="https://management.azure.com/.default")
        arm_headers = {
            "Authorization": f"Bearer {arm_token}",
            "Content-Type": "application/json"
        }

        async def _resolve_role_definition_id(session):
            """Resolve role name to role definition ID using exact and case-insensitive matching."""
            exact_url = (
                f"https://management.azure.com/subscriptions/{subscription_id}/providers/"
                f"Microsoft.Authorization/roleDefinitions?api-version=2022-04-01&$filter=roleName eq '{role_name}'"
            )

            async with session.get(exact_url, headers=arm_headers) as resp:
                if resp.status == 200:
                    role_data = await resp.json()
                    role_definitions = role_data.get('value', [])
                    if role_definitions:
                        return role_definitions[0].get('id')

            list_url = (
                f"https://management.azure.com/subscriptions/{subscription_id}/providers/"
                f"Microsoft.Authorization/roleDefinitions?api-version=2022-04-01"
            )
            async with session.get(list_url, headers=arm_headers) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logging.error("Failed to list role definitions (status %d): %s", resp.status, error_text)
                    return None

                role_data = await resp.json()
                for role_definition in role_data.get('value', []):
                    candidate_name = (role_definition.get('properties', {}).get('roleName') or "").strip()
                    if candidate_name.lower() == role_name.lower():
                        return role_definition.get('id')

            return None

        async with aiohttp.ClientSession() as session:
            role_definition_id = await _resolve_role_definition_id(session)

            if not role_definition_id:
                logging.warning("Role '%s' not found in subscription", role_name)
                return {
                    "status": "failed",
                    "message": f"Role '{role_name}' not found in subscription '{subscription_id}'."
                }

            logging.info("Resolved role '%s' to ID: %s", role_name, role_definition_id)

            role_assignment_id = str(uuid.uuid4())
            role_assignment_url = f"https://management.azure.com/subscriptions/{subscription_id}/providers/Microsoft.Authorization/roleAssignments/{role_assignment_id}?api-version=2022-04-01"

            role_assignment_payload = {
                "properties": {
                    "roleDefinitionId": role_definition_id,
                    "principalId": sp_object_id,
                    "principalType": "ServicePrincipal"
                }
            }

            # Retry loop with exponential backoff for eventual consistency
            max_attempts = 5
            delay = 2
            for attempt in range(1, max_attempts + 1):
                logging.info("Attempt %d: Assigning role '%s' to SP %s", attempt, role_name, sp_object_id)
                async with session.put(role_assignment_url, headers=arm_headers, json=role_assignment_payload) as assign_resp:
                    response_text = await assign_resp.text()
                    
                    if assign_resp.status in [200, 201, 204]:
                        logging.info("Successfully assigned role '%s' to SP on attempt %d", role_name, attempt)
                        return {
                            "status": "success",
                            "message": f"Role '{role_name}' assigned to service principal '{sp_object_id}' successfully."
                        }
                    
                    # Check if principal not found error (indicates SP not yet replicated to ARM)
                    if assign_resp.status == 400 and ('principal' in response_text.lower() or 'not found' in response_text.lower()):
                        if attempt < max_attempts:
                            logging.warning(
                                "Service Principal not yet replicated in ARM. Waiting %d seconds before retrying... (attempt %d/%d)",
                                delay,
                                attempt,
                                max_attempts
                            )
                            await asyncio.sleep(delay)
                            delay *= 2  # Exponential backoff
                        else:
                            logging.error("Max attempts reached. Service Principal role assignment failed due to SP not replicated.")
                            return {
                                "status": "failed",
                                "message": f"Failed to assign role '{role_name}' - Service Principal not found after {max_attempts} attempts.",
                                "error_details": response_text
                            }
                    else:
                        # Other errors - don't retry
                        logging.error("Failed to assign role (status %d): %s", assign_resp.status, response_text)
                        return {
                            "status": "failed",
                            "message": f"Failed to assign role '{role_name}' to service principal '{sp_object_id}'.",
                            "error_details": response_text
                        }

    except Exception as role_error:
        logging.error("Error assigning role to SP: %s", str(role_error), exc_info=True)
        return {
            "status": "failed",
            "message": f"Error assigning role '{role_name}' to service principal '{sp_object_id}'.",
            "error_details": str(role_error)
        }


def _to_bool(value) -> bool:
    """Convert mixed request values to bool."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "y")
    if isinstance(value, (int, float)):
        return value != 0
    return False


def _build_dm_callback_payload(req_body: dict, state: str, result_message: str) -> dict:
    """Build the Logic App payload from the incoming request body."""
    request_parameters = req_body.get('request_parameters', {}) if isinstance(req_body, dict) else {}
    return {
        "u_catalog_task_sysid": request_parameters.get('catalog_task_sysid'),
        "u_ritm_number": request_parameters.get('ritm_number'),
        "u_state": state,
        "u_result": result_message
    }


async def _post_dm_callback_to_logic_app(callback_url: str, payload: dict) -> bool:
    """POST the callback payload to the configured Logic App endpoint."""
    if not callback_url:
        logging.warning("Logic App callback URL not configured - skipping callback")
        return False

    def _do_post():
        return requests.post(
            callback_url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=DM_LOGIC_APP_TIMEOUT_SECONDS,
        )

    try:
        response = await asyncio.to_thread(_do_post)
        response_text = response.text

        if response.status_code in (200, 201, 202, 204):
            logging.info(
                "Logic App callback successful (status=%d, response=%s)",
                response.status_code,
                response_text
            )
            return True

        logging.error(
            "Logic App callback failed (status=%d, response=%s)",
            response.status_code,
            response_text
        )
        return False
    except requests.RequestException as callback_error:
        logging.error("Logic App callback request exception: %s", callback_error, exc_info=True)
        return False
    except Exception as callback_error:
        logging.error("Logic App callback unexpected exception: %s", callback_error, exc_info=True)
        return False


async def perform_dm_callback(
    req_body: dict,
    state: str,
    result_message: str,
    correlation_id: str = None
) -> bool:
    """Send Digital Me callback when explicitly enabled and return whether it was sent successfully."""
    perform_dm_callback_flag = _to_bool(req_body.get('perform_dm_callback', False)) if isinstance(req_body, dict) else False

    if not perform_dm_callback_flag:
        logging.info("Skipping Logic App callback because perform_dm_callback is false or missing")
        return False

    request_parameters = req_body.get('request_parameters', {}) if isinstance(req_body, dict) else {}
    catalog_task_sysid = request_parameters.get('catalog_task_sysid')
    ritm_number = request_parameters.get('ritm_number')

    if not catalog_task_sysid or not ritm_number:
        logging.warning(
            "Skipping Logic App callback because request_parameters.catalog_task_sysid or request_parameters.ritm_number is missing. "
            "catalog_task_sysid=%s, ritm_number=%s",
            catalog_task_sysid,
            ritm_number
        )
        return False

    callback_payload = _build_dm_callback_payload(req_body, state, result_message)

    return await _post_dm_callback_to_logic_app(DM_LOGIC_APP_CALLBACK_URL, callback_payload)

async def main(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP trigger function to create Azure Service Principals using Managed Identity.
    
    Expected POST body:
    {
        "sp_parameters": {
            "application_id": "test-project",
            "environment": "poc",
            "subscription_id": "...",
            "subscription_role": "contributor",
            "sp_owners": ["user@email.com"]
        },
        "request_parameters": {
            "requester": {
                "first_name": "...",
                "last_name": "...",
                "user_id": "..."
            },
            "ritm_number": "...",
            "catalog_task_sysid": "..."
        },
        "perform_dm_callback": true/false
    }
    """
    logging.info('CreateServicePrincipal function triggered')
    req_body = {}
    dm_callback_enabled = False
    ritm_number = None
    catalog_task_sysid = None
    current_step = "parse_request_body"
    _ensure_correlation_logging_filter()
    correlation_id = _resolve_correlation_id(req)
    corr_token = CORRELATION_ID_CTX.set(correlation_id)

    try:
        # Parse request body
        try:
            logging.info("[MAIN][STEP] parse_request_body")
            req_body = req.get_json()
            correlation_id = _resolve_correlation_id(req, req_body)
            CORRELATION_ID_CTX.set(correlation_id)
            logging.info("[MAIN][STEP][DONE] parse_request_body")
        except ValueError:
            error_response = {
                "status": "error",
                "message": "Request Payload validation failed. Missing or invalid JSON body.",
                "correlation_id": correlation_id,
                "details": {
                    "error_details": "Invalid JSON in request body",
                    "correlation_id": correlation_id
                }
            }
            return func.HttpResponse(
                json.dumps(error_response, indent=2),
                mimetype="application/json",
                status_code=400
            )

        dm_callback_enabled = _to_bool(req_body.get('perform_dm_callback', False))
        ritm_number = req_body.get('request_parameters', {}).get('ritm_number')
        catalog_task_sysid = req_body.get('request_parameters', {}).get('catalog_task_sysid')
        logging.info(
            "[MAIN][CONTEXT] ritm=%s, catalog_task_sysid=%s, perform_dm_callback=%s, correlation_id=%s",
            ritm_number,
            catalog_task_sysid,
            dm_callback_enabled,
            correlation_id
        )

        # Validate required fields
        current_step = "validate_payload"
        logging.info("[MAIN][STEP] validate_payload")
        if 'sp_parameters' not in req_body:
            dm_callback_sent = await perform_dm_callback(
                req_body,
                "4",
                "Service Principal creation failed. Missing 'sp_parameters' in request.",
                correlation_id
            )
            error_response = {
                "status": "error",
                "message": "Request Payload validation failed. Missing 'sp_parameters' in request.",
                "correlation_id": correlation_id,
                "details": {
                    "error_details": "Missing 'sp_parameters' in request",
                    "DM_callback_sent": dm_callback_sent,
                    "correlation_id": correlation_id
                }
            }
            return func.HttpResponse(
                json.dumps(error_response, indent=2),
                mimetype="application/json",
                status_code=400
            )

        if 'request_parameters' not in req_body:
            dm_callback_sent = await perform_dm_callback(
                req_body,
                "4",
                "Service Principal creation failed. Missing 'request_parameters' in request.",
                correlation_id
            )
            error_response = {
                "status": "error",
                "message": "Request Payload validation failed. Missing 'request_parameters' in request.",
                "correlation_id": correlation_id,
                "details": {
                    "error_details": "Missing 'request_parameters' in request",
                    "DM_callback_sent": dm_callback_sent,
                    "correlation_id": correlation_id
                }
            }
            return func.HttpResponse(
                json.dumps(error_response, indent=2),
                mimetype="application/json",
                status_code=400
            )
        logging.info("[MAIN][STEP][DONE] validate_payload")

        logging.info("[MAIN][INFO] Processing request for RITM=%s", ritm_number)

        # Create service principal
        current_step = "create_service_principal"
        logging.info("[MAIN][STEP] create_service_principal")
        result = await create_service_principal_async(req_body)
        logging.info("[MAIN][STEP][DONE] create_service_principal, sp_id=%s", result.get("service_principal_id"))

        # Assign role to service principal on subscription
        current_step = "assign_subscription_role"
        logging.info("[MAIN][STEP] assign_subscription_role")
        subscription_id = req_body.get('sp_parameters', {}).get('subscription_id')
        role_name = req_body.get('sp_parameters', {}).get('subscription_role')
        role_assignment_result = None

        if subscription_id and role_name:
            role_assignment_result = await assign_sub_role(subscription_id, role_name, result.get("service_principal_id"))
            if role_assignment_result.get("status") == "success":
                logging.info("[MAIN][STEP][DONE] assign_subscription_role")
            else:
                logging.error("[MAIN][STEP][FAILED] assign_subscription_role: %s", role_assignment_result.get("message"))
        else:
            logging.info("[MAIN][STEP][SKIP] assign_subscription_role - subscription_id or role_name missing")

        # Step 4: Add SP to configured AAD group (if configured) - ONLY after role assignment succeeds
        current_step = "add_sp_to_aad_group"
        logging.info("[MAIN][STEP] add_sp_to_aad_group")
        if role_assignment_result is None or role_assignment_result.get("status") == "success":
            try:
                aad_token = await get_graph_token(mi_id=ManagedIdentityID_AppReg)
                await add_sp_to_aad_group(
                    aad_token,
                    result.get("service_principal_id"),
                    SP_GAMI_AAD_GROUP_OBJECT_ID
                )
                logging.info("[MAIN][STEP][DONE] add_sp_to_aad_group")
            except Exception as e:
                logging.error("[MAIN][STEP][FAIL] add_sp_to_aad_group: %s", e)
        else:
            logging.warning("[MAIN][STEP][SKIP] add_sp_to_aad_group - skipped due to role assignment failure")


        # perform DM callback for success
        current_step = "send_dm_callback_success"
        logging.info("[MAIN][STEP] send_dm_callback_success")
        dm_callback_sent = await perform_dm_callback(
            req_body,
            "3",
            f"Service Principal '{result.get('display_name')}' created successfully. "
            f"App ID: {result.get('appreg_object_id')}, SP ID: {result.get('service_principal_id')}",
            correlation_id
        )
        logging.info("[MAIN][STEP][DONE] send_dm_callback_success, callback_sent=%s", dm_callback_sent)


        # Return success response
        response_body = {
            "status": "success",
            "message": f"Service Principal - {result.get('display_name')} created successfully",
            "correlation_id": correlation_id,
            "details": {
                "appreg_id": result.get("appreg_object_id"),
                "service_principal_id": result.get("service_principal_id"),
                "sp_display_name": result.get("display_name"),
                "ritm_number": ritm_number,
                "DM_callback_sent": dm_callback_sent,
                "correlation_id": correlation_id
            }
        }
        logging.info(
            "[MAIN][COMPLETE] Successfully created SP display_name=%s, ritm=%s, catalog_task_sysid=%s",
            result.get('display_name'),
            ritm_number,
            catalog_task_sysid
        )

        return func.HttpResponse(
            json.dumps(response_body, indent=2),
            mimetype="application/json",
            status_code=200
        )

    except Exception as e:
        logging.error(
            "[MAIN][FAILED] step=%s, ritm=%s, catalog_task_sysid=%s, error=%s",
            current_step,
            ritm_number,
            catalog_task_sysid,
            str(e),
            exc_info=True
        )
        dm_callback_sent = await perform_dm_callback(
            req_body,
            "4",
            f"Service Principal creation failed. Error: {str(e)}",
            correlation_id
        )

        error_response = {
            "status": "error",
            "message": "Service Principal creation was not completed.",
            "correlation_id": correlation_id,
            "details": { 
                "error_details": str(e),
                "DM_callback_sent": dm_callback_sent,
                "correlation_id": correlation_id
            }
        }

        return func.HttpResponse(
            json.dumps(error_response, indent=2),
            mimetype="application/json",
            status_code=500
        )
    finally:
        CORRELATION_ID_CTX.reset(corr_token)
