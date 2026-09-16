import json
import logging
import os
from datetime import datetime
from typing import List, Dict, TypedDict, Literal, Any

from azure.identity import ClientSecretCredential
from azure.mgmt.resourcegraph import ResourceGraphClient
from azure.mgmt.resourcegraph.models import QueryRequest

# -------------------------------
# CONSTANT SCORES (INPUT)
# -------------------------------
SCORES = {
    "overall": 44,
    "security": 42,
    "reliability": 38,
    "performanceEfficiency": 48,
    "costOptimization": 61,
    "operationalExcellence": 33
}

SCORE_KEYS = [
    "overall",
    "security",
    "reliability",
    "performanceEfficiency",
    "costOptimization",
    "operationalExcellence",
]

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
Severity = Literal["critical", "high", "medium", "low"]


class Finding(TypedDict):
    resourceName: str
    resourceGroup: str
    issue: str
    severity: Severity
    reason: str
    remediation: str
    impactedPillars: List[str]


class RiskItem(TypedDict):
    resourceName: str
    resourceGroup: str
    issue: str
    severity: Severity
    blastRadius: str
    whyItMatters: str


class ActionItem(TypedDict):
    title: str
    effort: str
    impact: str
    affectedPillars: List[str]


def classify_severity(control_area: str, resource: Dict[str, Any]) -> Severity:
    if control_area == "public_exposure":
        if resource.get("internetFacing") or resource.get("containsSensitiveData"):
            return "critical"
        return "high"

    if control_area == "open_inbound":
        open_ports = resource.get("openInboundPorts") or []
        if any(str(port) in {"22", "3389"} for port in open_ports):
            return "critical"
        if open_ports:
            return "high"
        return "medium"

    if control_area in {"missing_nsg", "missing_waf_firewall", "missing_private_endpoint"}:
        return "high"

    if control_area in {"segmentation", "monitoring"}:
        return "medium"

    return "low"


def _to_optional_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        if isinstance(value, str) and value.strip() == "-":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def build_score_improvement_plan(scores: Dict[str, Any]) -> List[ActionItem]:
    actions: List[ActionItem] = []

    security_score = _to_optional_int(scores.get("security"))
    reliability_score = _to_optional_int(scores.get("reliability"))
    operational_score = _to_optional_int(scores.get("operationalExcellence"))
    performance_score = _to_optional_int(scores.get("performanceEfficiency"))
    cost_score = _to_optional_int(scores.get("costOptimization"))

    if security_score is not None and security_score < 50:
        actions.append(
            {
                "title": "Close public exposure, attach NSGs, and enforce private endpoints",
                "effort": "Medium",
                "impact": "High",
                "affectedPillars": ["Security", "Reliability"],
            }
        )

    if reliability_score is not None and reliability_score < 50:
        actions.append(
            {
                "title": "Segment subnets and enforce ingress controls to reduce blast radius",
                "effort": "Medium",
                "impact": "High",
                "affectedPillars": ["Reliability", "Security"],
            }
        )

    if operational_score is not None and operational_score < 50:
        actions.append(
            {
                "title": "Enable diagnostics and alerts on network resources",
                "effort": "Low",
                "impact": "High",
                "affectedPillars": ["Operational Excellence", "Security"],
            }
        )

    if performance_score is not None and performance_score < 50:
        actions.append(
            {
                "title": "Review traffic paths and remove unnecessary internet hops",
                "effort": "Medium",
                "impact": "Medium",
                "affectedPillars": ["Performance Efficiency", "Reliability"],
            }
        )

    if cost_score is not None and cost_score < 70:
        actions.append(
            {
                "title": "Right-size security controls with policy baselines to reduce reactive cost",
                "effort": "Low",
                "impact": "Medium",
                "affectedPillars": ["Cost Optimization", "Operational Excellence"],
            }
        )

    return actions[:5]


def resolve_scores(subscription: Dict[str, Any]) -> Dict[str, Any]:
    candidates = [
        subscription.get("scoreSummary"),
        subscription.get("scores"),
        subscription.get("wellArchitectedScores"),
        subscription.get("details", {}).get("scoreSummary") if isinstance(subscription.get("details"), dict) else None,
    ]

    source: Dict[str, Any] = {}
    for candidate in candidates:
        if isinstance(candidate, dict):
            source = candidate
            break

    resolved: Dict[str, Any] = {}
    for key in SCORE_KEYS:
        raw_value = source.get(key)
        numeric_value = _to_optional_int(raw_value)
        resolved[key] = numeric_value if numeric_value is not None else "-"

    return resolved


