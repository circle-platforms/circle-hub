"""Add a private submission route while retaining the original gateway protocol."""

from __future__ import annotations

import copy
import importlib
import json
import shutil
import sys
import types
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

COMPONENT_ROOT = Path(__file__).resolve().parent

SUBMIT_TOOL = 'case_submit_cell'


class Framework:
    def __init__(self, original, contract_path, audit):
        self.original = original
        self.contract_path = Path(contract_path).resolve()
        self.audit = audit

    def __getattr__(self, name):
        return getattr(self.original, name)

    def stage_case(self, cfg, module, autoid, data, expected_sha256, task_id=None):
        if self.audit('cell_route_task', tool=SUBMIT_TOOL, task_id=task_id) is False:
            raise ValueError('取值提交的任务路线审计未能保存；未启动任务')
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
            'submission_tool': SUBMIT_TOOL,
        }
        (directory / 'cell-runtime.json').write_text(
            json.dumps(settings, ensure_ascii=False), encoding='utf-8')
        return staged


def private_gateway(original, framework, gates, contract_path):
    from cell_runtime import copy_function, read_contract
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
    submit_globals['framework'] = Framework(framework, contract_path, original.audit)
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
            if self.original.audit('cell_route_requested', tool=SUBMIT_TOOL,
                                   subject=caller.subject) is False:
                return {'ok': False, 'error': '取值提交的路线审计未能保存；未提交',
                        'stage': 'admission', 'reached_device': False}
            result = self.private.call(caller, 'case_submit', args)
            self.original.audit('cell_route_result', tool=SUBMIT_TOOL,
                                subject=caller.subject,
                                task_id=result.get('task_id'),
                                response_ok=result.get('ok'), replayed=result.get('replayed'))
            return result
        return self.original.call(caller, name, args)


def service_namespace(service):
    from cell_runtime import copy_function
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


def component_state(mode, reason):
    value = {'schema': 'value-pick-state@1', 'mode': mode, 'reason': reason,
             'recorded_at': datetime.now(timezone.utc).isoformat(), 'pid': os.getpid()}
    directory = COMPONENT_ROOT / 'runtime'
    directory.mkdir(mode=0o700, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.status-', dir=directory)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf8') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / 'status.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return value


def serve(gateway_root, config_path, contract_path):
    sys.path.insert(0, str(Path(gateway_root).resolve()))
    tools = importlib.import_module('gateway.tools')
    framework = importlib.import_module('gateway.framework')
    gates = importlib.import_module('gateway.gates')
    service = importlib.import_module('gateway.service')
    config = importlib.import_module('gateway.config')
    state = importlib.import_module('gateway.state')
    try:
        original = tools.load_gateway(Path(config_path))
    except config.ConfigError as error:
        print('配置错误：%s' % error, file=sys.stderr)
        return 2
    except state.JournalError as error:
        print('请求日志错误：%s' % error, file=sys.stderr)
        return 2
    original.flush_request_audit()
    mode, reason = 'cell', None
    try:
        private = private_gateway(original, framework, gates, contract_path)
        namespace = service_namespace(service)
        active = Gateway(original, private)
        if original.audit('cell_component_state', mode=mode, reason=reason) is False:
            raise OSError('组件状态审计未能保存')
        component_state(mode, reason)
    except Exception as error:
        mode = 'original'
        reason = '%s: %s' % (type(error).__name__, error)
        namespace, active = vars(service), original
        try:
            component_state(mode, reason)
        except Exception as state_error:
            reason += '; 状态文件写入失败：%s' % type(state_error).__name__
    if mode == 'original':
        try:
            if original.audit('cell_component_state', mode=mode, reason=reason) is False:
                raise OSError('组件状态审计未能保存')
        except Exception as audit_error:
            reason += '; 组件状态审计不可用：' + type(audit_error).__name__
        print('取值组件未启用，仅提供原工具：' + json.dumps(reason, ensure_ascii=False), file=sys.stderr)
    server = namespace['build_server'](active)
    cfg = original.cfg
    scheme = 'https' if cfg.tls_cert else 'http'
    print('cexg 监听 %s://%s:%s/mcp' % (scheme, cfg.host, cfg.port), file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
