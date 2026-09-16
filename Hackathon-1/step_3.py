import json
import logging
import os
import re
import traceback
from collections import defaultdict

import azure.functions as func

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_INVALID_CHARS = re.compile(r"[^A-Za-z0-9_]")
_AZURE_ID_RE = re.compile(
    r"^/subscriptions/[^/]+/resourcegroups/[^/]+/providers/[^\s]+$",
    re.IGNORECASE,
)


def mermaid_id(name: str) -> str:
    """Return a valid Mermaid node identifier from an arbitrary string."""
    return _INVALID_CHARS.sub("_", name).strip("_") or "unknown"


def mermaid_label(name: str) -> str:
    """Return a quoted display label safe for Mermaid."""
    # Escape double-quotes and wrap
    safe = name.replace('"', "'")
    return f'["{safe}"]'


def add_rel(rels: list, source: str, target: str, relationship: str, seen: set):
    """Append a relationship only if it has not been seen before."""
    key = (source.lower(), target.lower(), relationship.lower())
    if key not in seen:
        seen.add(key)
        rels.append({"source": source, "target": target, "relationship": relationship})


def normalize_resource_id(resource_id: str | None) -> str:
    """Return a normalized Azure resource ID for consistent lookups."""
    if not isinstance(resource_id, str):
        return ""
    return resource_id.strip().rstrip("/").lower()


def parse_resource_id(resource_id: str | None) -> dict | None:
    """Parse Azure resource ID into provider/type/name pairs."""
    normalized = normalize_resource_id(resource_id)
    if not normalized or not _AZURE_ID_RE.match(normalized):
        return None

    parts = [p for p in normalized.strip("/").split("/") if p]
    lower_parts = [p.lower() for p in parts]

    try:
        sub_idx = lower_parts.index("subscriptions")
        rg_idx = lower_parts.index("resourcegroups")
        prov_idx = lower_parts.index("providers")
    except ValueError:
        return None

    if rg_idx + 1 >= len(parts) or prov_idx + 1 >= len(parts):
        return None

    provider_ns = parts[prov_idx + 1]
    tail = parts[prov_idx + 2 :]

    pairs = []
    for i in range(0, len(tail), 2):
        if i + 1 >= len(tail):
            break
        pairs.append({"type": tail[i], "name": tail[i + 1]})

    if not pairs:
        return None

    full_type = provider_ns.lower() + "/" + "/".join(p["type"].lower() for p in pairs)
    resource_name = "/".join(p["name"] for p in pairs)

    return {
        "subscription_id": parts[sub_idx + 1],
        "resource_group": parts[rg_idx + 1],
        "provider": provider_ns.lower(),
        "pairs": pairs,
        "full_type": full_type,
        "name": resource_name,
        "id": normalized,
    }


def iter_azure_ids(value):
    """Recursively yield Azure IDs from nested dict/list structures."""
    if isinstance(value, dict):
        for nested in value.values():
            yield from iter_azure_ids(nested)
        return
    if isinstance(value, list):
        for nested in value:
            yield from iter_azure_ids(nested)
        return
    if isinstance(value, str):
        normalized = normalize_resource_id(value)
        if _AZURE_ID_RE.match(normalized):
            yield normalized


def get_subscriptions_map(payload: dict) -> dict:
    """
    Return normalized subscriptions map from either:
    - relation_mapping_output.json shape: data.subscriptions.{sub_id}
    - input.json shape: data.{sub_id}
    """
    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        return {}

    # Wrapped API shape from relation_maping main response:
    # {
    #   "status": "success",
    #   "total_subscriptions": n,
    #   "data": { "subscriptions": { ... } }
    # }
    nested_data = data.get("data")
    if isinstance(nested_data, dict):
        nested_subscriptions = nested_data.get("subscriptions")
        if isinstance(nested_subscriptions, dict):
            return nested_subscriptions
        if "status" in data or "total_subscriptions" in data:
            return nested_data

    subscriptions = data.get("subscriptions")
    if isinstance(subscriptions, dict):
        return subscriptions

    # Fallback: raw input shape where data is already keyed by subscription id
    return data


