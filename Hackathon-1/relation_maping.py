import json
import logging
import traceback

import azure.functions as func


RESOURCE_CATEGORY_MAP = {
    "microsoft.logic/workflows": ("app_services", "logic_apps"),
    "microsoft.web/serverfarms": ("app_services", "app_service_plans"),
    "microsoft.keyvault/vaults": ("security", "keyvaults"),
    "microsoft.storage/storageaccounts": ("storage", "storage_accounts"),
    "microsoft.compute/virtualmachines": ("compute", "virtual_machines"),
    "microsoft.compute/virtualmachinescalesets": ("compute", "virtual_machine_scale_sets"),
    "microsoft.network/networksecuritygroups": ("networking", "network_security_groups"),
    "microsoft.network/publicipaddresses": ("networking", "public_ip_addresses"),
    "microsoft.network/networkinterfaces": ("networking", "network_interfaces"),
    "microsoft.insights/components": ("monitoring", "application_insights"),
    "microsoft.operationalinsights/workspaces": ("monitoring", "log_analytics_workspaces"),
    "microsoft.managedidentity/userassignedidentities": ("identity", "managed_identities"),
    "microsoft.cognitiveservices/accounts": ("ai_services", "cognitive_services"),
}


def normalize_resource_type(resource_type: str | None) -> str:
    return (resource_type or "").strip().lower()


def extract_resource_id_components(resource_id: str | None) -> dict | None:
    if not resource_id or not isinstance(resource_id, str):
        return None

    normalized = resource_id.strip().strip("/")
    if not normalized:
        return None

    parts = [segment for segment in normalized.split("/") if segment]
    parts_lower = [segment.lower() for segment in parts]

    try:
        sub_index = parts_lower.index("subscriptions")
        rg_index = parts_lower.index("resourcegroups")
        providers_index = parts_lower.index("providers")
    except ValueError:
        return None

    if rg_index + 1 >= len(parts) or providers_index + 1 >= len(parts):
        return None

    subscription_id = parts[sub_index + 1] if sub_index + 1 < len(parts) else None
    resource_group_name = parts[rg_index + 1]
    provider_namespace = parts[providers_index + 1]

    resource_segments = parts[providers_index + 2:]
    if len(resource_segments) < 2:
        return {
            "subscription_id": subscription_id,
            "resource_group": resource_group_name,
            "provider_namespace": provider_namespace,
            "pairs": [],
            "full_type": "",
            "resource_name": None,
        }

    pair_count = len(resource_segments) // 2
    pairs: list[dict] = []
    for pair_index in range(pair_count):
        type_name = resource_segments[pair_index * 2]
        resource_name = resource_segments[pair_index * 2 + 1]
        type_path = "/".join(segment.lower() for segment, _ in [(p["type"], p["name"]) for p in pairs])
        pairs.append({
            "type": type_name,
            "name": resource_name,
            "type_path": (
                f"{provider_namespace}/{type_name}".lower()
                if not type_path
                else f"{provider_namespace}/{type_path}/{type_name}".lower()
            ),
        })

    return {
        "subscription_id": subscription_id,
        "resource_group": resource_group_name,
        "provider_namespace": provider_namespace,
        "pairs": pairs,
        "full_type": pairs[-1]["type_path"] if pairs else "",
        "resource_name": pairs[-1]["name"] if pairs else None,
    }


def extract_parent_from_id(resource_id: str) -> tuple[str, str] | None:
    parsed = extract_resource_id_components(resource_id)
    if not parsed:
        return None

    pairs = parsed.get("pairs", [])
    resource_group = parsed.get("resource_group")
    if not pairs:
        return (resource_group, "resource_group") if resource_group else None

    if len(pairs) == 1:
        return (resource_group, "resource_group") if resource_group else None

    parent_pair = pairs[-2]
    return (parent_pair["name"], parent_pair["type_path"])


def build_relationship_entry(resource: dict) -> dict | None:
    child_name = resource.get("name")
    child_type = normalize_resource_type(resource.get("type"))
    resource_id = resource.get("id")

    if not child_name or not child_type:
        return None

    parent = extract_parent_from_id(resource_id)
    if parent is None:
        return None

    parent_name, parent_type = parent
    if not parent_name or not parent_type:
        return None

    return {
        "child": child_name,
        "child_id": resource_id,
        "child_type": child_type,
        "parent": parent_name,
        "parent_type": parent_type,
    }


