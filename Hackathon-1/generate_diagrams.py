import json
import logging
import os
import shutil
import subprocess
import traceback
from pathlib import Path

import azure.functions as func


def ensure_mmdc_config(max_edges: int = 5000, max_text_size: int = 2000000):
    config_path = Path.cwd() / ".mermaid-cli-config.json"
    config = {
        "maxEdges": max_edges,
        "maxTextSize": max_text_size,
    }
    config_path.write_text(json.dumps(config), encoding="utf-8")
    return config_path


def sanitize_label(value: str):
    return (
        value.replace("\\", "\\\\")
        .replace('"', "'")
        .replace("\n", " ")
        .replace("[", "(")
        .replace("]", ")")
    )


def build_mermaid(relationships, direction="TD", include_self=False):
    lines = [f"graph {direction}"]
    path_separator = "::"
    max_hierarchy_depth = 20

    cleaned = []
    for rel in relationships:
        source = str(rel.get("source", "")).replace('"', "").strip()
        target = str(rel.get("target", "")).replace('"', "").strip()
        relation = str(rel.get("relationship", "related_to")).replace('"', "").strip() or "related_to"
        if not source or not target:
            continue
        if not include_self and source == target:
            continue
        cleaned.append((source, target, relation))

    contains = [item for item in cleaned if item[2].lower() == "contains"]
    non_contains = [item for item in cleaned if item[2].lower() != "contains"]

    node_ids = {}
    node_labels = {}
    label_to_paths = {}
    edge_seen = set()
    edges = []

    def ensure_node(path_key: str, label: str):
        if path_key not in node_ids:
            node_ids[path_key] = f"N{len(node_ids) + 1}"
            node_labels[path_key] = label
            label_key = label.lower()
            label_to_paths.setdefault(label_key, [])
            if path_key not in label_to_paths[label_key]:
                label_to_paths[label_key].append(path_key)
        return node_ids[path_key]

    def edge(source_path: str, target_path: str, relation: str):
        relation_label = sanitize_label(relation)
        edge_key = (source_path, target_path, relation_label)
        if edge_key in edge_seen:
            return
        edge_seen.add(edge_key)
        edges.append((source_path, target_path, relation_label))

    def path_root(path_key: str):
        return path_key.split(path_separator)[0]

    contains_by_source = {}
    contains_sources = set()
    contains_targets = set()

    for source, target, relation in contains:
        contains_by_source.setdefault(source, []).append((target, relation))
        contains_sources.add(source)
        contains_targets.add(target)

    root_labels = sorted(contains_sources - contains_targets) or sorted(contains_sources)
    stack = []
    expanded = set()

    for root_label in root_labels:
        root_path = root_label
        ensure_node(root_path, root_label)
        stack.append((root_label, root_path, 0))

    while stack:
        source_label, source_path, depth = stack.pop()
        expand_key = (source_label.lower(), source_path)
        if expand_key in expanded:
            continue
        expanded.add(expand_key)

        for target_label, relation in contains_by_source.get(source_label, []):
            if not include_self and source_label == target_label:
                continue
            target_path = f"{source_path}{path_separator}{target_label}"
            ensure_node(target_path, target_label)
            edge(source_path, target_path, relation)

            if depth < max_hierarchy_depth and target_label in contains_by_source:
                stack.append((target_label, target_path, depth + 1))

    standalone_nodes = {}

    def ensure_standalone(label: str):
        label_key = label.lower()
        if label_key not in standalone_nodes:
            standalone_path = f"standalone{path_separator}{label}"
            standalone_nodes[label_key] = standalone_path
            ensure_node(standalone_path, label)
        return standalone_nodes[label_key]

    for source, target, relation in non_contains:
        source_paths = label_to_paths.get(source.lower(), [])
        target_paths = label_to_paths.get(target.lower(), [])

        if not source_paths:
            source_paths = [ensure_standalone(source)]
        if not target_paths:
            target_paths = [ensure_standalone(target)]

        selected_pair = None
        for source_path in source_paths:
            for target_path in target_paths:
                if path_root(source_path) == path_root(target_path):
                    selected_pair = (source_path, target_path)
                    break
            if selected_pair:
                break

        if not selected_pair:
            selected_pair = (source_paths[0], target_paths[0])

        edge(selected_pair[0], selected_pair[1], relation)

    for path_key, node_id in node_ids.items():
        label = sanitize_label(node_labels[path_key])
        lines.append(f'  {node_id}["{label}"]')

    for source_path, target_path, relation_label in edges:
        source_id = node_ids[source_path]
        target_id = node_ids[target_path]
        lines.append(f'  {source_id} -->|{relation_label}| {target_id}')

    return "\n".join(lines) + "\n"


