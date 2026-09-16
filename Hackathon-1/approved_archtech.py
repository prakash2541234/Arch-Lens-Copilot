import json
import logging
import mimetypes
import os
from typing import Optional, Tuple
from urllib.parse import urlparse, unquote, quote

import azure.functions as func
import requests

# Default timeout (seconds) for the SAS URL request
DEFAULT_TIMEOUT = 30

# Fallback content type when it cannot be inferred from the response or blob name
DEFAULT_CONTENT_TYPE = "application/octet-stream"

# Environment variable holding the container-level SAS URL, e.g.
# https://<account>.blob.core.windows.net/<container>?<sas-token>
CONTAINER_SAS_URL_ENV = "IMAGE_CONTAINER_SAS_URL"


def _infer_content_type(blob_path: str, response_content_type: Optional[str]) -> str:
    """Determine the image content type from the response header or blob name."""
    if response_content_type and response_content_type != DEFAULT_CONTENT_TYPE:
        return response_content_type

    # Try to infer from the blob path
    guessed, _ = mimetypes.guess_type(unquote(blob_path))
    return guessed or response_content_type or DEFAULT_CONTENT_TYPE


def build_blob_sas_url(image_name: str, container_sas_url: Optional[str] = None) -> str:
    """Build a full blob SAS URL for an image given its name.

    Args:
        image_name: The blob/image name within the container (e.g. "diagram.png").
        container_sas_url: The container-level SAS URL. If omitted, it is read
            from the ``IMAGE_CONTAINER_SAS_URL`` environment variable.

    Returns:
        The complete SAS URL pointing to the blob.

    Raises:
        ValueError: If the image name or container SAS URL is missing/invalid.
    """
    if not image_name or not isinstance(image_name, str):
        raise ValueError("A non-empty image name is required")

    container_sas_url = container_sas_url or os.environ.get(CONTAINER_SAS_URL_ENV)
    if not container_sas_url:
        raise ValueError(
            f"A container SAS URL is required (set the '{CONTAINER_SAS_URL_ENV}' "
            "environment variable or pass container_sas_url)"
        )

    parsed = urlparse(container_sas_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("The container SAS URL is not a valid absolute URL")

    # Encode the image name for safe use in a URL path (keep any nested folders).
    encoded_name = quote(image_name.strip().lstrip("/"), safe="/")
    base_path = parsed.path.rstrip("/")
    blob_path = f"{base_path}/{encoded_name}"

    # Reattach the SAS token (query string) to the new blob path.
    return f"{parsed.scheme}://{parsed.netloc}{blob_path}?{parsed.query}"


def fetch_image_by_name(
    image_name: str,
    container_sas_url: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Tuple[bytes, str]:
    """Download an image from an Azure Storage blob by its name using a SAS URL.

    Args:
        image_name: The blob/image name within the container (e.g. "diagram.png").
        container_sas_url: The container-level SAS URL. If omitted, it is read
            from the ``IMAGE_CONTAINER_SAS_URL`` environment variable.
        timeout: Request timeout in seconds.

    Returns:
        A tuple of (image_bytes, content_type).

    Raises:
        ValueError: If the image name or container SAS URL is missing/malformed.
        requests.HTTPError: If the storage account returns a non-success status code.
        requests.RequestException: For network/connection related errors.
    """
    sas_url = build_blob_sas_url(image_name, container_sas_url)

    logging.info("Fetching image '%s' from storage account blob via SAS URL", image_name)

    response = requests.get(sas_url, timeout=timeout)
    response.raise_for_status()

    blob_path = urlparse(sas_url).path
    content_type = _infer_content_type(blob_path, response.headers.get("Content-Type"))
    return response.content, content_type


def main(req: func.HttpRequest) -> func.HttpResponse:
    """Azure Functions HTTP handler that returns an image fetched by its name.

    The image name can be supplied either as a query string parameter
    ``image_name`` or in the JSON request body as ``{"image_name": "..."}``.
    The blob SAS URL is built from the container SAS URL configured in the
    ``IMAGE_CONTAINER_SAS_URL`` environment variable.

    Query parameters:
        image_name: The blob/image name within the container (required).
    """
    image_name = req.params.get("image_name") or req.params.get("name")

    if not image_name:
        try:
            body = req.get_json()
        except ValueError:
            body = {}
        if isinstance(body, dict):
            image_name = image_name or body.get("image_name") or body.get("name")

    if not image_name:
        return func.HttpResponse(
            json.dumps({
                "status": "BadRequest",
                "message": "A 'name' or 'image_name' query parameter/body field is required",
            }),
            status_code=400,
            mimetype="application/json",
        )

    try:
        image_bytes, content_type = fetch_image_by_name(image_name)
    except ValueError as exc:
        return func.HttpResponse(
            json.dumps({"status": "BadRequest", "message": str(exc)}),
            status_code=400,
            mimetype="application/json",
        )
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else 502
        logging.exception("Storage account returned an error for the SAS URL")
        if status_code == 404:
            return func.HttpResponse(
                json.dumps({
                    "status": "NotFound",
                    "message": f"No architecture is detected in central storage for the provided {image_name}",
                    "error": str(exc),
                    "storageStatusCode": status_code,
                }),
                status_code=404,
                mimetype="application/json",
            )
        return func.HttpResponse(
            json.dumps({
                "status": "Error",
                "message": str(exc),
                "storageStatusCode": status_code,
            }),
            status_code=status_code,
            mimetype="application/json",
        )
    except requests.RequestException as exc:
        logging.exception("Network error while fetching image from the SAS URL")
        return func.HttpResponse(
            json.dumps({
                "status": "Error",
                "message": str(exc),
            }),
            status_code=502,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.exception("Unexpected error while fetching image")
        return func.HttpResponse(
            json.dumps({
                "status": "Error",
                "message": str(exc),
            }),
            status_code=500,
            mimetype="application/json",
        )

    return func.HttpResponse(
        body=image_bytes,
        status_code=200,
        mimetype=content_type,
    )