def compact_relationships(relationships: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], dict] = {}

    for rel in relationships:
        parent = rel.get("parent")
        child = rel.get("child")
        parent_type = normalize_resource_type(rel.get("parent_type"))
        child_type = normalize_resource_type(rel.get("child_type"))

        if not parent or not child:
            continue

        key = (str(parent).lower(), str(child).lower())
        if key not in grouped:
            grouped[key] = {
                "parent": parent,
                "parent_type": parent_type or "unknown",
                "parent_types": set(),
                "child": child,
                "child_type": child_type or "unknown",
                "child_types": set(),
                "child_ids": set(),
                "relation_count": 0,
            }

        entry = grouped[key]
        if parent_type:
            entry["parent_types"].add(parent_type)
        if child_type:
            entry["child_types"].add(child_type)
        child_id = rel.get("child_id")
        if child_id:
            entry["child_ids"].add(child_id)
        entry["relation_count"] += 1

    compacted: list[dict] = []
    for entry in grouped.values():
        parent_types = sorted(entry["parent_types"])
        child_types = sorted(entry["child_types"])
        child_ids = sorted(entry["child_ids"])

        compacted.append({
            "parent": entry["parent"],
            "parent_type": parent_types[0] if len(parent_types) == 1 else "multiple",
            "parent_types": parent_types,
            "child": entry["child"],
            "child_type": child_types[0] if len(child_types) == 1 else "multiple",
            "child_types": child_types,
            "child_ids": child_ids,
            "relation_count": entry["relation_count"],
        })

    return sorted(compacted, key=lambda item: (item["parent"].lower(), item["child"].lower()))


def build_hierarchy_map(relationships: list[dict]) -> dict[str, list[str]]:
    hierarchy: dict[str, set[str]] = {}
    canonical_keys: dict[str, str] = {}

    for item in relationships:
        parent = item.get("parent")
        child = item.get("child")
        if not parent or not child:
            continue

        parent_key = str(parent)
        parent_key_normalized = parent_key.lower()

        if parent_key_normalized not in canonical_keys:
            canonical_keys[parent_key_normalized] = parent_key

        resolved_parent_key = canonical_keys[parent_key_normalized]
        if resolved_parent_key not in hierarchy:
            hierarchy[resolved_parent_key] = set()
        hierarchy[resolved_parent_key].add(child)

    return {
        parent: sorted(children)
        for parent, children in hierarchy.items()
    }


def _create_empty_categories() -> dict:
    return {
        "app_services": {
            "function_apps": [],
            "logic_apps": [],
            "web_apps": [],
            "app_service_plans": [],
        },
        "networking": {
            "virtual_networks": {},
            "network_security_groups": [],
            "public_ip_addresses": [],
            "network_interfaces": [],
        },
        "security": {
            "keyvaults": [],
        },
        "storage": {
            "storage_accounts": [],
        },
        "compute": {
            "virtual_machines": [],
            "virtual_machine_scale_sets": [],
        },
        "monitoring": {
            "application_insights": [],
            "log_analytics_workspaces": [],
        },
        "identity": {
            "managed_identities": [],
        },
        "ai_services": {
            "openai_resources": [],
            "cognitive_services": [],
        },
        "other_resources": [],
    }


def _is_likely_function_app(resource_name: str, resource_props: dict) -> bool:
    name_l = resource_name.lower()
    if any(token in name_l for token in ["func", "function", "fa-"]):
        return True

    return False


def _classify_web_site(resource_name: str, resource_props: dict) -> str:
    props = resource_props or {}
    kind = str(props.get("kind") or "").lower()
    function_config = props.get("functionAppConfig")
    name_l = resource_name.lower()

    if "logic" in name_l:
        return "logic_apps"

    if "functionapp" in kind or function_config is not None:
        return "function_apps"

    if _is_likely_function_app(resource_name, props):
        return "function_apps"

    return "web_apps"