def iter_resource_groups(payload: dict):
    """Yield (subscription_id, resource_group_name, resource_group_payload)."""
    for sub_id, sub_data in get_subscriptions_map(payload).items():
        if not isinstance(sub_data, dict):
            continue
        resource_groups = sub_data.get("resource_groups", {})
        if not isinstance(resource_groups, dict):
            continue
        for rg_name, rg_data in resource_groups.items():
            if isinstance(rg_data, dict):
                yield sub_id, rg_name, rg_data


def build_resource_lookup(data: dict, fallback_inventory: dict | None = None) -> tuple[dict, dict]:
    """
    Build in-memory resource lookup keyed by normalized resource ID.
    Returns (lookup, rg_type_sets).
    """
    lookup: dict = {}
    rg_type_sets: dict = {}

    def upsert_resource(resource: dict, default_rg: str):
        if not isinstance(resource, dict):
            return
        rid = normalize_resource_id(resource.get("id"))
        if not rid:
            return
        parsed = parse_resource_id(rid)

        existing = lookup.get(rid, {})
        existing_properties = existing.get("properties") if isinstance(existing, dict) else None
        new_properties = resource.get("properties", {}) or {}
        merged_properties = new_properties if new_properties else (existing_properties or {})

        lookup[rid] = {
            "id": rid,
            "name": resource.get("name") or (parsed or {}).get("name") or existing.get("name", ""),
            "type": (
                resource.get("type")
                or (parsed or {}).get("full_type")
                or existing.get("type", "")
            ).lower(),
            "resource_group": (
                resource.get("resourceGroup")
                or (parsed or {}).get("resource_group")
                or default_rg
                or existing.get("resource_group", "")
            ).lower(),
            "properties": merged_properties,
        }

    for _, rg_name, rg_data in iter_resource_groups(data):
            rg_key = rg_name.lower()
            rg_type_sets[rg_key] = {
                "function_apps": set(rg_data.get("categories", {}).get("app_services", {}).get("function_apps", [])),
                "web_apps": set(rg_data.get("categories", {}).get("app_services", {}).get("web_apps", [])),
                "logic_apps": set(rg_data.get("categories", {}).get("app_services", {}).get("logic_apps", [])),
            }

            raw_resources = rg_data.get("resources", [])
            for resource in raw_resources:
                upsert_resource(resource, rg_name)

            rel_items = rg_data.get("relationships", [])
            for rel in rel_items:
                child_ids = rel.get("child_ids", [])
                child_types = rel.get("child_types", [])
                child_name = rel.get("child", "")
                for idx, child_id in enumerate(child_ids):
                    rid = normalize_resource_id(child_id)
                    if not rid:
                        continue
                    if rid in lookup:
                        continue
                    parsed = parse_resource_id(rid)
                    child_type = ""
                    if idx < len(child_types):
                        child_type = child_types[idx]
                    if not child_type:
                        child_type = (parsed or {}).get("full_type", "")
                    lookup[rid] = {
                        "id": rid,
                        "name": child_name or (parsed or {}).get("name") or "",
                        "type": (child_type or "").lower(),
                        "resource_group": rg_name.lower(),
                        "properties": {},
                    }

    # Fallback enrichment: read full raw inventory resources (with properties)
    if fallback_inventory:
        for _, rg_name, rg_data in iter_resource_groups(fallback_inventory):
            resources = rg_data.get("resources", [])
            if not isinstance(resources, list):
                continue
            for resource in resources:
                upsert_resource(resource, rg_name)

    return lookup, rg_type_sets