def split_relationships(relationships):
    hierarchy = []
    topology = []

    for rel in relationships:
        relation = str(rel.get("relationship", "")).strip().lower()
        if relation == "contains":
            hierarchy.append(rel)
        else:
            topology.append(rel)

    return hierarchy, topology


def run_mmdc(
    input_file: Path,
    output_file: Path,
    background: str,
    width: int,
    height: int,
    scale: float,
):
    config_path = ensure_mmdc_config()
    local_mmdc = Path.cwd() / "node_modules" / ".bin" / ("mmdc.cmd" if os.name == "nt" else "mmdc")
    if local_mmdc.exists():
        command = [
            str(local_mmdc),
            "-i",
            str(input_file),
            "-o",
            str(output_file),
            "-b",
            background,
            "-w",
            str(width),
            "-H",
            str(height),
            "-s",
            str(scale),
            "-c",
            str(config_path),
        ]
    else:
        npx_executable = "npx.cmd" if os.name == "nt" else "npx"
        command = [
            npx_executable,
            "-y",
            "@mermaid-js/mermaid-cli",
            "-i",
            str(input_file),
            "-o",
            str(output_file),
            "-b",
            background,
            "-w",
            str(width),
            "-H",
            str(height),
            "-s",
            str(scale),
            "-c",
            str(config_path),
        ]

    env = os.environ.copy()
    env["NPM_CONFIG_REGISTRY"] = "https://registry.npmjs.org/"
    result = subprocess.run(command, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        details = stderr or stdout or f"Mermaid CLI failed with exit code {result.returncode}"
        raise RuntimeError(f"Failed to export {input_file.name} -> {output_file.name}: {details}")


def write_html_preview(mmd_file: Path):
        mermaid_content = mmd_file.read_text(encoding="utf-8")
        safe_content = mermaid_content.replace("</", "<\\/")
        html = f"""<!doctype html>
<html>
    <head>
        <meta charset=\"utf-8\" />
        <title>{mmd_file.stem}</title>
        <script type=\"module\">
            import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
            mermaid.initialize({{ startOnLoad: true, theme: 'default' }});
        </script>
        <style>
            body {{ margin: 0; padding: 16px; font-family: Arial, sans-serif; }}
            .mermaid {{ overflow: auto; }}
        </style>
    </head>
    <body>
        <div class=\"mermaid\">{safe_content}</div>
    </body>
</html>
"""
        html_path = mmd_file.with_suffix(".html")
        html_path.write_text(html, encoding="utf-8")
        return html_path


def generate_mmd_files(input_path: Path, mode: str, direction: str, include_self: bool):
    with input_path.open("r", encoding="utf-8") as file:
        data = json.load(file)

    relationships = data.get("relationships", [])
    outputs = []

    if mode == "all":
        content = build_mermaid(
            relationships=relationships,
            direction=direction,
            include_self=include_self,
        )
        output = input_path.with_name("architecture.mmd")
        output.write_text(content, encoding="utf-8")
        outputs.append(output)
        return outputs

    hierarchy, topology = split_relationships(relationships)

    hierarchy_content = build_mermaid(
        relationships=hierarchy,
        direction=direction,
        include_self=include_self,
    )
    topology_content = build_mermaid(
        relationships=topology,
        direction=direction,
        include_self=include_self,
    )

    hierarchy_output = input_path.with_name("architecture_hierarchy.mmd")
    topology_output = input_path.with_name("architecture_topology.mmd")

    hierarchy_output.write_text(hierarchy_content, encoding="utf-8")
    topology_output.write_text(topology_content, encoding="utf-8")

    outputs.extend([hierarchy_output, topology_output])
    return outputs


INPUT_FILE = os.path.join(os.path.dirname(__file__), "architecture.json")


def extract_input_data(body: dict) -> dict:
    """Normalize request payload into a dict that contains relationships.

    Supported shapes:
    - { "relationships": [...] }
    - { "data": { "relationships": [...] } }
    - { "dtata": { "relationships": [...] } }  # typo-tolerant for Logic App mapping
    - { "data": { "status": "success", "data": { "relationships": [...] } } }
    - { "dtata": { "status": "success", "data": { "relationships": [...] } } }
    """
    if not isinstance(body, dict):
        return {}

    if "relationships" in body:
        return body

    for wrapper_key in ("data", "dtata"):
        wrapped = body.get(wrapper_key)
        if not isinstance(wrapped, dict):
            continue

        if "relationships" in wrapped:
            return wrapped

        nested = wrapped.get("data")
        if isinstance(nested, dict) and "relationships" in nested:
            return nested

    return {}


def main(req: func.HttpRequest) -> func.HttpResponse:
    """Azure Function endpoint for generating Mermaid diagrams.

    Accepts the output of step_3 (architecture_diagram) directly in the request
    body so Logic App can chain the steps without any manual intervention.

    Optional body parameters:
        mode         : "all" | "split"  (default: "split")
        direction    : "TD" | "LR" | "RL" | "BT"  (default: "TD")
        include_self : bool  (default: false)

    Input resolution order:
        1. Body contains a top-level "relationships" list  → use directly
        2. Body contains { "data": { "relationships": [...] } }  → unwrap
        3. No relationships in body  → fall back to architecture.json on disk

    Returns JSON:
        {
          "status": "success",
          "mode": "split",
          "diagrams": {
            "architecture_hierarchy": "graph TD\n ...",
            "architecture_topology":  "graph TD\n ..."
          }
        }
    """
    logging.info("generate_diagrams: diagram generation triggered.")

    try:
        try:
            body = req.get_json()
        except Exception:
            body = {}

        if not isinstance(body, dict):
            body = {}

        # Optional generation parameters
        mode = body.get("mode", "split")
        if mode not in ("all", "split"):
            mode = "split"

        direction = body.get("direction", "TD")
        if direction not in ("TD", "LR", "RL", "BT"):
            direction = "TD"

        include_self = bool(body.get("include_self", False))

        # Resolve input data
        input_data = extract_input_data(body)
        if not input_data:
            if not os.path.exists(INPUT_FILE):
                return func.HttpResponse(
                    json.dumps({
                        "status": "error",
                        "error_type": "MissingInput",
                        "message": (
                            "No 'relationships' found in request body (including wrapped 'data'/'dtata') and "
                            f"fallback file not found: {INPUT_FILE}"
                        ),
                    }),
                    status_code=404,
                    mimetype="application/json",
                )
            with open(INPUT_FILE, "r", encoding="utf-8") as f:
                input_data = json.load(f)

        relationships = input_data.get("relationships", [])
        if not relationships:
            return func.HttpResponse(
                json.dumps({
                    "status": "error",
                    "error_type": "MissingInput",
                    "message": "No relationships found in input data.",
                }),
                status_code=400,
                mimetype="application/json",
            )

        # Build diagrams
        diagrams = {}
        if mode == "all":
            diagrams["architecture"] = build_mermaid(
                relationships=relationships,
                direction=direction,
                include_self=include_self,
            )
        else:
            hierarchy, topology = split_relationships(relationships)
            diagrams["architecture_hierarchy"] = build_mermaid(
                relationships=hierarchy,
                direction=direction,
                include_self=include_self,
            )
            diagrams["architecture_topology"] = build_mermaid(
                relationships=topology,
                direction=direction,
                include_self=include_self,
            )

        logging.info(
            "generate_diagrams: produced %d diagram(s) in '%s' mode.", len(diagrams), mode
        )

        return func.HttpResponse(
            json.dumps(
                {
                    "status": "success",
                    "mode": mode,
                    "direction": direction,
                    "include_self": include_self,
                    "diagrams": diagrams,
                },
                indent=2,
                ensure_ascii=False,
            ),
            status_code=200,
            mimetype="application/json",
        )

    except json.JSONDecodeError as exc:
        return func.HttpResponse(
            json.dumps({
                "status": "error",
                "error_type": "JSONDecodeError",
                "message": f"Invalid JSON format: {str(exc)}",
            }),
            status_code=400,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.error("generate_diagrams error: %s\n%s", exc, traceback.format_exc())
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