def _add_typed_resource(categories: dict, resource_type: str, resource_name: str, resource_props: dict) -> None:
    if resource_type == "microsoft.web/sites":
        sub_category = _classify_web_site(resource_name, resource_props)
        categories["app_services"][sub_category].append(resource_name)
        return

    mapped_path = RESOURCE_CATEGORY_MAP.get(resource_type)
    if mapped_path is None:
        categories["other_resources"].append(resource_name)
        return

    parent_key, child_key = mapped_path
    categories[parent_key][child_key].append(resource_name)

    if resource_type == "microsoft.cognitiveservices/accounts":
        props_str = json.dumps(resource_props or {}).lower()
        if "openai" in resource_name.lower() or "openai" in props_str:
            categories["ai_services"]["openai_resources"].append(resource_name)


def _build_categories_for_resources(resources: list[dict]) -> dict:
    categories = _create_empty_categories()

    for resource in resources:
        resource_type = normalize_resource_type(resource.get("type"))
        resource_name = resource.get("name")

        if resource_type == "microsoft.network/virtualnetworks" and resource_name:
            if resource_name not in categories["networking"]["virtual_networks"]:
                categories["networking"]["virtual_networks"][resource_name] = {"subnets": []}

    for resource in resources:
        resource_type = normalize_resource_type(resource.get("type"))
        resource_id = resource.get("id") or ""
        resource_name = resource.get("name")

        if "virtualnetworks/subnets" in resource_type and resource_name:
            parsed = extract_resource_id_components(resource_id)
            if not parsed or len(parsed.get("pairs", [])) < 2:
                continue

            parent_vnet = parsed["pairs"][-2]["name"]
            if parent_vnet not in categories["networking"]["virtual_networks"]:
                categories["networking"]["virtual_networks"][parent_vnet] = {"subnets": []}

            categories["networking"]["virtual_networks"][parent_vnet]["subnets"].append(resource_name)

    for resource in resources:
        resource_type = normalize_resource_type(resource.get("type"))
        resource_name = resource.get("name")
        resource_properties = resource.get("properties") or {}

        if not resource_name:
            continue

        if (
            resource_type != "microsoft.network/virtualnetworks"
            and "virtualnetworks/subnets" not in resource_type
        ):
            _add_typed_resource(categories, resource_type, resource_name, resource_properties)

    return categories


# ---------------------------------------------------------------------------
# PHASE 2.5 – Azure Topology Dependency Extraction
# ---------------------------------------------------------------------------

_AZURE_ID_RE_SIMPLE = "/subscriptions/"


def _is_azure_resource_id(value: str) -> bool:
    """Fast check: must look like an Azure resource ID."""
    if not isinstance(value, str):
        return False
    lower = value.lower()
    return (
        lower.startswith("/subscriptions/")
        and "/resourcegroups/" in lower
        and "/providers/" in lower
    )


def build_resource_lookup(resources: list[dict]) -> dict[str, dict]:
    """
    Build an in-memory lookup: resource id (lowercase) -> resource dict.
    Includes synthesised stub entries for subnets referenced by VNet properties
    so that subnet IDs can be resolved even if subnets are not top-level resources.
    """
    lookup: dict[str, dict] = {}

    for resource in resources:
        if not isinstance(resource, dict):
            continue
        rid = resource.get("id")
        if rid and isinstance(rid, str):
            lookup[rid.lower()] = resource

    # Synthesise subnet stubs from VNet subnets[] property
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        rtype = normalize_resource_type(resource.get("type"))
        if rtype != "microsoft.network/virtualnetworks":
            continue
        props = resource.get("properties") or {}
        vnet_id = (resource.get("id") or "").lower()
        for subnet in props.get("subnets") or []:
            if not isinstance(subnet, dict):
                continue
            subnet_id = subnet.get("id")
            if not subnet_id:
                continue
            sub_id_lower = subnet_id.lower()
            if sub_id_lower not in lookup:
                parsed = extract_resource_id_components(subnet_id)
                subnet_name = (parsed or {}).get("resource_name") or subnet.get("name") or sub_id_lower.split("/")[-1]
                lookup[sub_id_lower] = {
                    "id": subnet_id,
                    "name": subnet_name,
                    "type": "microsoft.network/virtualnetworks/subnets",
                    "resourceGroup": resource.get("resourceGroup") or "",
                    "properties": subnet.get("properties") or {},
                    "_vnet_id": vnet_id,
                    "_vnet_name": resource.get("name") or "",
                }

    return lookup