def _dependency_label(source_resource: dict, target_resource: dict, rg_type_sets: dict) -> str | None:
    """Map source/target resource types to required architecture dependency labels."""
    source_type = (source_resource.get("type") or "").lower()
    target_type = (target_resource.get("type") or "").lower()
    source_name = source_resource.get("name") or ""
    source_rg = (source_resource.get("resource_group") or "").lower()

    if source_type == "microsoft.compute/virtualmachines" and target_type == "microsoft.network/networkinterfaces":
        return "uses_nic"
    if source_type == "microsoft.compute/virtualmachines" and target_type == "microsoft.compute/disks":
        return "uses_disk"
    if source_type == "microsoft.network/networkinterfaces" and target_type == "microsoft.network/virtualnetworks/subnets":
        return "connected_to_subnet"
    if source_type == "microsoft.network/virtualnetworks/subnets" and target_type == "microsoft.network/virtualnetworks":
        return "belongs_to_vnet"
    if source_type == "microsoft.network/networkinterfaces" and target_type == "microsoft.network/publicipaddresses":
        return "uses_public_ip"
    if source_type == "microsoft.network/networkinterfaces" and target_type == "microsoft.network/networksecuritygroups":
        return "protected_by"
    if source_type == "microsoft.network/routetables" and target_type == "microsoft.network/virtualnetworks/subnets":
        return "routes"
    if source_type == "microsoft.network/privateendpoints" and target_type == "microsoft.network/virtualnetworks/subnets":
        return "connected_to_subnet"
    if source_type == "microsoft.insights/components" and target_type == "microsoft.operationalinsights/workspaces":
        return "sends_logs_to"

    if source_type == "microsoft.web/sites" and target_type == "microsoft.storage/storageaccounts":
        rg_sets = rg_type_sets.get(source_rg, {})
        if source_name in rg_sets.get("function_apps", set()):
            return "uses_storage"

    if source_type == "microsoft.web/sites" and target_type == "microsoft.web/serverfarms":
        rg_sets = rg_type_sets.get(source_rg, {})
        if source_name in rg_sets.get("function_apps", set()) or source_name in rg_sets.get("web_apps", set()):
            return "hosted_on"

    if source_type == "microsoft.automation/automationaccounts" and target_type == "microsoft.automation/automationaccounts/runbooks":
        return "contains"
    if source_type == "microsoft.network/privatednszones" and target_type == "microsoft.network/privatednszones/virtualnetworklinks":
        return "linked_to"

    return None


def extract_network_dependencies(resource_lookup: dict, rg_type_sets: dict) -> list:
    """
    PHASE 1.5: extract cross-resource dependencies by recursively scanning
    Azure Resource IDs found under each resource properties payload.
    """
    deps: list = []
    seen: set = set()

    for source_id, source_resource in resource_lookup.items():
        properties = source_resource.get("properties", {})
        if not properties:
            continue

        for referenced_id in iter_azure_ids(properties):
            target = resource_lookup.get(referenced_id)
            if target is None:
                parsed = parse_resource_id(referenced_id)
                if parsed:
                    target = {
                        "id": referenced_id,
                        "name": parsed.get("name", ""),
                        "type": parsed.get("full_type", ""),
                        "resource_group": parsed.get("resource_group", ""),
                        "properties": {},
                    }
                else:
                    continue

            label = _dependency_label(source_resource, target, rg_type_sets)
            if not label:
                continue

            add_rel(
                deps,
                source_resource.get("name", ""),
                target.get("name", ""),
                label,
                seen,
            )

            # Explicitly derive Subnet -> VNet for all referenced subnet IDs
            target_type = (target.get("type") or "").lower()
            if target_type == "microsoft.network/virtualnetworks/subnets":
                parsed_target = parse_resource_id(target.get("id", ""))
                if parsed_target:
                    pairs = parsed_target.get("pairs", [])
                    if len(pairs) >= 2:
                        vnet_name = pairs[0].get("name", "")
                        subnet_name = pairs[1].get("name", "")
                        if vnet_name and subnet_name:
                            add_rel(deps, subnet_name, vnet_name, "belongs_to_vnet", seen)

    return deps


# ---------------------------------------------------------------------------
# Relationship type → human label mapping
# ---------------------------------------------------------------------------

_TYPE_RELATIONSHIP = {
    # networking
    "microsoft.network/virtualnetworks": "contains",
    "microsoft.network/networksecuritygroups": "secured_by",
    "microsoft.network/publicipaddresses": "uses",
    "microsoft.network/networkinterfaces": "uses",
    "microsoft.network/privateendpoints": "connected_via",
    "microsoft.network/privatednszones": "dns_zone",
    "microsoft.network/privatednszones/virtualnetworklinks": "linked_to",
    "microsoft.network/routetables": "routes",
    # compute
    "microsoft.compute/virtualmachines": "contains",
    "microsoft.compute/disks": "attached_to",
    "microsoft.compute/virtualmachinescalesets": "contains",
    "microsoft.compute/virtualmachines/runcommands": "runs_on",
    # app
    "microsoft.web/sites": "hosted_on",
    "microsoft.web/serverfarms": "uses_plan",
    "microsoft.web/connections": "connects_to",
    "microsoft.logic/workflows": "contains",
    # storage
    "microsoft.storage/storageaccounts": "uses",
    # monitoring
    "microsoft.insights/components": "monitors",
    "microsoft.operationalinsights/workspaces": "logs_to",
    # security
    "microsoft.keyvault/vaults": "secured_by",
    # identity
    "microsoft.managedidentity/userassignedidentities": "uses_identity",
    # ai
    "microsoft.cognitiveservices/accounts": "uses_ai",
    "microsoft.cognitiveservices/accounts/projects": "sub_project_of",
    # automation
    "microsoft.automation/automationaccounts": "contains",
    "microsoft.automation/automationaccounts/runbooks": "runbook_in",
    # api
    "microsoft.apimanagement/service": "exposes",
}


