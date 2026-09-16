import azure.functions as func
import json
import logging

from get_details_SP import main as get_details_main_sp
from relation_maping import main as relation_mapping_main
from step_3 import main as step_3_main
from generate_diagrams import main as generate_diagram_main
from get_subscriptions import main as get_subscriptions_main
from filter_subscriptions import main as filter_subscriptions_main
from sec_info import build_report_from_subscription_id
from approved_archtech import main as approved_archtech_main
from get_advisor import main as get_advisor_main
from policy_info import main as policy_info_main
from sre_knowledge_uploader import main as sre_knowledge_uploader_main


app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)


@app.function_name(name="GetDetailsFunctionSP")
@app.route(route="get_details_sp", methods=["POST"])
def get_details_sp(req: func.HttpRequest) -> func.HttpResponse:
    return get_details_main_sp(req)


@app.function_name(name="RelationMappingFunction")
@app.route(route="relation_mapping", methods=["POST"])
def relation_mapping(req: func.HttpRequest) -> func.HttpResponse:
    return relation_mapping_main(req)


@app.function_name(name="ArchitectureDiagramFunction")
@app.route(route="architecture_diagram", methods=["GET", "POST"])
def architecture_diagram(req: func.HttpRequest) -> func.HttpResponse:
    image_name = req.params.get("image_name") or req.params.get("name")

    if not image_name:
        try:
            payload = req.get_json()
        except ValueError:
            payload = None

        if isinstance(payload, dict):
            image_name = payload.get("image_name") or payload.get("name")

    if isinstance(image_name, str) and image_name.strip():
        return approved_archtech_main(req)

    return step_3_main(req)


@app.function_name(name="GenerateDiagramFunction")
@app.route(route="generate_diagram", methods=["GET", "POST"])
def generate_diagram(req: func.HttpRequest) -> func.HttpResponse:
    return generate_diagram_main(req)


@app.function_name(name="GetSubscriptionsFunction")
@app.route(route="get_subscriptions", methods=["GET"])
def get_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    return get_subscriptions_main(req)


@app.function_name(name="FilterSubscriptionsFunction")
@app.route(route="filter_subscriptions", methods=["POST"])
def filter_subscriptions(req: func.HttpRequest) -> func.HttpResponse:
    return filter_subscriptions_main(req)


@app.function_name(name="ApprovedArchTechFunction")
@app.route(route="approved_archtech", methods=["GET", "POST"])
def approved_archtech(req: func.HttpRequest) -> func.HttpResponse:
    return approved_archtech_main(req)


@app.function_name(name="GetAdvisorFunction")
@app.route(route="get_advisor", methods=["POST"])
def get_advisor(req: func.HttpRequest) -> func.HttpResponse:
    return get_advisor_main(req)


@app.function_name(name="PolicyInfoFunction")
@app.route(route="policy_info", methods=["POST"])
def policy_info(req: func.HttpRequest) -> func.HttpResponse:
    return policy_info_main(req)


@app.function_name(name="SREKnowledgeUploaderFunction")
@app.route(route="sre_knowledge_uploader", methods=["POST"])
def sre_knowledge_uploader(req: func.HttpRequest) -> func.HttpResponse:
    return sre_knowledge_uploader_main(req)


@app.function_name(name="SecurityInfoFunction")
@app.route(route="sec_info", methods=["POST"])
def sec_info(req: func.HttpRequest) -> func.HttpResponse:
    try:
        payload = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON input"}),
            status_code=400,
            mimetype="application/json",
        )

    if not isinstance(payload, dict):
        return func.HttpResponse(
            json.dumps({"error": "Request body must be a JSON object"}),
            status_code=400,
            mimetype="application/json",
        )

    subscription_id = payload.get("subscription_id")
    subscription_ids = payload.get("subscription_ids")
    score_summary = payload.get("scoreSummary")
    subscription_name = payload.get("subscription_name")

    normalized_ids = []
    if isinstance(subscription_id, str) and subscription_id.strip():
        normalized_ids.extend([part.strip() for part in subscription_id.split(",") if part.strip()])

    if isinstance(subscription_ids, str) and subscription_ids.strip():
        normalized_ids.extend([part.strip() for part in subscription_ids.split(",") if part.strip()])
    elif isinstance(subscription_ids, list):
        normalized_ids.extend([
            item.strip()
            for item in subscription_ids
            if isinstance(item, str) and item.strip()
        ])

    deduped_ids = []
    seen_ids = set()
    for sub_id in normalized_ids:
        key = sub_id.lower()
        if key in seen_ids:
            continue
        seen_ids.add(key)
        deduped_ids.append(sub_id)

    normalized_ids = deduped_ids

    if not normalized_ids:
        return func.HttpResponse(
            json.dumps({"error": "Provide 'subscription_id' or 'subscription_ids' as string, comma-separated string, or non-empty list of strings"}),
            status_code=400,
            mimetype="application/json",
        )

    try:
        reports = []
        for sub_id in normalized_ids:
            report = build_report_from_subscription_id(
                subscription_id=sub_id,
                provided_scores=score_summary if isinstance(score_summary, dict) else None,
                subscription_name=subscription_name if isinstance(subscription_name, str) and subscription_name.strip() else None,
            )
            reports.append(report)
    except Exception as exc:
        logging.exception("Failed to build security report from subscription id")
        return func.HttpResponse(
            json.dumps({"error": str(exc)}),
            status_code=500,
            mimetype="application/json",
        )

    if len(reports) == 1:
        response_payload = reports[0]
    else:
        response_payload = {
            "subscriptions": reports,
            "processing_summary": {
                "requested_subscriptions": len(normalized_ids),
                "completed_subscriptions": len(reports),
            },
        }

    return func.HttpResponse(
        json.dumps(response_payload),
        status_code=200,
        mimetype="application/json",
    )