def _get_resource_name(resource_lookup: dict[str, dict], resource_id: str, fallback_name: str = "") -> str:
    """Resolve a resource name from the lookup, or extract it from the ID path."""
    if not resource_id:
        return fallback_name
    entry = resource_lookup.get(resource_id.lower())
    if entry:
        return entry.get("name") or fallback_name
    parsed = extract_resource_id_components(resource_id)
    if parsed:
        return parsed.get("resource_name") or fallback_name
    return fallback_name


def _add_topology_rel(
    rels: list[dict],
    seen: set[tuple],
    source: str,
    target: str,
    relationship: str,
    source_type: str = "",
    target_type: str = "",
) -> None:
    """Append a topology relationship if not already seen."""
    if not source or not target:
        return
    key = (source.lower(), target.lower(), relationship.lower())
    if key in seen:
        return
    seen.add(key)
    rels.append({
        "source": source,
        "source_type": source_type,
        "target": target,
        "target_type": target_type,
        "relationship": relationship,
    })


def extract_topology_relationships(
    resources: list[dict],
    resource_lookup: dict[str, dict],
    function_apps: set[str],
    web_apps: set[str],
) -> list[dict]:
    """
    PHASE 2.5 – Scan resource properties and emit topology-level relationships.

    Rules implemented:
      1.  VM -> NIC          (uses_nic)            networkProfile.networkInterfaces[].id
      2.  VM -> Disk         (uses_disk)           storageProfile osDisk / dataDisks
      3.  NIC -> Subnet      (connected_to_subnet) ipConfigurations[].properties.subnet.id
      4.  Subnet -> VNet     (belongs_to_vnet)     derived from subnet stub _vnet_name
      5.  NIC -> PublicIP    (uses_public_ip)      ipConfigurations[].properties.publicIPAddress.id
      6.  NIC -> NSG         (protected_by)        networkSecurityGroup.id
      7.  RouteTable -> Subnet (routes)            subnets[] on route table
      8.  PrivateEndpoint -> Subnet (connected_to_subnet) subnet.id
      9.  FunctionApp -> StorageAccount (uses_storage) serverFarmId / storageAccountConnectionStrings
      10. AppService -> AppServicePlan (hosted_on) serverFarmId
      11. AppInsights -> LogAnalytics (sends_logs_to) WorkspaceResourceId
    """
    rels: list[dict] = []
    seen: set[tuple] = set()

    for resource in resources:
        if not isinstance(resource, dict):
            continue

        rtype = normalize_resource_type(resource.get("type"))
        rname = resource.get("name") or ""
        props = resource.get("properties") or {}

        # ----------------------------------------------------------------
        # Rule 1 – VM -> NIC  (uses_nic)
        # ----------------------------------------------------------------
        if rtype == "microsoft.compute/virtualmachines":
            network_profile = props.get("networkProfile") or {}
            for nic_ref in network_profile.get("networkInterfaces") or []:
                nic_id = (nic_ref.get("id") or "") if isinstance(nic_ref, dict) else ""
                if _is_azure_resource_id(nic_id):
                    nic_name = _get_resource_name(resource_lookup, nic_id)
                    _add_topology_rel(
                        rels, seen, rname, nic_name, "uses_nic",
                        source_type="microsoft.compute/virtualmachines",
                        target_type="microsoft.network/networkinterfaces",
                    )

        # ----------------------------------------------------------------
        # Rule 2 – VM -> Disk  (uses_disk)
        # ----------------------------------------------------------------
        if rtype == "microsoft.compute/virtualmachines":
            storage_profile = props.get("storageProfile") or {}
            os_disk = storage_profile.get("osDisk") or {}
            managed = os_disk.get("managedDisk") or {}
            disk_id = managed.get("id") or ""
            if _is_azure_resource_id(disk_id):
                disk_name = _get_resource_name(resource_lookup, disk_id)
                _add_topology_rel(
                    rels, seen, rname, disk_name, "uses_disk",
                    source_type="microsoft.compute/virtualmachines",
                    target_type="microsoft.compute/disks",
                )
            for data_disk in storage_profile.get("dataDisks") or []:
                dm = (data_disk.get("managedDisk") or {}) if isinstance(data_disk, dict) else {}
                ddisk_id = dm.get("id") or ""
                if _is_azure_resource_id(ddisk_id):
                    ddisk_name = _get_resource_name(resource_lookup, ddisk_id)
                    _add_topology_rel(
                        rels, seen, rname, ddisk_name, "uses_disk",
                        source_type="microsoft.compute/virtualmachines",
                        target_type="microsoft.compute/disks",
                    )

        # ----------------------------------------------------------------
        # Rules 3, 5 – NIC -> Subnet / NIC -> PublicIP
        # ----------------------------------------------------------------
        if rtype == "microsoft.network/networkinterfaces":
            for ip_cfg in props.get("ipConfigurations") or []:
                ip_props = (ip_cfg.get("properties") or {}) if isinstance(ip_cfg, dict) else {}

                # Rule 3 – NIC -> Subnet
                subnet_ref = ip_props.get("subnet") or {}
                subnet_id = (subnet_ref.get("id") or "") if isinstance(subnet_ref, dict) else ""
                if _is_azure_resource_id(subnet_id):
                    subnet_entry = resource_lookup.get(subnet_id.lower())
                    subnet_name = (
                        subnet_entry.get("name") if subnet_entry
                        else (extract_resource_id_components(subnet_id) or {}).get("resource_name") or ""
                    )
                    _add_topology_rel(
                        rels, seen, rname, subnet_name, "connected_to_subnet",
                        source_type="microsoft.network/networkinterfaces",
                        target_type="microsoft.network/virtualnetworks/subnets",
                    )
                    # Rule 4 – Subnet -> VNet  (belongs_to_vnet)
                    if subnet_entry:
                        vnet_name = subnet_entry.get("_vnet_name") or ""
                        if not vnet_name:
                            parsed_sub = extract_resource_id_components(subnet_id)
                            pairs = (parsed_sub or {}).get("pairs", [])
                            if len(pairs) >= 2:
                                vnet_name = pairs[-2]["name"]
                        if vnet_name:
                            _add_topology_rel(
                                rels, seen, subnet_name, vnet_name, "belongs_to_vnet",
                                source_type="microsoft.network/virtualnetworks/subnets",
                                target_type="microsoft.network/virtualnetworks",
                            )

                # Rule 5 – NIC -> PublicIP
                pip_ref = ip_props.get("publicIPAddress") or {}
                pip_id = (pip_ref.get("id") or "") if isinstance(pip_ref, dict) else ""
                if _is_azure_resource_id(pip_id):
                    pip_name = _get_resource_name(resource_lookup, pip_id)
                    _add_topology_rel(
                        rels, seen, rname, pip_name, "uses_public_ip",
                        source_type="microsoft.network/networkinterfaces",
                        target_type="microsoft.network/publicipaddresses",
                    )

            # Rule 6 – NIC -> NSG  (protected_by)
            nsg_ref = props.get("networkSecurityGroup") or {}
            nsg_id = (nsg_ref.get("id") or "") if isinstance(nsg_ref, dict) else ""
            if _is_azure_resource_id(nsg_id):
                nsg_name = _get_resource_name(resource_lookup, nsg_id)
                _add_topology_rel(
                    rels, seen, rname, nsg_name, "protected_by",
                    source_type="microsoft.network/networkinterfaces",
                    target_type="microsoft.network/networksecuritygroups",
                )

        # ----------------------------------------------------------------
        # Rule 7 – RouteTable -> Subnet  (routes)
        # ----------------------------------------------------------------
        if rtype == "microsoft.network/routetables":
            for subnet_ref in props.get("subnets") or []:
                subnet_id = (subnet_ref.get("id") or "") if isinstance(subnet_ref, dict) else ""
                if _is_azure_resource_id(subnet_id):
                    subnet_name = _get_resource_name(resource_lookup, subnet_id)
                    _add_topology_rel(
                        rels, seen, rname, subnet_name, "routes",
                        source_type="microsoft.network/routetables",
                        target_type="microsoft.network/virtualnetworks/subnets",
                    )

        # ----------------------------------------------------------------
        # Rule 8 – PrivateEndpoint -> Subnet  (connected_to_subnet)
        # ----------------------------------------------------------------
        if rtype == "microsoft.network/privateendpoints":
            for nic_cfg in props.get("networkInterfaces") or []:
                pass  # NICs are linked via NIC Rule 3 above
            subnet_ref = props.get("subnet") or {}
            subnet_id = (subnet_ref.get("id") or "") if isinstance(subnet_ref, dict) else ""
            if _is_azure_resource_id(subnet_id):
                subnet_name = _get_resource_name(resource_lookup, subnet_id)
                _add_topology_rel(
                    rels, seen, rname, subnet_name, "connected_to_subnet",
                    source_type="microsoft.network/privateendpoints",
                    target_type="microsoft.network/virtualnetworks/subnets",
                )

        # ----------------------------------------------------------------
        # Rule 9 – FunctionApp -> StorageAccount  (uses_storage)
        # ----------------------------------------------------------------
        if rtype == "microsoft.web/sites" and rname in function_apps:
            farm_id = props.get("serverFarmId") or ""
            # Storage connection strings or explicit storage account binding
            site_config = props.get("siteConfig") or {}
            storage_key = ""
            for conn_str in site_config.get("connectionStrings") or []:
                if not isinstance(conn_str, dict):
                    continue
                conn_type = str(conn_str.get("type") or "").lower()
                if "storage" in conn_type or "azureblob" in conn_type:
                    storage_key = conn_str.get("name") or ""
                    break
            # Fallback: match by resource-group storage accounts name prefix heuristic
            # (exact reference in storageAccountConnectionStrings is absent in most cases;
            #  the property-scan approach will catch it when present)
            for app_setting in site_config.get("appSettings") or []:
                if not isinstance(app_setting, dict):
                    continue
                val = app_setting.get("value") or ""
                if _is_azure_resource_id(val):
                    referenced = resource_lookup.get(val.lower())
                    if referenced:
                        ref_type = normalize_resource_type(referenced.get("type"))
                        if ref_type == "microsoft.storage/storageaccounts":
                            _add_topology_rel(
                                rels, seen, rname, referenced.get("name") or "", "uses_storage",
                                source_type="microsoft.web/sites",
                                target_type="microsoft.storage/storageaccounts",
                            )

        # ----------------------------------------------------------------
        # Rule 10 – AppService / LogicApp -> AppServicePlan  (hosted_on)
        # ----------------------------------------------------------------
        if rtype == "microsoft.web/sites":
            farm_id = props.get("serverFarmId") or ""
            if _is_azure_resource_id(farm_id):
                plan_name = _get_resource_name(resource_lookup, farm_id)
                _add_topology_rel(
                    rels, seen, rname, plan_name, "hosted_on",
                    source_type="microsoft.web/sites",
                    target_type="microsoft.web/serverfarms",
                )

        # ----------------------------------------------------------------
        # Rule 11 – ApplicationInsights -> LogAnalyticsWorkspace (sends_logs_to)
        # ----------------------------------------------------------------
        if rtype == "microsoft.insights/components":
            workspace_id = props.get("WorkspaceResourceId") or props.get("workspaceResourceId") or ""
            if _is_azure_resource_id(workspace_id):
                ws_name = _get_resource_name(resource_lookup, workspace_id)
                _add_topology_rel(
                    rels, seen, rname, ws_name, "sends_logs_to",
                    source_type="microsoft.insights/components",
                    target_type="microsoft.operationalinsights/workspaces",
                )

    return rels