def _rel_label(child_type: str, parent_type: str) -> str:
    """Derive a human-friendly relationship label from child/parent types."""
    ct = (child_type or "").lower()
    pt = (parent_type or "").lower()

    if pt == "resource_group":
        return "contains"
    if ct in _TYPE_RELATIONSHIP:
        return _TYPE_RELATIONSHIP[ct]
    if "subnet" in ct:
        return "subnet_of"
    return "related_to"


# ---------------------------------------------------------------------------
# PHASE 1 – Relationship extraction
# ---------------------------------------------------------------------------

def extract_relationships(data: dict, fallback_inventory: dict | None = None) -> list:
    """
    Walk the relation_mapping_output structure and produce a flat list of
    { source, target, relationship } dicts.

    Sources merged in order:
      PHASE 1   - hierarchy relationships from relation_mapping_output.json
      PHASE 1.5 - property-scanned dependencies (when fallback_inventory provided)
      PHASE 2.5 - topology_relationships pre-computed by relation_maping.py
    """
    rels: list = []
    seen: set = set()

    resource_lookup, rg_type_sets = build_resource_lookup(data, fallback_inventory=fallback_inventory)

    subscriptions = get_subscriptions_map(data)

    for sub_id, sub_data in subscriptions.items():
        if not isinstance(sub_data, dict):
            continue
        sub_label = f"Subscription_{sub_id[:8]}"

        resource_groups = sub_data.get("resource_groups", {})
        for rg_name, rg_data in resource_groups.items():

            # Rule 1 – Subscription contains RG
            add_rel(rels, sub_label, rg_name, "contains", seen)

            categories = rg_data.get("categories", {})
            relationships = rg_data.get("relationships", [])

            # ----------------------------------------------------------------
            # Rules derived from pre-computed parent→child relationships
            # ----------------------------------------------------------------
            for rel_entry in relationships:
                parent = rel_entry.get("parent", "")
                child = rel_entry.get("child", "")
                parent_type = rel_entry.get("parent_type", "")
                child_types = rel_entry.get("child_types", [rel_entry.get("child_type", "")])

                if not parent or not child:
                    continue

                for ct in child_types:
                    label = _rel_label(ct, parent_type)
                    add_rel(rels, parent, child, label, seen)

            # ----------------------------------------------------------------
            # Rule 3 – VNet contains Subnets
            # ----------------------------------------------------------------
            vnets = categories.get("networking", {}).get("virtual_networks", {})
            for vnet_name, vnet_info in vnets.items():
                subnets = vnet_info.get("subnets", [])
                for subnet in subnets:
                    subnet_name = subnet if isinstance(subnet, str) else subnet.get("name", "")
                    if subnet_name:
                        add_rel(rels, vnet_name, subnet_name, "contains_subnet", seen)

            app_service_plans = categories.get("app_services", {}).get("app_service_plans", [])
            function_apps = categories.get("app_services", {}).get("function_apps", [])
            web_apps = categories.get("app_services", {}).get("web_apps", [])
            logic_apps_cat = categories.get("app_services", {}).get("logic_apps", [])
            storage_accounts = categories.get("storage", {}).get("storage_accounts", [])
            app_insights_list = categories.get("monitoring", {}).get("application_insights", [])
            log_workspaces = categories.get("monitoring", {}).get("log_analytics_workspaces", [])

            # Rule 10 – App Service -> App Service Plan heuristic (fallback)
            if len(app_service_plans) == 1:
                only_plan = app_service_plans[0]
                for app in function_apps + web_apps + logic_apps_cat:
                    add_rel(rels, app, only_plan, "hosted_on", seen)

            # Rule 11 – Function App uses Storage Account
            # Best heuristic: match by name similarity (function app name prefix in storage name)
            for fa in function_apps:
                fa_lower = fa.lower().replace("-", "").replace("_", "")
                for sa in storage_accounts:
                    sa_lower = sa.lower().replace("-", "").replace("_", "")
                    if fa_lower[:6] and (fa_lower[:6] in sa_lower or sa_lower[:6] in fa_lower):
                        add_rel(rels, fa, sa, "uses_storage", seen)

            # Rule 12 – AppInsights sends logs to Log Analytics Workspace
            for ai in app_insights_list:
                ai_base = ai.lower().replace("-appinsights", "").replace("_appinsights", "")
                for lw in log_workspaces:
                    lw_base = lw.lower().replace("-logs", "").replace("-log", "").replace("_logs", "")
                    if ai_base == lw_base or (len(ai_base) > 4 and ai_base in lw_base):
                        add_rel(rels, ai, lw, "sends_logs_to", seen)

            # ----------------------------------------------------------------
            # PHASE 2.5 – ingest pre-computed topology_relationships
            # These are produced by relation_maping.py from actual resource
            # properties (VM->NIC, NIC->Subnet, NIC->NSG, etc.) and are already
            # present in relation_mapping_output.json.
            # ----------------------------------------------------------------
            for topo in rg_data.get("topology_relationships", []):
                src = topo.get("source", "")
                tgt = topo.get("target", "")
                rel = topo.get("relationship", "")
                if src and tgt and rel:
                    add_rel(rels, src, tgt, rel, seen)

    # PHASE 1.5 – recursive property-based dependency extraction
    # (only active when a raw inventory fallback is provided; skipped when
    #  topology_relationships already covers all dependencies via PHASE 2.5)
    dependency_relationships = extract_network_dependencies(resource_lookup, rg_type_sets)
    for dep in dependency_relationships:
        add_rel(rels, dep["source"], dep["target"], dep["relationship"], seen)

    return rels