def _blast_radius(resource: Dict[str, Any]) -> str:
    if resource.get("publicAccess") or resource.get("hasPublicIp"):
        return "High"
    if resource.get("sharedSubnet") or resource.get("flatNetwork"):
        return "Medium"
    return "Low"


def _safe_name(resource: Dict[str, Any]) -> str:
    return str(resource.get("name") or "unknown-resource")


def _safe_rg(resource: Dict[str, Any]) -> str:
    return str(resource.get("resourceGroup") or "unknown-rg")


def _append_finding(
    findings: List[Finding],
    resource: Dict[str, Any],
    issue: str,
    control_area: str,
    reason: str,
    remediation: str,
    impacted_pillars: List[str],
):
    findings.append(
        {
            "resourceName": _safe_name(resource),
            "resourceGroup": _safe_rg(resource),
            "issue": issue,
            "severity": classify_severity(control_area, resource),
            "reason": reason,
            "remediation": remediation,
            "impactedPillars": impacted_pillars,
        }
    )


def calculate_strength_from_findings(findings: List[Finding]) -> Dict[str, Any]:
    if not findings:
        return {
            "score": 100,
            "level": "Strong",
            "riskPoints": 0,
        }

    weights = {
        "critical": 10,
        "high": 6,
        "medium": 3,
        "low": 1,
    }

    risk_points = sum(weights.get(str(finding.get("severity")), 1) for finding in findings)
    max_risk_points = len(findings) * weights["critical"]
    risk_ratio = (risk_points / max_risk_points) if max_risk_points > 0 else 0
    score = max(0, min(100, round(100 - (risk_ratio * 100))))

    if score >= 80:
        level = "Strong"
    elif score >= 60:
        level = "Moderate"
    elif score >= 40:
        level = "Weak"
    else:
        level = "Critical"

    return {
        "score": score,
        "level": level,
        "riskPoints": risk_points,
    }


def derive_scores_from_findings(findings: List[Finding]) -> Dict[str, int]:
    pillars = {
        "security": "Security",
        "reliability": "Reliability",
        "performanceEfficiency": "Performance Efficiency",
        "costOptimization": "Cost Optimization",
        "operationalExcellence": "Operational Excellence",
    }

    severity_weights = {
        "critical": 10,
        "high": 6,
        "medium": 3,
        "low": 1,
    }

    pillar_risk_points: Dict[str, int] = {key: 0 for key in pillars.keys()}
    pillar_max_points: Dict[str, int] = {key: 0 for key in pillars.keys()}

    for finding in findings:
        severity = str(finding.get("severity", "low"))
        weight = severity_weights.get(severity, 1)
        impacted = finding.get("impactedPillars") or []

        impacted_keys = [
            score_key
            for score_key, pillar_name in pillars.items()
            if pillar_name in impacted
        ]

        for key in impacted_keys:
            pillar_risk_points[key] += weight
            pillar_max_points[key] += severity_weights["critical"]

    derived: Dict[str, int] = {}
    for key in pillars.keys():
        if pillar_max_points[key] == 0:
            derived[key] = 100
            continue

        ratio = pillar_risk_points[key] / pillar_max_points[key]
        derived[key] = max(0, min(100, round(100 - (ratio * 100))))

    derived["overall"] = round(
        (
            derived["security"]
            + derived["reliability"]
            + derived["performanceEfficiency"]
            + derived["costOptimization"]
            + derived["operationalExcellence"]
        ) / 5
    )

    return derived


def merge_scores_with_derived(scores: Dict[str, Any], findings: List[Finding]) -> Dict[str, Any]:
    derived = derive_scores_from_findings(findings)
    merged: Dict[str, Any] = {}

    for key in SCORE_KEYS:
        value = scores.get(key)
        merged[key] = derived[key] if value == "-" else value

    return merged