def build_relationship_mapping(input_json: dict) -> dict:
    """Build hierarchy: subscription -> resource group -> categorized resources.
    
    Handles both input formats:
    1. Direct format: { "data": { "<sub_id>": { "resource_groups": {...} } } }
    2. Wrapped format: { "data": { "status": "success", "data": { "<sub_id>": {...} } } }
    """
    output = {"subscriptions": {}}
    
    data = input_json.get("data", {})
    
    # If data.data exists and is a dict, and data appears to be the full 
    # step 1 response (has status, subscriptions_requested, etc.), unwrap it
    if isinstance(data, dict) and "data" in data and isinstance(data.get("data"), dict):
        if "status" in data or "subscriptions_requested" in data:
            # This is the wrapped format from step 1
            data = data.get("data", {})

    for sub_id, sub_data in data.items():
        # Skip non-dict values (e.g., if someone passes metadata keys)
        if not isinstance(sub_data, dict):
            continue
            
        sub_key = sub_id or "unknown-subscription"
        if sub_key not in output["subscriptions"]:
            output["subscriptions"][sub_key] = {"resource_groups": {}}

        resource_groups = sub_data.get("resource_groups", {})

        for rg_name, rg_data in resource_groups.items():
            rg_key = (rg_name or "no-resource-group").lower()
            resources = rg_data.get("resources", [])

            categories = _build_categories_for_resources(resources)

            # PHASE 2 – hierarchy relationships (parent/child from resource IDs)
            relationships: list[dict] = []
            for resource in resources:
                relationship = build_relationship_entry(resource)
                if relationship:
                    relationships.append(relationship)

            compacted_relationships = compact_relationships(relationships)
            hierarchy = build_hierarchy_map(compacted_relationships)

            # PHASE 2.5 – topology relationships (from resource properties)
            function_apps = set(
                categories.get("app_services", {}).get("function_apps", [])
            )
            web_apps = set(
                categories.get("app_services", {}).get("web_apps", [])
            )
            resource_lookup = build_resource_lookup(resources)
            topology_relationships = extract_topology_relationships(
                resources, resource_lookup, function_apps, web_apps
            )

            logging.info(
                "Mapped relationships for subscription=%s resource_group=%s "
                "raw_relationships=%s compacted_relationships=%s topology_relationships=%s",
                sub_key,
                rg_key,
                len(relationships),
                len(compacted_relationships),
                len(topology_relationships),
            )

            total_resources = 0
            for value in categories.values():
                if isinstance(value, list):
                    total_resources += len(value)
                elif isinstance(value, dict):
                    for child_val in value.values():
                        if isinstance(child_val, list):
                            total_resources += len(child_val)
                        elif isinstance(child_val, dict):
                            total_resources += len(child_val)

            output["subscriptions"][sub_key]["resource_groups"][rg_key] = {
                "categories": categories,
                "relationships": compacted_relationships,
                "hierarchy": hierarchy,
                "topology_relationships": topology_relationships,
                "total_resources": total_resources,
            }

        sub_resource_groups = output["subscriptions"][sub_key]["resource_groups"]
        output["subscriptions"][sub_key]["total_resource_groups"] = len(sub_resource_groups)

    return output