# ---------------------------------------------------------------------------
# PHASE 2 – Mermaid diagram generation
# ---------------------------------------------------------------------------

ALWAYS_EXPAND_TYPES = {
    "microsoft.network/virtualnetworks",
    "microsoft.network/subnets",
    "microsoft.compute/virtualmachines",
    "microsoft.network/networkinterfaces",
    "microsoft.network/networksecuritygroups",
    "microsoft.network/publicipaddresses",
    "microsoft.keyvault/vaults",
}

CATEGORY_LABELS = {
    "app_services": "AppServices",
    "networking": "Networking",
    "compute": "Compute",
    "storage": "Storage",
    "security": "Security",
    "monitoring": "Monitoring",
    "identity": "Identity",
    "ai_services": "AIServices",
    "other_resources": "Other",
}


def _rg_resource_count(rg_data: dict) -> int:
    return rg_data.get("total_resources", 0)


def _collect_rg_resources_by_category(rg_name: str, categories: dict) -> dict:
    """
    Returns a dict of category_label -> list_of_resource_names.
    Filters out empty categories.
    """
    result = {}
    for cat_key, cat_label in CATEGORY_LABELS.items():
        cat = categories.get(cat_key, {})
        names = []
        if isinstance(cat, dict):
            for sub_key, sub_val in cat.items():
                if isinstance(sub_val, list):
                    names.extend(sub_val)
                elif isinstance(sub_val, dict):  # virtual_networks
                    names.extend(sub_val.keys())
        elif isinstance(cat, list):
            names.extend(cat)
        if names:
            result[cat_label] = names
    return result


def _always_expand_resources(categories: dict) -> list:
    """Return resources that must always be shown as individual nodes."""
    must_expand = []
    net = categories.get("networking", {})
    vnets = net.get("virtual_networks", {})
    must_expand.extend(vnets.keys())
    for _, vnet_info in vnets.items():
        subnets = vnet_info.get("subnets", [])
        for subnet in subnets:
            if isinstance(subnet, str):
                must_expand.append(subnet)
            elif isinstance(subnet, dict) and subnet.get("name"):
                must_expand.append(subnet["name"])
    must_expand.extend(net.get("network_security_groups", []))
    must_expand.extend(net.get("public_ip_addresses", []))
    must_expand.extend(net.get("network_interfaces", []))
    must_expand.extend(categories.get("compute", {}).get("virtual_machines", []))
    must_expand.extend(categories.get("security", {}).get("keyvaults", []))
    return must_expand