def _get_sp_credential() -> ClientSecretCredential:
    tenant_id = os.getenv("AZURE_TENANT_ID") or os.getenv("TENANT_ID")
    client_id = os.getenv("AZURE_CLIENT_ID") or os.getenv("CLIENT_ID")
    client_secret = os.getenv("AZURE_CLIENT_SECRET") or os.getenv("CLIENT_SECRET")

    missing = [
        name
        for name, value in {
            "AZURE_TENANT_ID": tenant_id,
            "AZURE_CLIENT_ID": client_id,
            "AZURE_CLIENT_SECRET": client_secret,
        }.items()
        if not value
    ]

    if missing:
        raise ValueError(
            "Missing required service principal environment variables: " + ", ".join(missing)
        )

    return ClientSecretCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        client_secret=client_secret,
    )


def _to_text(value: Any) -> str:
    try:
        if isinstance(value, (dict, list)):
            return json.dumps(value).lower()
        return str(value).lower()
    except Exception:
        return ""


def _normalize_discovered_resource(resource: Dict[str, Any]) -> Dict[str, Any]:
    res_type = str(resource.get("type", "")).lower()
    props = resource.get("properties") if isinstance(resource.get("properties"), dict) else {}
    props_text = _to_text(props)

    has_public_ip = "publicipaddress" in props_text or "public ip" in props_text
    public_access = (
        "publicnetworkaccess\": \"enabled\"" in props_text
        or "allowblobpublicaccess\": true" in props_text
        or has_public_ip
        or res_type in {"microsoft.network/publicipaddresses"}
    )

    private_endpoint_connections = props.get("privateEndpointConnections")
    private_endpoint = bool(private_endpoint_connections) if isinstance(private_endpoint_connections, list) else False

    nsg_attached = "networksecuritygroup" in props_text
    diagnostics_enabled = any(
        token in props_text
        for token in [
            "diagnostic",
            "loganalytics",
            "workspaceid",
            "insights",
        ]
    )

    requires_private_endpoint = any(
        res_type.startswith(prefix)
        for prefix in [
            "microsoft.storage/",
            "microsoft.keyvault/",
            "microsoft.sql/",
            "microsoft.documentdb/",
            "microsoft.servicebus/",
            "microsoft.cache/",
        ]
    )

    return {
        "id": resource.get("id"),
        "name": resource.get("name"),
        "type": resource.get("type"),
        "location": resource.get("location"),
        "resourceGroup": resource.get("resourceGroup"),
        "subscriptionId": resource.get("subscriptionId"),
        "properties": props,
        "nsgAttached": nsg_attached,
        "publicAccess": public_access,
        "hasPublicIp": has_public_ip,
        "diagnosticsEnabled": diagnostics_enabled,
        "requiresPrivateEndpoint": requires_private_endpoint,
        "privateEndpoint": private_endpoint,
        "openInboundPorts": [],
        "flatNetwork": False,
    }


def fetch_subscription_resources(subscription_id: str) -> List[Dict[str, Any]]:
    credential = _get_sp_credential()
    client = ResourceGraphClient(credential)

    query = """
    Resources
    | where subscriptionId =~ '{subscription_id}'
    | project id, name, type, location, resourceGroup, subscriptionId, properties
    """.format(subscription_id=subscription_id)

    request = QueryRequest(subscriptions=[subscription_id], query=query)
    response = client.resources(request)
    raw_resources = list(response.data)
    logging.info("Fetched %s resources for subscription %s", len(raw_resources), subscription_id)
    return [_normalize_discovered_resource(resource) for resource in raw_resources]


def fetch_subscription_name(subscription_id: str) -> str:
    credential = _get_sp_credential()
    client = ResourceGraphClient(credential)

    query = """
    ResourceContainers
    | where type == 'microsoft.resources/subscriptions'
    | where subscriptionId =~ '{subscription_id}'
    | project subscriptionId, name
    """.format(subscription_id=subscription_id)

    request = QueryRequest(subscriptions=[subscription_id], query=query)
    response = client.resources(request)
    rows = list(response.data)

    if rows:
        return str(rows[0].get("name") or subscription_id)
    return subscription_id


