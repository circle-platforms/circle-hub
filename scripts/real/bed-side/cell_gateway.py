"""Add a private submission route while retaining the original gateway protocol."""

from __future__ import annotations

import copy
import importlib
import json
import shutil
import sys
import types
from pathlib import Path

from cell_runtime import COMPONENT_ROOT, copy_function, read_contract

SUBMIT_TOOL = 'case_submit_cell'


class Framework:
    def __init__(self, original, contract_path):
        self.original = original
        self.contract_path = Path(contract_path).resolve()

    def __getattr__(self, name):
        return getattr(self.original, name)

    def stage_case(self, cfg, module, autoid, data, expected_sha256, task_id=None):
        staged = self.original.stage_case(
            cfg, module, autoid, data, expected_sha256, task_id)
        directory = Path(staged['staging_dir'])
        for name, source in (
            ('test_xlsx.py', COMPONENT_ROOT / 'test_xlsx.py'),
            ('excel_contract.json', self.contract_path),
        ):
            target = directory / name
            if target.exists() or target.is_symlink():
                target.unlink()
            shutil.copyfile(source, target)
        settings = {
            'component_root': str(COMPONENT_ROOT),
            'framework_root': str(cfg.apv_src),
        }
        (directory / 'cell-runtime.json').write_text(
            json.dumps(settings, ensure_ascii=False), encoding='utf-8')
        return staged


def private_gateway(original, framework, gates, contract_path):
    document = read_contract(contract_path, original.cfg.apv_src)
    resolver = gates.resolve_execution_sheet
    resolver_globals = dict(resolver.__globals__)
    resolver_globals['PINNED_CONTRACT_SHA256'] = document['contract_sha256']
    private_resolver = copy_function(resolver, resolver_globals)
    freeze_globals = dict(gates.freeze.__globals__)
    freeze_globals['resolve_execution_sheet'] = private_resolver
    private_gates = types.SimpleNamespace(**vars(gates))
    private_gates.freeze = copy_function(gates.freeze, freeze_globals)
    submit = original.case_submit.__func__
    submit_globals = dict(submit.__globals__)
    submit_globals['framework'] = Framework(framework, contract_path)
    submit_globals['gates'] = private_gates
    private = copy.copy(original)
    private.handlers = dict(original.handlers)
    private.handlers['case_submit'] = types.MethodType(
        copy_function(submit, submit_globals), private)
    return private


class Gateway:
    def __init__(self, original, private):
        self.original = original
        self.private = private

    def __getattr__(self, name):
        return getattr(self.original, name)

    def call(self, caller, name, args):
        if name == SUBMIT_TOOL:
            return self.private.call(caller, 'case_submit', args)
        return self.original.call(caller, name, args)


def service_namespace(service):
    namespace = dict(vars(service))
    spec = copy.deepcopy(next(item for item in service.TOOL_SPECS
                              if item['name'] == 'case_submit'))
    spec['name'] = SUBMIT_TOOL
    spec['description'] = 'Submit a workbook through the isolated table-cell runner'
    namespace['TOOL_SPECS'] = list(service.TOOL_SPECS) + [spec]
    for name, value in vars(service).items():
        if isinstance(value, types.FunctionType) and value.__module__ == service.__name__:
            namespace[name] = copy_function(value, namespace)
    return namespace


def serve(gateway_root, config_path, contract_path):
    sys.path.insert(0, str(Path(gateway_root).resolve()))
    tools = importlib.import_module('gateway.tools')
    framework = importlib.import_module('gateway.framework')
    gates = importlib.import_module('gateway.gates')
    service = importlib.import_module('gateway.service')
    original = tools.load_gateway(Path(config_path))
    private = private_gateway(original, framework, gates, contract_path)
    server = service_namespace(service)['build_server'](Gateway(original, private))
    try:
        server.serve_forever()
    finally:
        server.server_close()