def generate_mermaid(data: dict, relationships: list) -> str:
    """
    Generate a Mermaid graph TD diagram from the inventory + relationships.
    """
    lines = ["graph TD"]
    node_declared: set = set()
    label_to_nodes: dict = defaultdict(list)

    def register_label(label: str, node_id: str, rg_name: str):
        key = (label or "").lower()
        if key:
            label_to_nodes[key].append((node_id, rg_name.lower()))

    def declare(node_id: str, label: str, rg_name: str = ""):
        if node_id not in node_declared:
            node_declared.add(node_id)
            safe_label = label.replace('"', "'")
            lines.append(f'    {node_id}["{safe_label}"]')
        register_label(label, node_id, rg_name)

    def edge(src_id: str, tgt_id: str, label: str = ""):
        if label:
            safe = label.replace('"', "'")
            lines.append(f'    {src_id} -->|"{safe}"| {tgt_id}')
        else:
            lines.append(f"    {src_id} --> {tgt_id}")

    added_edges: set = set()

    def safe_edge(src_id: str, tgt_id: str, label: str = ""):
        key = (src_id, tgt_id, label)
        if key not in added_edges:
            added_edges.add(key)
            edge(src_id, tgt_id, label)

    subscriptions = data.get("data", {}).get("subscriptions", {})

    for sub_id, sub_data in subscriptions.items():
        sub_label = f"Subscription {sub_id[:8]}..."
        sub_id_node = mermaid_id(f"Sub_{sub_id[:8]}")
        declare(sub_id_node, sub_label)
        register_label(f"Subscription_{sub_id[:8]}", sub_id_node, "")

        resource_groups = sub_data.get("resource_groups", {})
        for rg_name, rg_data in resource_groups.items():
            rg_node = mermaid_id(f"RG_{rg_name}")
            declare(rg_node, f"RG: {rg_name}", rg_name)
            register_label(rg_name, rg_node, rg_name)
            safe_edge(sub_id_node, rg_node)

            categories = rg_data.get("categories", {})
            total = _rg_resource_count(rg_data)
            must_expand = set(_always_expand_resources(categories))

            if total > 50:
                # Group most resources into category boxes; always expand critical ones
                by_cat = _collect_rg_resources_by_category(rg_name, categories)
                for cat_label, resources in by_cat.items():
                    cat_node = mermaid_id(f"{rg_node}_{cat_label}")

                    # Collect resources that must be expanded individually
                    expand_here = [r for r in resources if r in must_expand]
                    group_rest = [r for r in resources if r not in must_expand]

                    if group_rest:
                        declare(cat_node, f"{cat_label} ({len(group_rest)})", rg_name)
                        safe_edge(rg_node, cat_node)

                    for res in expand_here:
                        res_node = mermaid_id(f"{rg_node}_{res}")
                        declare(res_node, res, rg_name)
                        safe_edge(rg_node, res_node)

                # Always force VNet -> Subnet expansion for large RGs
                vnets = categories.get("networking", {}).get("virtual_networks", {})
                for vnet_name, vnet_info in vnets.items():
                    vnet_node = mermaid_id(f"{rg_node}_{vnet_name}")
                    declare(vnet_node, vnet_name, rg_name)
                    safe_edge(rg_node, vnet_node)
                    for subnet in vnet_info.get("subnets", []):
                        subnet_name = subnet if isinstance(subnet, str) else subnet.get("name", "")
                        if subnet_name:
                            subnet_node = mermaid_id(f"{rg_node}_{subnet_name}")
                            declare(subnet_node, subnet_name, rg_name)
                            safe_edge(vnet_node, subnet_node, "contains_subnet")
            else:
                # Expand all resources as individual nodes
                relationships_in_rg = rg_data.get("relationships", [])
                rg_resource_nodes: dict = {}

                for rel in relationships_in_rg:
                    for name in [rel.get("parent", ""), rel.get("child", "")]:
                        if name and name.lower() != rg_name.lower() and name not in rg_resource_nodes:
                            node_id = mermaid_id(f"{rg_node}_{name}")
                            rg_resource_nodes[name] = node_id

                # Declare resource nodes
                for res_name, res_node in rg_resource_nodes.items():
                    declare(res_node, res_name, rg_name)

                # Declare edges inside RG
                for rel in relationships_in_rg:
                    parent = rel.get("parent", "")
                    child = rel.get("child", "")
                    parent_type = rel.get("parent_type", "")

                    if not parent or not child:
                        continue

                    if parent.lower() == rg_name.lower():
                        src_node = rg_node
                    else:
                        src_node = rg_resource_nodes.get(parent, mermaid_id(f"{rg_node}_{parent}"))
                        if src_node not in node_declared:
                            declare(src_node, parent, rg_name)

                    tgt_node = rg_resource_nodes.get(child, mermaid_id(f"{rg_node}_{child}"))
                    if tgt_node not in node_declared:
                        declare(tgt_node, child, rg_name)

                    child_type = rel.get("child_type", "")
                    rel_label = _rel_label(child_type, parent_type)
                    safe_edge(src_node, tgt_node, rel_label)

        lines.append("")  # blank line between subscriptions

    # ----------------------------------------------------------------
    # Add semantic + dependency edges from Phase 1/1.5
    # ----------------------------------------------------------------
    lines.append("    %% --- semantic relationships ---")
    for r in relationships:
        source_name = r.get("source", "")
        target_name = r.get("target", "")
        lbl = r.get("relationship", "")

        src_candidates = label_to_nodes.get(source_name.lower(), [])
        tgt_candidates = label_to_nodes.get(target_name.lower(), [])

        if not src_candidates or not tgt_candidates:
            continue

        same_rg_pairs = []
        for src_node, src_rg in src_candidates:
            for tgt_node, tgt_rg in tgt_candidates:
                if src_rg and tgt_rg and src_rg == tgt_rg:
                    same_rg_pairs.append((src_node, tgt_node))

        pairs = same_rg_pairs if same_rg_pairs else [(src_candidates[0][0], tgt_candidates[0][0])]
        for src_node, tgt_node in pairs:
            safe_edge(src_node, tgt_node, lbl)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Azure Function entry point