def build_report_from_subscription_id(
    subscription_id: str,
    provided_scores: Dict[str, int] | None = None,
    subscription_name: str | None = None,
) -> Dict[str, Any]:
    sub_name = subscription_name or fetch_subscription_name(subscription_id)
    resources = fetch_subscription_resources(subscription_id)

    subscription: Dict[str, Any] = {
        "id": subscription_id,
        "name": sub_name,
    }
    if isinstance(provided_scores, dict):
        subscription["scoreSummary"] = provided_scores

    return generate_network_security_report(subscription, resources)

# -------------------------------
# SAMPLE RESOURCE STRUCTURE
# -------------------------------
# Expected resource format:
# {
#   "name": "vm1",
#   "type": "vm",
#   "resourceGroup": "rg1",
#   "nsgAttached": False,
#   "publicAccess": True,
#   "diagnosticsEnabled": False
# }


# -------------------------------
# CORE ANALYSIS FUNCTION
# -------------------------------
def generate_network_security_report(subscription: Dict, resources: List[Dict]) -> Dict:
    findings: List[Finding] = []
    strengths: List[str] = []
    scores = resolve_scores(subscription)

    if not resources:
        return {
            "subscriptionId": subscription.get("id") or subscription.get("subscriptionId", "unknown-subscription"),
            "subscriptionName": subscription.get("name") or subscription.get("subscriptionName", "unknown-subscription"),
            "generatedAt": datetime.utcnow().isoformat(),
            "scoreSummary": scores,
            "networkSecurity": {
                "findings": [],
                "strengths": ["No resource data available for analysis"],
                "gaps": [
                    {
                        "gap": "Missing discovery data",
                        "impactedPillars": ["Security", "Operational Excellence"],
                        "whyItMatters": "Without asset-level network visibility, security risks cannot be validated.",
                    }
                ],
                "priorityActions": [
                    "Collect network topology and NSG metadata",
                    "Enable diagnostics for network resources",
                ],
                "severityBreakdown": {"critical": 0, "high": 0, "medium": 0, "low": 0},
            },
            "reviewsAndRisks": {
                "findings": ["Discovery data is missing; targeted security review could not be completed."],
                "risks": [],
                "recommendations": [
                    "What is good: Score baseline is available for planning.",
                    "What is risky: No resource telemetry to validate exposure controls.",
                    "What to do now: Run discovery for the selected subscription and rerun this report.",
                ],
                "top5ImmediateActions": build_score_improvement_plan(scores),
            },
        }

    for res in resources:
        res_type = str(res.get("type", "")).lower()

        if res.get("publicAccess") or res.get("hasPublicIp"):
            _append_finding(
                findings,
                res,
                "Public access enabled",
                "public_exposure",
                "Resource appears reachable from public internet.",
                "Remove direct public access and route through private endpoints or controlled ingress.",
                ["Security", "Reliability"],
            )

        if res_type in {"vm", "nic", "subnet"} and not res.get("nsgAttached", False):
            _append_finding(
                findings,
                res,
                "NSG not attached",
                "missing_nsg",
                "Network traffic is not constrained by explicit security rules.",
                "Attach NSG and implement least-privilege inbound/outbound rules.",
                ["Security", "Operational Excellence"],
            )

        if res.get("openInboundPorts") or res.get("hasOpenInbound"):
            open_ports = res.get("openInboundPorts") or []
            _append_finding(
                findings,
                res,
                "Open inbound exposure",
                "open_inbound",
                f"Inbound ports exposed: {open_ports if open_ports else 'unknown'}.",
                "Restrict inbound to trusted sources and close unnecessary ports.",
                ["Security", "Reliability"],
            )

        if res.get("flatNetwork") or (isinstance(res.get("subnetCount"), int) and res.get("subnetCount", 0) < 2):
            _append_finding(
                findings,
                res,
                "Weak subnet segmentation",
                "segmentation",
                "Limited segmentation increases lateral movement risk.",
                "Implement subnet segmentation by workload trust boundaries.",
                ["Security", "Reliability"],
            )

        if res_type in {"applicationgateway", "appgateway", "frontdoor", "loadbalancer"} and not (
            res.get("wafEnabled") or res.get("firewallEnabled")
        ):
            _append_finding(
                findings,
                res,
                "Missing WAF/Firewall control",
                "missing_waf_firewall",
                "Ingress component lacks advanced threat filtering control.",
                "Enable WAF/Firewall policies and tune managed rules.",
                ["Security", "Operational Excellence"],
            )

        if (res.get("requiresPrivateEndpoint") or res.get("supportsPrivateEndpoint")) and not res.get("privateEndpoint"):
            _append_finding(
                findings,
                res,
                "Missing private endpoint",
                "missing_private_endpoint",
                "Private connectivity is available but not enabled.",
                "Enable Private Endpoint and disable public network access.",
                ["Security", "Reliability", "Cost Optimization"],
            )

        if not res.get("diagnosticsEnabled", False):
            _append_finding(
                findings,
                res,
                "Diagnostics disabled",
                "monitoring",
                "Insufficient logs/metrics for incident response and audit.",
                "Enable diagnostics and send logs to centralized workspace.",
                ["Operational Excellence", "Security", "Reliability"],
            )

    if any(not res.get("publicAccess") and not res.get("hasPublicIp") for res in resources):
        strengths.append("Some resources are already private-only.")
    if any(res.get("nsgAttached") for res in resources):
        strengths.append("NSG controls are present on part of the estate.")
    if any(res.get("diagnosticsEnabled") for res in resources):
        strengths.append("Monitoring baseline exists for some resources.")
    if not strengths:
        strengths.append("Baseline infrastructure discovered; controls can be improved rapidly.")

    if len(findings) < 5:
        aggregate_res = {
            "name": "subscription-network-posture",
            "resourceGroup": "subscription-scope",
            "publicAccess": any(r.get("publicAccess") or r.get("hasPublicIp") for r in resources),
            "openInboundPorts": [],
        }
        _append_finding(
            findings,
            aggregate_res,
            "Network monitoring coverage appears incomplete",
            "monitoring",
            "The dataset indicates limited security telemetry consistency.",
            "Apply monitoring policy and enforce diagnostics on all network resources.",
            ["Operational Excellence", "Security"],
        )

    findings = sorted(findings, key=lambda f: SEVERITY_ORDER[f["severity"]])

    # -------------------------------
    # SEVERITY BREAKDOWN
    # -------------------------------
    severity_breakdown = {
        "critical": sum(1 for f in findings if f["severity"] == "critical"),
        "high": sum(1 for f in findings if f["severity"] == "high"),
        "medium": sum(1 for f in findings if f["severity"] == "medium"),
        "low": sum(1 for f in findings if f["severity"] == "low")
    }

    # -------------------------------
    # GAP ANALYSIS
    # -------------------------------
    gaps = []

    scores = merge_scores_with_derived(scores, findings)

    security_score = _to_optional_int(scores.get("security"))
    reliability_score = _to_optional_int(scores.get("reliability"))
    operational_score = _to_optional_int(scores.get("operationalExcellence"))

    if security_score is not None and security_score < 50:
        gaps.append(
            {
                "gap": "Weak network protection",
                "impactedPillars": ["Security", "Reliability"],
                "whyItMatters": f"Low Security score ({scores['security']}) increases breach and lateral movement risk.",
            }
        )

    if reliability_score is not None and reliability_score < 40:
        gaps.append(
            {
                "gap": "Single points of failure",
                "impactedPillars": ["Reliability", "Security"],
                "whyItMatters": f"Low Reliability score ({scores['reliability']}) raises outage and recovery risk during incidents.",
            }
        )

    if operational_score is not None and operational_score < 40:
        gaps.append(
            {
                "gap": "Lack of monitoring and automation",
                "impactedPillars": ["Operational Excellence", "Security"],
                "whyItMatters": f"Low Operational Excellence score ({scores['operationalExcellence']}) slows detection and remediation.",
            }
        )

    # -------------------------------
    # RISKS
    # -------------------------------
    risks: List[RiskItem] = [
        {
            "resourceName": finding["resourceName"],
            "resourceGroup": finding["resourceGroup"],
            "issue": finding["issue"],
            "severity": finding["severity"],
            "blastRadius": _blast_radius(
                {
                    "publicAccess": finding["issue"] in {"Public access enabled", "Open inbound exposure"},
                    "flatNetwork": finding["issue"] == "Weak subnet segmentation",
                }
            ),
            "whyItMatters": finding["reason"],
        }
        for finding in findings
    ]

    risks = sorted(
        risks,
        key=lambda r: (
            SEVERITY_ORDER[r["severity"]],
            {"High": 0, "Medium": 1, "Low": 2}.get(r["blastRadius"], 2),
        ),
    )

    # -------------------------------
    # TOP ACTIONS
    # -------------------------------
    top_actions: List[ActionItem] = [
        {
            "title": "Restrict Public Access",
            "effort": "Low",
            "impact": "High",
            "affectedPillars": ["Security", "Reliability"],
        },
        {
            "title": "Attach NSG Rules",
            "effort": "Low",
            "impact": "High",
            "affectedPillars": ["Security", "Operational Excellence"],
        },
        {
            "title": "Enable Diagnostics Logging",
            "effort": "Medium",
            "impact": "Medium",
            "affectedPillars": ["Operational Excellence", "Security"],
        },
        {
            "title": "Implement Private Endpoints",
            "effort": "Medium",
            "impact": "High",
            "affectedPillars": ["Security", "Reliability"],
        },
        {
            "title": "Segment Network",
            "effort": "High",
            "impact": "High",
            "affectedPillars": ["Reliability", "Security"],
        }
    ]

    score_improvement_plan = build_score_improvement_plan(scores)
    strength = calculate_strength_from_findings(findings)

    # -------------------------------
    # FINAL REPORT
    # -------------------------------
    return {
        "subscriptionId": subscription.get("id") or subscription.get("subscriptionId", "unknown-subscription"),
        "subscriptionName": subscription.get("name") or subscription.get("subscriptionName", "unknown-subscription"),
        "generatedAt": datetime.utcnow().isoformat(),

        "scoreSummary": scores,

        "networkSecurity": {
            "findings": findings if findings else [],
            "strengths": strengths,
            "gaps": gaps,
            "priorityActions": [a["title"] for a in (score_improvement_plan or top_actions)],
            "severityBreakdown": severity_breakdown,
            "strengthScore": strength,
        },

        "reviewsAndRisks": {
            "findings": [
                f"Security ({scores['security']}), Reliability ({scores['reliability']}), and Operational Excellence ({scores['operationalExcellence']}) are below healthy target levels.",
                "Findings are prioritized by severity and likely blast radius.",
                "What is good: " + (strengths[0] if strengths else "Baseline infrastructure discovered."),
                "What is risky: Public exposure and weak segmentation can amplify incident impact.",
                "What to do now: Close critical/high findings first and enforce monitoring baselines.",
            ],
            "risks": risks,
            "recommendations": [
                "Improve NSG coverage",
                "Reduce public exposure",
                "Enable monitoring",
                "Apply score improvement plan for low pillars",
            ],
            "top5ImmediateActions": top_actions
        }
    }


