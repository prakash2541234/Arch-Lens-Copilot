import azure.functions as func

from costAnalysis import main as cost_analysis_main
from KVCreate import main as kv_create_main
from SPCreate import main as sp_create_main
from StorageCreate import main as storage_create_main
from cost_analysis_v2 import main as cost_analysis_v2_main

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

@app.function_name(name="CostAnalysisFunction")
@app.route(route="cost_analysis", methods=["POST"])
def cost_analysis(req: func.HttpRequest) -> func.HttpResponse:
    return cost_analysis_main(req)

@app.function_name(name="kv_create")
@app.route(route="kv_create")
def kv_create(req: func.HttpRequest) -> func.HttpResponse:
    return kv_create_main(req)

@app.function_name(name="sp_create")
@app.route(route="sp_create")
def sp_create(req: func.HttpRequest) -> func.HttpResponse:
    return sp_create_main(req)


@app.function_name(name="storage_create")
@app.route(route="storage_create")
def storage_create(req: func.HttpRequest) -> func.HttpResponse:
    return storage_create_main(req)

@app.function_name(name="CostAnalysisV2Function")
@app.route(route="cost_analysis_v2", methods=["POST"])
def cost_analysis_v2(req: func.HttpRequest) -> func.HttpResponse:
    return cost_analysis_v2_main(req)