# ---------------------------------------------------------------------------

INPUT_FILE = os.path.join(os.path.dirname(__file__), "relation_mapping_output.json")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "architecture.json")


def build_architecture_model(input_data: dict) -> dict:
    """
    Consumes relation_mapping_output.json and produces:
      - relationships  : merged hierarchy + PHASE 2.5 topology relationships
      - mermaid        : Mermaid graph TD diagram
      - relationships_count
    """
    # topology_relationships are already embedded in relation_mapping_output.json
    # by relation_maping.py (PHASE 2.5), so no fallback inventory needed.
    relationships = extract_relationships(input_data)
    mermaid_diagram = generate_mermaid(input_data, relationships)
    return {
        "relationships": relationships,
        "mermaid": mermaid_diagram,
        "relationships_count": len(relationships),
    }


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("step_3: architecture model + Mermaid diagram generation triggered.")

    try:
        # Accept input from request body first, fall back to file
        try:
            input_data = req.get_json()
        except Exception:
            input_data = None

        if not input_data:
            if not os.path.exists(INPUT_FILE):
                return func.HttpResponse(
                    json.dumps({"error": f"Input file not found: {INPUT_FILE}"}),
                    status_code=404,
                    mimetype="application/json",
                )
            with open(INPUT_FILE, "r", encoding="utf-8-sig") as f:
                input_data = json.load(f)

        result = build_architecture_model(input_data)
        logging.info(
            "step_3: generated %d relationships, mermaid diagram %d chars.",
            result["relationships_count"],
            len(result["mermaid"]),
        )

        # Persist output to architecture.json alongside the function app
        try:
            with open(OUTPUT_FILE, "w", encoding="utf-8") as out_f:
                json.dump(result, out_f, indent=2, ensure_ascii=False)
            logging.info("step_3: wrote output to %s", OUTPUT_FILE)
        except Exception as write_exc:
            logging.warning("step_3: could not write %s: %s", OUTPUT_FILE, write_exc)

        return func.HttpResponse(
            json.dumps(result, indent=2, ensure_ascii=False),
            status_code=200,
            mimetype="application/json",
        )

    except Exception as exc:
        logging.error("step_3 error: %s\n%s", exc, traceback.format_exc())
        return func.HttpResponse(
            json.dumps({"error": str(exc), "trace": traceback.format_exc()}),
            status_code=500,
            mimetype="application/json",
        )