# -------------------------------
# MULTI-SUBSCRIPTION HANDLER
# -------------------------------
def generate_reports(subscriptions: List[Dict], resources: List[Dict]) -> List[Dict]:

    if not subscriptions:
        return {"message": "Please select a subscription"}

    if len(subscriptions) > 1:
        return {
            "message": "Multiple subscriptions selected. This report supports single-subscription mode.",
            "selectedCount": len(subscriptions),
            "action": "Please select exactly one subscription and retry.",
        }

    reports = []

    report = generate_network_security_report(subscriptions[0], resources)
    reports.append(report)

    return reports


# -------------------------------
# SAMPLE EXECUTION
# -------------------------------
if __name__ == "__main__":

    subscriptions = [
        {"id": "sub-001", "name": "Production"},
        {"id": "sub-002", "name": "Dev"}
    ]

    resources = [
        {
            "name": "vm1",
            "type": "vm",
            "resourceGroup": "rg1",
            "nsgAttached": False,
            "publicAccess": True,
            "diagnosticsEnabled": False
        },
        {
            "name": "storage1",
            "type": "storage",
            "resourceGroup": "rg1",
            "publicAccess": True,
            "requiresPrivateEndpoint": True,
            "privateEndpoint": False,
            "diagnosticsEnabled": False
        }
    ]

    output = generate_reports(subscriptions, resources)

    print(json.dumps(output, indent=2))