def main(req: func.HttpRequest) -> func.HttpResponse:
    """Azure Function endpoint for relationship mapping."""
    try:
        body = req.get_json()
        if not isinstance(body, dict):
            return func.HttpResponse(
                json.dumps({
                    "status": "error",
                    "error_type": "InvalidInput",
                    "message": "Request body must be a JSON object"
                }),
                status_code=400,
                mimetype="application/json",
            )

        if "data" not in body or not isinstance(body.get("data"), dict):
            return func.HttpResponse(
                json.dumps({
                    "status": "error",
                    "error_type": "MissingInput",
                    "message": "Request body must contain a 'data' object"
                }),
                status_code=400,
                mimetype="application/json",
            )

        result = build_relationship_mapping(body)
        response_payload = {
            "status": "success",
            "total_subscriptions": len(result.get("subscriptions", {})),
            "data": result,
        }

        return func.HttpResponse(
            json.dumps(response_payload, indent=2, default=str),
            status_code=200,
            mimetype="application/json",
        )

    except json.JSONDecodeError as exc:
        return func.HttpResponse(
            json.dumps({
                "status": "error",
                "error_type": "JSONDecodeError",
                "message": f"Invalid JSON format: {str(exc)}"
            }),
            status_code=400,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.error(traceback.format_exc())
        return func.HttpResponse(
            json.dumps({
                "status": "error",
                "error_type": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc(),
            }),
            status_code=500,
            mimetype="application/json",
        )